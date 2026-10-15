import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startRuntimeCapabilityProbe } from './runtime-capability-probe'
import { LogicalClientCutoverError } from './stable-logical-rpc-client'
import type { RpcClient } from './rpc-client'
import type { RpcResponse } from './types'

type ProbeOutcome = RpcResponse | Error

function makeClient(outcomes: ProbeOutcome[]): { client: RpcClient; calls: () => number } {
  let calls = 0
  const client = {
    sendRequest: () => {
      const outcome = outcomes[Math.min(calls, outcomes.length - 1)]
      calls += 1
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome)
    }
  } as unknown as RpcClient
  return { client, calls: () => calls }
}

const ok = (capabilities: string[]): RpcResponse => ({
  ok: true,
  id: '1',
  result: { capabilities },
  _meta: { runtimeId: 'r1' }
})

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('startRuntimeCapabilityProbe', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('delivers capabilities on first success', async () => {
    const { client, calls } = makeClient([ok(['a.v1'])])
    const seen: (readonly string[])[] = []
    const cancel = startRuntimeCapabilityProbe(client, (capabilities) => seen.push(capabilities))
    await flushMicrotasks()
    expect(seen).toEqual([['a.v1']])
    expect(calls()).toBe(1)
    cancel()
  })

  it('treats malformed capabilities as unsupported', async () => {
    const response: RpcResponse = {
      ok: true,
      id: '1',
      result: { capabilities: 'a.v1' },
      _meta: { runtimeId: 'r1' }
    }
    const { client, calls } = makeClient([response])
    const seen: (readonly string[])[] = []
    const cancel = startRuntimeCapabilityProbe(client, (capabilities) => seen.push(capabilities))
    await flushMicrotasks()
    expect(seen).toEqual([[]])
    expect(calls()).toBe(1)
    cancel()
  })

  it('rejects capability arrays containing non-string values', async () => {
    const response: RpcResponse = {
      ok: true,
      id: '1',
      result: { capabilities: ['a.v1', 42] },
      _meta: { runtimeId: 'r1' }
    }
    const { client, calls } = makeClient([response])
    const seen: (readonly string[])[] = []
    const cancel = startRuntimeCapabilityProbe(client, (capabilities) => seen.push(capabilities))
    await flushMicrotasks()
    expect(seen).toEqual([[]])
    expect(calls()).toBe(1)
    cancel()
  })

  it('treats a malformed status result as unsupported', async () => {
    const response: RpcResponse = {
      ok: true,
      id: '1',
      result: null,
      _meta: { runtimeId: 'r1' }
    }
    const { client, calls } = makeClient([response])
    const seen: (readonly string[])[] = []
    const cancel = startRuntimeCapabilityProbe(client, (capabilities) => seen.push(capabilities))
    await flushMicrotasks()
    expect(seen).toEqual([[]])
    expect(calls()).toBe(1)
    cancel()
  })

  it('retries promptly after a logical-client cutover rejection', async () => {
    const { client, calls } = makeClient([new LogicalClientCutoverError(), ok(['a.v1'])])
    const seen: (readonly string[])[] = []
    const cancel = startRuntimeCapabilityProbe(client, (capabilities) => seen.push(capabilities))
    await flushMicrotasks()
    expect(seen).toEqual([])
    await vi.advanceTimersByTimeAsync(250)
    expect(seen).toEqual([['a.v1']])
    expect(calls()).toBe(2)
    cancel()
  })

  it('backs off on other failures and eventually recovers', async () => {
    const { client, calls } = makeClient([
      new Error('Request timed out: status.get'),
      new Error('Request timed out: status.get'),
      ok(['a.v1'])
    ])
    const seen: (readonly string[])[] = []
    const cancel = startRuntimeCapabilityProbe(client, (capabilities) => seen.push(capabilities))
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(seen).toEqual([])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(seen).toEqual([['a.v1']])
    expect(calls()).toBe(3)
    cancel()
  })

  it('retries an ok:false response instead of settling', async () => {
    const failure: RpcResponse = {
      ok: false,
      id: '1',
      error: { code: 'internal', message: 'nope' },
      _meta: { runtimeId: 'r1' }
    }
    const { client } = makeClient([failure, ok(['a.v1'])])
    const seen: (readonly string[])[] = []
    const cancel = startRuntimeCapabilityProbe(client, (capabilities) => seen.push(capabilities))
    await flushMicrotasks()
    expect(seen).toEqual([])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(seen).toEqual([['a.v1']])
    cancel()
  })

  it('caps the failure backoff', async () => {
    const outcomes: ProbeOutcome[] = Array.from({ length: 10 }, () => new Error('timeout'))
    outcomes.push(ok(['a.v1']))
    const { client, calls } = makeClient(outcomes)
    const seen: (readonly string[])[] = []
    const cancel = startRuntimeCapabilityProbe(client, (capabilities) => seen.push(capabilities))
    await flushMicrotasks()
    // Why: 1s+2s+4s+8s then 15s cap; ten failures fit well inside 8 capped waits.
    await vi.advanceTimersByTimeAsync(15_000 * 10)
    expect(seen).toEqual([['a.v1']])
    expect(calls()).toBe(11)
    cancel()
  })

  it('stops retrying and dropping results once cancelled', async () => {
    const { client, calls } = makeClient([new Error('timeout'), ok(['a.v1'])])
    const seen: (readonly string[])[] = []
    const cancel = startRuntimeCapabilityProbe(client, (capabilities) => seen.push(capabilities))
    await flushMicrotasks()
    cancel()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(seen).toEqual([])
    expect(calls()).toBe(1)
  })

  it('ignores a success that resolves after cancellation', async () => {
    let resolveRequest: ((response: RpcResponse) => void) | null = null
    const client = {
      sendRequest: () =>
        new Promise<RpcResponse>((resolve) => {
          resolveRequest = resolve
        })
    } as unknown as RpcClient
    const seen: (readonly string[])[] = []
    const cancel = startRuntimeCapabilityProbe(client, (capabilities) => seen.push(capabilities))
    cancel()
    resolveRequest?.(ok(['a.v1']))
    await flushMicrotasks()
    expect(seen).toEqual([])
  })
})

