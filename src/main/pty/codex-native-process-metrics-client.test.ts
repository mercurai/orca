import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { inspect } from 'node:util'
import type { PipedChildProcess } from '@orca/process-host/process-spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnSampler } = vi.hoisted(() => ({ spawnSampler: vi.fn() }))

vi.mock('@orca/process-host', () => ({ spawnProcess: spawnSampler }))

import {
  MAX_METRICS_REQUEST_TIMEOUT_MS,
  METRICS_CLOSE_TIMEOUT_MS,
  ProcessMetricsClient
} from '../../../tests/tools/windows-codex-native-runtime/process-metrics-client'
import { metricResponse } from '../../../tests/tools/windows-codex-native-runtime/process-metrics-protocol'
import {
  ProcessMetricsIncompleteError,
  sampleFailure
} from '../../../tests/tools/windows-codex-native-runtime/process-metric-failure'

class FakeSamplerProcess extends EventEmitter {
  readonly requests: string[] = []
  readonly stdin = new Writable({
    write: (chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) => {
      this.requests.push(chunk.toString())
      callback()
    }
  })
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  closeOnKill = true
  readonly kill = vi.fn(() => {
    this.signalCode = 'SIGTERM'
    if (this.closeOnKill) {
      this.emit('close', null, 'SIGTERM')
    }
    return true
  })

  closeNormally(): void {
    this.exitCode = 0
    this.emit('close', 0, null)
  }

  asChild(): PipedChildProcess {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fake supplies this client's required process members.
    return this as unknown as PipedChildProcess
  }
}

