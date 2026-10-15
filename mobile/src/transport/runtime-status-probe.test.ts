import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startRuntimeStatusProbe } from './runtime-status-probe'
import { LogicalClientCutoverError } from './stable-logical-rpc-client'
import type { HostStatusReply } from './host-status-reply-schema'
import type { UnvalidatedRpcRequestPort } from './unvalidated-rpc-request-port'
import type { RpcResponse } from './types'

type ProbeOutcome = RpcResponse | Error

function makeClient(outcomes: ProbeOutcome[]): {
  client: UnvalidatedRpcRequestPort
  calls: () => number
} {
  let calls = 0
  const client: UnvalidatedRpcRequestPort = {
    sendRequest: () => {
      const outcome = outcomes[Math.min(calls, outcomes.length - 1)]!
      calls += 1
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome)
    }
  }
  return { client, calls: () => calls }
}

const ok = (result: unknown): RpcResponse => ({
  ok: true,
  id: '1',
  result,
  _meta: { runtimeId: 'r1' }
})

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('startRuntimeStatusProbe', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('delivers the parsed status once and stops', async () => {
    const { client, calls } = makeClient([
      ok({ machineName: 'm4airs-Air', hostPlatform: 'darwin', capabilities: ['a.v1'] })
    ])
    const seen: (HostStatusReply | null)[] = []
    const cancel = startRuntimeStatusProbe(client, (status) => seen.push(status))
    await flushMicrotasks()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ machineName: 'm4airs-Air', hostPlatform: 'darwin' })
    expect(calls()).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls()).toBe(1)
    cancel()
  })

  it('delivers null for an answer this build cannot decode, without retrying', async () => {
    const { client, calls } = makeClient([ok(null)])
    const seen: (HostStatusReply | null)[] = []
    const cancel = startRuntimeStatusProbe(client, (status) => seen.push(status))
    await flushMicrotasks()
    expect(seen).toEqual([null])
    expect(calls()).toBe(1)
    cancel()
  })

  it('retries a refusal and a cutover rejection until a status lands', async () => {
    const refusal: RpcResponse = {
      ok: false,
      id: '1',
      error: { code: 'unavailable', message: 'no' },
      _meta: { runtimeId: 'r1' }
    }
    const { client, calls } = makeClient([
      refusal,
      new LogicalClientCutoverError(),
      ok({ machineName: 'Studio' })
    ])
    const seen: (HostStatusReply | null)[] = []
    const cancel = startRuntimeStatusProbe(client, (status) => seen.push(status))
    await flushMicrotasks()
    expect(seen).toEqual([])
    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(250)
    await flushMicrotasks()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ machineName: 'Studio' })
    expect(calls()).toBe(3)
    cancel()
  })

  it('reports each failed attempt once its retry is scheduled, and never an answer', async () => {
    const { client } = makeClient([
      new Error('request timed out'),
      new LogicalClientCutoverError(),
      ok(null)
    ])
    const seen: (HostStatusReply | null)[] = []
    let failed = 0
    const cancel = startRuntimeStatusProbe(
      client,
      (status) => seen.push(status),
      () => {
        failed += 1
      }
    )
    await flushMicrotasks()
    expect(failed).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()
    expect(failed).toBe(2)
    await vi.advanceTimersByTimeAsync(250)
    await flushMicrotasks()
    expect(seen).toEqual([null])
    expect(failed).toBe(2)
    cancel()
  })
})

// The consumer's loading state hangs on this one retry owner: the fourth callback says an attempt is
// about to ask, the third says it was refused, and a backoff between them is neither. The fourth is
// not in the signature yet, so the call goes through a wider view of the same function.
const startProbe: (
  client: UnvalidatedRpcRequestPort,
  onStatus: (status: HostStatusReply | null) => void,
  onAttemptFailed?: () => void,
  onAttemptStarted?: () => void
) => () => void = startRuntimeStatusProbe

