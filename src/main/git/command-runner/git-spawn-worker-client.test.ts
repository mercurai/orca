import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../own-chromium-tree-kill-guard', () => ({
  admitSelfInitiatedTreeKill: vi.fn(() => true)
}))

import { GitSpawnWorkerClient, MAX_CONSECUTIVE_DEATHS } from './git-spawn-worker-client'
import { execFileCaptureOnWorker } from './exec-file-capture-worker'

const workerAccess = vi.hoisted(() => ({ client: null as GitSpawnWorkerClient | null }))
vi.mock('./git-spawn-worker-access', () => ({ getGitSpawnWorkerClient: () => workerAccess.client }))


import type { SpawnWorkerRequest, SpawnWorkerResponse } from './git-spawn-worker-protocol'

class FakeWorker extends EventEmitter {
  readonly requests: SpawnWorkerRequest[] = []
  postMessage(request: SpawnWorkerRequest): void {
    this.requests.push(request)
  }
  unref(): void {}
  terminate(): Promise<number> {
    return Promise.resolve(0)
  }
  reply(message: SpawnWorkerResponse): void {
    this.emit('message', message)
  }
}

const SPEC = { command: 'git', args: ['status'], maxBuffer: 1024 }

function newClient(workers: FakeWorker[]): GitSpawnWorkerClient {
  return new GitSpawnWorkerClient({
    workerFactory: () => {
      const worker = new FakeWorker()
      workers.push(worker)
      return worker
    },
    log: () => {}
  })
}