// The wrapper adds no probe of its own: the status probe's failed (third) and attempt-start (fourth)
// callbacks must come out of it unchanged. The fourth is not in the signature yet, so the call goes
// through a wider view of the same function.
type ProbePort = Parameters<typeof startRuntimeCapabilityProbe>[0]

const startCapabilityProbe: (
  client: ProbePort,
  onCapabilities: (capabilities: readonly string[]) => void,
  onAttemptFailed?: () => void,
  onAttemptStarted?: () => void
) => () => void = startRuntimeCapabilityProbe

function timelineClient(outcomes: ProbeOutcome[], events: string[]): ProbePort {
  let calls = 0
  return {
    sendRequest: () => {
      events.push('request')
      const outcome = outcomes[Math.min(calls, outcomes.length - 1)]!
      calls += 1
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome)
    }
  }
}

function startRecording(client: ProbePort, events: string[]): () => void {
  return startCapabilityProbe(
    client,
    (capabilities) => events.push(`capabilities:${capabilities.join(',')}`),
    () => events.push('attempt-failed'),
    () => events.push('attempt-start')
  )
}

describe('startRuntimeCapabilityProbe attempt callbacks', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('forwards the failed and attempt-start callbacks of the one retry owner', async () => {
    const events: string[] = []
    const cancel = startRecording(
      timelineClient([new Error('request timed out'), ok(['a.v1'])], events),
      events
    )
    await flushMicrotasks()
    expect(events).toEqual(['attempt-start', 'request', 'attempt-failed'])

    await vi.advanceTimersByTimeAsync(999)
    expect(events).toEqual(['attempt-start', 'request', 'attempt-failed'])
    await vi.advanceTimersByTimeAsync(1)
    expect(events).toEqual([
      'attempt-start',
      'request',
      'attempt-failed',
      'attempt-start',
      'request',
      'capabilities:a.v1'
    ])
    cancel()
  })

  it('publishes the empty set for an unreadable status as an answer, not a failed attempt', async () => {
    const events: string[] = []
    const unreadable: RpcResponse = { ok: true, id: '1', result: null, _meta: { runtimeId: 'r1' } }
    const cancel = startRecording(timelineClient([unreadable], events), events)
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(events).toEqual(['attempt-start', 'request', 'capabilities:'])
    cancel()
  })

  it('stays quiet after cancellation', async () => {
    const events: string[] = []
    const cancel = startRecording(timelineClient([new Error('request timed out')], events), events)
    await flushMicrotasks()
    cancel()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(events).toEqual(['attempt-start', 'request', 'attempt-failed'])
  })
})