describe('ProcessMetricsClient request lifecycle', () => {
  let child: FakeSamplerProcess
  let client: ProcessMetricsClient

  beforeEach(() => {
    vi.useFakeTimers()
    child = new FakeSamplerProcess()
    spawnSampler.mockReset().mockReturnValue(child.asChild())
    client = new ProcessMetricsClient('python.exe', 'process-metrics.py')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fails queued and future operations when any RPC reaches its deadline', async () => {
    const identity = { pid: 1234, creationTimeMs: 12345 }
    const operations = [
      client.sample([identity]),
      client.createJob(identity),
      client.listJobProcessIds(42),
      client.terminateJob(42),
      client.releaseJob(42)
    ]
    const settled = Promise.allSettled(operations)
    expect(child.requests).toHaveLength(operations.length)

    await vi.advanceTimersByTimeAsync(MAX_METRICS_REQUEST_TIMEOUT_MS)

    const results = await settled
    expect(results.every((result) => result.status === 'rejected')).toBe(true)
    expect(
      results.every(
        (result) => result.status === 'rejected' && /timed out/.test(result.reason.message)
      )
    ).toBe(true)
    expect(child.kill).toHaveBeenCalledOnce()
    expect(client.isUnavailable).toBe(true)

    child.stdout.write(
      `${JSON.stringify({
        ok: true,
        processes: [
          {
            ...identity,
            imagePath: 'C:\\Windows\\System32\\cmd.exe',
            privateBytes: 1,
            workingSetBytes: 1,
            handleCount: 1,
            kernel100ns: 1,
            user100ns: 1
          }
        ]
      })}\n`
    )
    await expect(client.sample([identity])).rejects.toThrow(/timed out/)
    expect(child.requests).toHaveLength(operations.length)
    await expect(client.waitForExit()).resolves.toBeUndefined()
  })

  it('rejects pending work on helper exit and confirms closure for any exit code', async () => {
    const identity = { pid: 1234, creationTimeMs: 12345 }
    const pending = Promise.allSettled([client.sample([identity]), client.listJobProcessIds(42)])

    child.exitCode = 1
    child.emit('close', 1, null)

    const results = await pending
    expect(results.every((result) => result.status === 'rejected')).toBe(true)
    expect(client.isUnavailable).toBe(true)
    await expect(client.waitForExit()).resolves.toBeUndefined()
    expect(child.kill).not.toHaveBeenCalled()
    await expect(client.sample([identity])).rejects.toThrow(/sampler/)
  })

  it('bounds EOF shutdown and kills the helper if it does not close', async () => {
    child.closeOnKill = false
    const closing = client.close()
    const closeRejection = expect(closing).rejects.toThrow(/close timed out/)

    await vi.advanceTimersByTimeAsync(METRICS_CLOSE_TIMEOUT_MS)

    await closeRejection
    expect(child.kill).toHaveBeenCalledOnce()
    expect(client.isUnavailable).toBe(true)
    let exitObserved = false
    const waitingForExit = client.waitForExit().then(() => {
      exitObserved = true
    })
    await Promise.resolve()
    expect(exitObserved).toBe(false)

    child.emit('close', null, 'SIGTERM')
    await waitingForExit
    expect(exitObserved).toBe(true)
  })

  it('uses a floored caller remaining budget', async () => {
    const identity = { pid: 1234, creationTimeMs: 12345 }
    const request = client.sample([identity], 250.9)
    const requestRejection = expect(request).rejects.toThrow(/timed out/)

    await vi.advanceTimersByTimeAsync(249)
    expect(child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    await requestRejection
    expect(child.kill).toHaveBeenCalledOnce()
    await expect(client.waitForExit()).resolves.toBeUndefined()
  })

  it('caps a caller budget at ten seconds', async () => {
    const identity = { pid: 1234, creationTimeMs: 12345 }
    const request = client.sample([identity], MAX_METRICS_REQUEST_TIMEOUT_MS + 60_000)
    const requestRejection = expect(request).rejects.toThrow(/timed out/)

    await vi.advanceTimersByTimeAsync(MAX_METRICS_REQUEST_TIMEOUT_MS - 1)
    expect(child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    await requestRejection
    expect(child.kill).toHaveBeenCalledOnce()
    await expect(client.waitForExit()).resolves.toBeUndefined()
  })

  it('clears a request deadline after accepting a complete response', async () => {
    const identity = { pid: 1234, creationTimeMs: 12345 }
    const sampled = client.sample([identity])
    const metrics = {
      ...identity,
      imagePath: 'C:\\Windows\\System32\\cmd.exe',
      privateBytes: 1,
      workingSetBytes: 1,
      handleCount: 1,
      kernel100ns: 1,
      user100ns: 1
    }
    child.stdout.write(`${JSON.stringify({ ok: true, processes: [metrics] })}\n`)

    await expect(sampled).resolves.toEqual([metrics])
    await vi.advanceTimersByTimeAsync(MAX_METRICS_REQUEST_TIMEOUT_MS)

    expect(child.kill).not.toHaveBeenCalled()
    const closing = client.close()
    child.closeNormally()
    await expect(closing).resolves.toBeUndefined()
    await expect(client.waitForExit()).resolves.toBeUndefined()
  })

  it('preserves the allowlisted Win32 operation and incomplete counts', async () => {
    const identities = [
      { pid: 1234, creationTimeMs: 12345 },
      { pid: 1235, creationTimeMs: 12346 },
      { pid: 1236, creationTimeMs: 12347 }
    ]
    const sampled = client.sample(identities)
    child.stdout.write(
      `${JSON.stringify({
        ok: false,
        reason: 'process_metric_unavailable',
        operation: 'get_process_memory_info',
        failedIdentities: identities.slice(1),
        errorCode: 31,
        expectedCount: 3,
        measuredCount: 1
      })}\n`
    )

    let caught: unknown
    try {
      await sampled
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ProcessMetricsIncompleteError)
    if (!(caught instanceof ProcessMetricsIncompleteError)) {
      throw new Error('Expected an incomplete metric failure')
    }
    expect(caught).toMatchObject({
      name: 'ProcessMetricsIncompleteError',
      operation: 'get_process_memory_info',
      expectedCount: 3,
      measuredCount: 1,
      errorCode: 31,
      message:
        'Windows process metrics incomplete (process_metric_unavailable, ' +
        'operation=get_process_memory_info, 1/3, error 31)'
    })
    expect(caught.matchesFailedIdentities(identities.slice(1))).toBe(true)
    expect(Object.keys(caught)).not.toContain('failedIdentities')
    expect(JSON.stringify(caught)).not.toContain(String(identities[1].pid))
    expect(JSON.stringify(caught)).not.toContain(String(identities[1].creationTimeMs))
    expect(JSON.stringify(caught)).not.toContain(String(identities[2].pid))
    expect(JSON.stringify(caught)).not.toContain(String(identities[2].creationTimeMs))
    expect(inspect(caught)).not.toContain(String(identities[1].pid))
    expect(inspect(caught)).not.toContain(String(identities[1].creationTimeMs))
    expect(inspect(caught)).not.toContain(String(identities[2].pid))
    expect(inspect(caught)).not.toContain(String(identities[2].creationTimeMs))
    expect(child.kill).not.toHaveBeenCalled()
    const closing = client.close()
    child.closeNormally()
    await expect(closing).resolves.toBeUndefined()
  })

  it('rejects missing or unrecognized metric operation diagnostics', () => {
    expect(
      metricResponse({
        ok: false,
        reason: 'process_metric_unavailable',
        operation: 'get_process_memory_info',
        failedIdentities: [{ pid: 1235, creationTimeMs: 12346 }],
        errorCode: 31,
        expectedCount: 2,
        measuredCount: 1
      })
    ).toMatchObject({
      ok: false,
      operation: 'get_process_memory_info',
      expectedCount: 2,
      measuredCount: 1
    })
    expect(() =>
      metricResponse({
        ok: false,
        reason: 'process_metric_unavailable',
        operation: 'ReadProcessMemory',
        failedIdentities: [{ pid: 1235, creationTimeMs: 12346 }],
        errorCode: 31,
        expectedCount: 2,
        measuredCount: 1
      })
    ).toThrow('invalid sampler metric operation')
    expect(() =>
      metricResponse({
        ok: false,
        reason: 'process_metric_unavailable',
        operation: 'get_process_memory_info',
        failedIdentities: [{ pid: 0, creationTimeMs: 12346 }],
        errorCode: 31,
        expectedCount: 2,
        measuredCount: 1
      })
    ).toThrow('invalid sampler failed identity')
    expect(() =>
      metricResponse({
        ok: false,
        reason: 'process_metric_unavailable',
        operation: 'get_process_memory_info',
        errorCode: 31,
        expectedCount: 2,
        measuredCount: 1
      })
    ).toThrow('invalid sampler metric diagnostic')
    expect(() =>
      metricResponse({
        ok: false,
        reason: 'process_metric_unavailable',
        operation: 'get_process_memory_info',
        failedIdentities: [
          { pid: 1235, creationTimeMs: 12346 },
          { pid: 1235, creationTimeMs: 12346 }
        ],
        errorCode: 31,
        expectedCount: 2,
        measuredCount: 0
      })
    ).toThrow('invalid sampler failed identity list')
    expect(() =>
      metricResponse({
        ok: false,
        reason: 'process_metric_unavailable',
        operation: 'get_process_memory_info',
        failedIdentities: [
          { pid: 1234, creationTimeMs: 12345 },
          { pid: 1235, creationTimeMs: 12346 }
        ],
        errorCode: 31,
        expectedCount: 2,
        measuredCount: 1
      })
    ).toThrow('invalid sampler failed identity count')
    expect(() =>
      metricResponse({
        ok: false,
        reason: 'pid_creation_mismatch',
        operation: 'open_process'
      })
    ).toThrow('invalid sampler metric operation')
  })

  it('binds a structured metric failure to the exact requested identity and count', () => {
    const requested = [
      { pid: 1234, creationTimeMs: 12345 },
      { pid: 1235, creationTimeMs: 12346 }
    ]
    const response = metricResponse({
      ok: false,
      reason: 'process_metric_unavailable',
      operation: 'query_full_process_image_name',
      failedIdentities: [requested[1]],
      errorCode: 31,
      expectedCount: 2,
      measuredCount: 1
    })
    if (response.ok) {
      throw new Error('Expected a failed sampler response')
    }
    const failure = sampleFailure(response, requested)
    expect(failure).toBeInstanceOf(ProcessMetricsIncompleteError)
    if (!(failure instanceof ProcessMetricsIncompleteError)) {
      throw new Error('Expected a structured incomplete metric failure')
    }
    expect(failure.matchesFailedIdentities([requested[1]])).toBe(true)

    const wrongCount = sampleFailure({ ...response, expectedCount: 3 }, requested)
    const wrongIdentity = sampleFailure(
      { ...response, failedIdentities: [{ pid: 1235, creationTimeMs: 99999 }] },
      requested
    )
    const unrequestedIdentity = sampleFailure(
      {
        ...response,
        failedIdentities: [requested[1], { pid: 9999, creationTimeMs: 99999 }],
        measuredCount: 0
      },
      requested
    )
    expect(wrongCount).not.toBeInstanceOf(ProcessMetricsIncompleteError)
    expect(wrongIdentity).not.toBeInstanceOf(ProcessMetricsIncompleteError)
    expect(unrequestedIdentity).not.toBeInstanceOf(ProcessMetricsIncompleteError)
  })
})