describe('GitSpawnWorkerClient', () => {
  it('detaches a throwing capture observer without losing output or chunk acknowledgments', async () => {
    const workers: FakeWorker[] = []
    const client = newClient(workers)
    const observer = vi.fn(() => {
      throw new Error('observer failure')
    })
    const handle = client.capture({ ...SPEC, observeStderr: true }, () => {}, undefined, observer)
    const progress = Buffer.from('progress')
    workers[0]?.reply({ type: 'chunk', id: 1, channel: 'stderr', data: progress })
    workers[0]?.reply({ type: 'chunk', id: 1, channel: 'stderr', data: progress })
    await Promise.resolve()
    expect(observer).toHaveBeenCalledOnce()
    expect(workers[0]?.requests.at(-1)).toEqual({ type: 'ack', id: 1, chunks: 2 })
    workers[0]?.reply({
      type: 'result',
      id: 1,
      error: null,
      stdout: 'complete',
      stderr: 'progressprogress',
      terminating: false
    })
    await expect(handle?.outcome).resolves.toMatchObject({
      kind: 'result',
      stdout: 'complete',
      stderr: 'progressprogress'
    })
    workers[0]?.reply({ type: 'closed', id: 1, code: 0, signal: null })
    client.dispose()
  })

  it('settles a capture from the worker result and reports termination on close', async () => {
    const workers: FakeWorker[] = []
    const client = newClient(workers)
    const onTerminated = vi.fn()
    const handle = client.capture(SPEC, onTerminated)
    expect(workers[0]?.requests[0]).toMatchObject({ type: 'capture', id: 1, command: 'git' })

    workers[0]?.reply({
      type: 'result',
      id: 1,
      error: null,
      stdout: 'ok',
      stderr: '',
      terminating: false
    })
    await expect(handle?.outcome).resolves.toMatchObject({ kind: 'result', stdout: 'ok' })
    expect(onTerminated).not.toHaveBeenCalled()

    workers[0]?.reply({ type: 'closed', id: 1, code: 0, signal: null })
    expect(onTerminated).toHaveBeenCalledOnce()
  })

  it('waits for killed instead of a result that arrived while a kill was in flight', async () => {
    const workers: FakeWorker[] = []
    const client = newClient(workers)
    const handle = client.capture(SPEC, () => {})
    workers[0]?.reply({
      type: 'result',
      id: 1,
      error: { message: 'killed', name: 'Error', killed: true },
      stdout: '',
      stderr: '',
      terminating: true
    })
    workers[0]?.reply({ type: 'closed', id: 1, code: null, signal: 'SIGTERM' })
    workers[0]?.reply({ type: 'killed', id: 1, reason: 'timeout' })

    await expect(handle?.outcome).resolves.toEqual({ kind: 'killed', reason: 'timeout' })
  })

  it('answers a kill check with the own-Chromium guard decision', () => {
    const workers: FakeWorker[] = []
    const client = newClient(workers)
    client.capture(SPEC, () => {})
    workers[0]?.reply({ type: 'kill-check', id: 1, pid: 4321 })

    expect(workers[0]?.requests.at(-1)).toEqual({ type: 'verdict', id: 1, admit: true })
  })

  it('fails an accepted request without a spawn acknowledgment and retains its grant', async () => {
    const workers: FakeWorker[] = []
    const client = newClient(workers)
    const onTerminated = vi.fn()
    const handle = client.capture(SPEC, onTerminated)
    workers[0]?.emit('exit', 1)

    expect(workers[0]?.requests[0]).toMatchObject({ type: 'capture' })
    await expect(handle?.outcome).resolves.toMatchObject({
      kind: 'failed',
      error: { code: 'EGITSPAWNWORKER' }
    })
    expect(onTerminated).not.toHaveBeenCalled()
    expect(client.capture(SPEC, () => {})).not.toBeNull()
    expect(workers).toHaveLength(2)
  })

  it('does not replay an accepted capture if the worker dies before acknowledging spawn', async () => {
    const workers: FakeWorker[] = []
    const client = newClient(workers)
    workerAccess.client = client
    const retry = vi.fn(async () => ({ stdout: 'replayed', stderr: '' }))
    const onChildTerminated = vi.fn()
    try {
      const result = execFileCaptureOnWorker('git', ['commit'], { onChildTerminated }, retry)
      expect(workers[0]?.requests[0]).toMatchObject({ type: 'capture', args: ['commit'] })
      workers[0]?.emit('exit', 1)
      await expect(result).rejects.toMatchObject({ code: 'EGITSPAWNWORKER' })
      expect(retry).not.toHaveBeenCalled()
      expect(onChildTerminated).not.toHaveBeenCalled()
    } finally {
      workerAccess.client = null
      client.dispose()
    }
  })

  it('does not replay a capture accepted before a synchronous worker exit', async () => {
    let sideEffects = 0
    const worker = new FakeWorker()
    worker.postMessage = (request) => {
      worker.requests.push(request)
      if (request.type === 'capture') {
        sideEffects += 1
        worker.emit('exit', 1)
      }
    }
    const client = new GitSpawnWorkerClient({ workerFactory: () => worker, log: () => {} })
    workerAccess.client = client
    const retry = vi.fn(async () => ({ stdout: 'replayed', stderr: '' }))
    const onChildTerminated = vi.fn()
    try {
      const result = execFileCaptureOnWorker('git', ['commit'], { onChildTerminated }, retry)
      await expect(result).rejects.toMatchObject({ code: 'EGITSPAWNWORKER' })
      expect(sideEffects).toBe(1)
      expect(retry).not.toHaveBeenCalled()
      expect(onChildTerminated).not.toHaveBeenCalled()
    } finally {
      workerAccess.client = null
      client.dispose()
    }
  })

  it('distinguishes unknown stream lifetime from a proven spawn failure', () => {
    const workers: FakeWorker[] = []
    const client = newClient(workers)
    const unknown = vi.fn()
    client.stream({ command: 'git', args: ['status'] }, {
      onChunk: vi.fn(), onError: unknown, onClose: vi.fn()
    })
    workers[0]?.emit('exit', 1)
    expect(unknown).toHaveBeenCalledWith(expect.objectContaining({ code: 'EGITSPAWNWORKER' }), 'unknown')

    const proven = vi.fn()
    client.stream({ command: 'git', args: ['status'] }, {
      onChunk: vi.fn(), onError: proven, onClose: vi.fn()
    })
    workers[1]?.reply({
      type: 'errored', id: 2, error: { message: 'missing', name: 'Error' },
      hasPid: false, terminating: false
    })
    expect(proven).toHaveBeenCalledWith(expect.any(Error), false)
    client.dispose()
  })

  it('fails an acknowledged request with no PID without reporting termination', async () => {
    const workers: FakeWorker[] = []
    const client = newClient(workers)
    const onTerminated = vi.fn()
    const handle = client.capture(SPEC, onTerminated)
    workers[0]?.reply({ type: 'spawned', id: 1, pid: undefined, spawnMs: 1 })
    workers[0]?.emit('exit', 1)

    const outcome = await handle?.outcome
    expect(outcome).toMatchObject({ kind: 'failed' })
    expect(outcome?.kind === 'failed' && outcome.error).toMatchObject({ code: 'EGITSPAWNWORKER' })
    expect(onTerminated).not.toHaveBeenCalled()
  })

  it('stops using the worker after repeated consecutive deaths', () => {
    const workers: FakeWorker[] = []
    const client = newClient(workers)
    for (let death = 0; death < MAX_CONSECUTIVE_DEATHS; death += 1) {
      client.capture(SPEC, () => {})
      workers.at(-1)?.emit('exit', 1)
    }

    expect(client.isAvailable).toBe(false)
  })

  it('reports unavailable and returns null when no worker can be created', () => {
    const log = vi.fn()
    const client = new GitSpawnWorkerClient({
      workerFactory: () => {
        throw new Error('entry missing')
      },
      log
    })

    expect(client.capture(SPEC, () => {})).toBeNull()
    expect(client.isAvailable).toBe(false)
    expect(log).toHaveBeenCalledOnce()
  })

  it('delivers stream chunks as Buffers and acknowledges them in one batch', async () => {
    const workers: FakeWorker[] = []
    const client = newClient(workers)
    const chunks: string[] = []
    client.stream(
      { command: 'git', args: ['log'], cwd: '/repo' },
      {
        onChunk: (_channel, data) => chunks.push(data.toString('utf8')),
        onError: () => {},
        onClose: () => {}
      }
    )
    for (const text of ['a', 'b', 'c']) {
      workers[0]?.reply({
        type: 'chunk',
        id: 1,
        channel: 'stdout',
        data: new TextEncoder().encode(text)
      })
    }
    await Promise.resolve()

    expect(chunks).toEqual(['a', 'b', 'c'])
    expect(workers[0]?.requests.filter((request) => request.type === 'ack')).toEqual([
      { type: 'ack', id: 1, chunks: 3 }
    ])
  })
})