function timelineClient(outcomes: ProbeOutcome[], events: string[]): UnvalidatedRpcRequestPort {
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

function heldClient(): {
  client: UnvalidatedRpcRequestPort
  requests: { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }[]
} {
  const requests: { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }[] =
    []
  const client: UnvalidatedRpcRequestPort = {
    sendRequest: () =>
      new Promise<RpcResponse>((resolve, reject) => {
        requests.push({ resolve, reject })
      })
  }
  return { client, requests }
}

function startRecording(client: UnvalidatedRpcRequestPort, events: string[]): () => void {
  return startProbe(
    client,
    (status) => events.push(status === null ? 'status:null' : 'status'),
    () => events.push('attempt-failed'),
    () => events.push('attempt-start')
  )
}

describe('startRuntimeStatusProbe attempt callbacks', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('announces each attempt before its request and needs no failure when a status lands', async () => {
    const events: string[] = []
    const cancel = startRecording(timelineClient([ok({ machineName: 'Studio' })], events), events)
    await flushMicrotasks()
    expect(events).toEqual(['attempt-start', 'request', 'status'])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(events).toEqual(['attempt-start', 'request', 'status'])
    cancel()
  })

  it('settles on an answer this build cannot decode without announcing another attempt', async () => {
    const events: string[] = []
    const cancel = startRecording(timelineClient([ok(null)], events), events)
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(events).toEqual(['attempt-start', 'request', 'status:null'])
    cancel()
  })

  it('reports a failure, stays quiet through the backoff, and announces the real retry', async () => {
    const refusal: RpcResponse = {
      ok: false,
      id: '1',
      error: { code: 'unavailable', message: 'no' },
      _meta: { runtimeId: 'r1' }
    }
    const events: string[] = []
    const cancel = startRecording(
      timelineClient([refusal, new LogicalClientCutoverError(), ok({ machineName: 'Studio' })], events),
      events
    )
    await flushMicrotasks()
    expect(events).toEqual(['attempt-start', 'request', 'attempt-failed'])

    await vi.advanceTimersByTimeAsync(999)
    await flushMicrotasks()
    expect(events).toEqual(['attempt-start', 'request', 'attempt-failed'])

    await vi.advanceTimersByTimeAsync(1)
    await flushMicrotasks()
    expect(events).toEqual([
      'attempt-start',
      'request',
      'attempt-failed',
      'attempt-start',
      'request',
      'attempt-failed'
    ])

    await vi.advanceTimersByTimeAsync(250)
    await flushMicrotasks()
    expect(events.slice(6)).toEqual(['attempt-start', 'request', 'status'])
    cancel()
  })

  it('goes quiet when cancelled, whether the request is in flight or backing off', async () => {
    const inFlight = heldClient()
    const flightEvents: string[] = []
    const cancelInFlight = startRecording(inFlight.client, flightEvents)
    await flushMicrotasks()
    expect(flightEvents).toEqual(['attempt-start'])
    cancelInFlight()
    inFlight.requests[0]!.reject(new Error('request timed out'))
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(flightEvents).toEqual(['attempt-start'])

    const backoffEvents: string[] = []
    const cancelBackoff = startRecording(
      timelineClient([new Error('request timed out')], backoffEvents),
      backoffEvents
    )
    await flushMicrotasks()
    expect(backoffEvents).toEqual(['attempt-start', 'request', 'attempt-failed'])
    cancelBackoff()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(backoffEvents).toEqual(['attempt-start', 'request', 'attempt-failed'])
  })

  it('lets a cancelled probe say nothing to the consumer that replaced it', async () => {
    let phase = 'idle'
    const consumer = (client: UnvalidatedRpcRequestPort): (() => void) =>
      startProbe(
        client,
        () => {
          phase = 'settled'
        },
        () => {
          phase = 'failed'
        },
        () => {
          phase = 'pending'
        }
      )
    const old = heldClient()
    const cancelOld = consumer(old.client)
    await flushMicrotasks()
    expect(phase).toBe('pending')
    cancelOld()

    const current = heldClient()
    const cancelCurrent = consumer(current.client)
    await flushMicrotasks()
    expect(phase).toBe('pending')
    current.requests[0]!.resolve(ok({ machineName: 'Studio' }))
    await flushMicrotasks()
    expect(phase).toBe('settled')

    // The old client answers after the new one settled: it is not the consumer's phase any more.
    old.requests[0]!.reject(new Error('request timed out'))
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(phase).toBe('settled')
    cancelCurrent()
  })
})
