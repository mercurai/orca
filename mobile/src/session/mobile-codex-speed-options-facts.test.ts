// Codex speed on the phone's options hook: the facts it reports (stored selection, last request,
// processing tier) and what a client swap does to a pick the previous client still has in flight.

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionOptionResult,
  AgentSessionOptionsResult
} from '../../../src/shared/agent-session-wire'
import type { CodexSpeedHostSupport } from '../../../src/shared/codex-service-tier-presentation'
import { codexSpeedLinesOfSurface } from '../../../src/shared/codex-speed-facts-presentation'
import type { SessionOptionDescriptor } from '../../../src/shared/native-chat-session-options'
import type { RpcClient } from '../transport/rpc-client'
import type {
  StructuredAgentSessionMutate,
  StructuredAgentSessionMutationResult
} from './mobile-structured-agent-session-rpc'
import { useMobileStructuredAgentOptions } from './use-mobile-structured-agent-options'

const STANDARD_TIER = { value: 'default', label: 'Standard' }
const FAST_TIER = { value: 'synthetic-fast-lane', label: 'Fast' }
const ULTRAFAST_TIER = { value: 'synthetic-ultra-lane', label: 'Ultrafast' }

const TIERED_OPTIONS: AgentSessionOptionsResult = {
  models: [
    {
      id: 'gpt-live',
      label: 'GPT Live',
      isDefault: true,
      defaultEffort: 'medium',
      efforts: [{ value: 'medium', label: 'Medium' }],
      supportsFastMode: true,
      serviceTiers: [STANDARD_TIER, FAST_TIER, ULTRAFAST_TIER]
    }
  ],
  fastModeSupport: { supported: true },
  current: {
    model: 'gpt-live',
    effort: 'medium',
    serviceTier: 'default',
    confirmed: ['serviceTier']
  }
}

const FAST_SELECTED: AgentSessionOptionsResult = {
  ...TIERED_OPTIONS,
  current: { ...TIERED_OPTIONS.current, serviceTier: FAST_TIER.value },
  speed: {
    selection: { tierId: FAST_TIER.value, state: 'ready' },
    lastRequest: { clientMessageId: 'm1', tierId: FAST_TIER.value, state: 'accepted' }
  }
}

type WriteResult = StructuredAgentSessionMutationResult<AgentSessionOptionResult>

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

/** A host that answers every `agentSession.options` read from `reads` and records each request. */
function optionsClient(reads: () => Promise<AgentSessionOptionsResult>) {
  const sent: { method: string; params: unknown }[] = []
  const client: RpcClient = {
    sendRequest: async (method: string, params?: unknown) => {
      sent.push({ method, params })
      return {
        id: 'rpc-1',
        ok: true as const,
        result: method === 'agentSession.options' ? await reads() : {},
        _meta: { runtimeId: 'runtime-1' }
      }
    },
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  const methods = (name: string) => sent.filter((entry) => entry.method === name)
  return { client, methods, optionReads: () => methods('agentSession.options').length }
}

const SETTINGS_WRITE = 'settings.mutateNativeChatSessionOptions'

function answeringOptions(...results: AgentSessionOptionsResult[]) {
  let index = 0
  return () => Promise.resolve(results[Math.min(index++, results.length - 1)]!)
}

/** `next` answers the nth write. An untyped `vi.fn` is what satisfies the generic mutate
 *  signature: a concrete fixture cannot produce the caller's `TValue` on its own. */
function recordingMutate(next: (call: number) => Promise<WriteResult>) {
  const calls: { method: string; fields: Record<string, unknown> }[] = []
  const mock = vi.fn()
  mock.mockImplementation(
    (method: string, _fingerprintMethod: string, fields: Record<string, unknown>) => {
      calls.push({ method, fields })
      return next(calls.length - 1)
    }
  )
  const mutate: StructuredAgentSessionMutate = mock
  return { calls, mutate }
}

function accepted(value: AgentSessionOptionResult, sameFence: boolean): WriteResult {
  return { status: 'accepted', value, sameFence }
}

const tierWrite = (): WriteResult =>
  accepted(
    { key: 'serviceTier', value: FAST_TIER.value, options: { serviceTier: FAST_TIER.value } },
    true
  )

type Controller = ReturnType<typeof useMobileStructuredAgentOptions>

type ProbeProps = {
  client: RpcClient | null
  mutate: StructuredAgentSessionMutate
  codexSpeedHost?: CodexSpeedHostSupport
  onRender: (controller: Controller) => void
}

function Probe(props: ProbeProps): null {
  props.onRender(
    useMobileStructuredAgentOptions({
      agent: 'codex',
      client: props.client,
      sessionId: 'session-1',
      enabled: true,
      fence: 1,
      mutate: props.mutate,
      ...(props.codexSpeedHost ? { codexSpeedHost: props.codexSpeedHost } : {})
    })
  )
  return null
}

async function settle() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function mountOptions(props: Omit<ProbeProps, 'onRender'>) {
  let rendered: Controller | null = null
  const onRender = (controller: Controller) => {
    rendered = controller
  }
  let renderer: ReactTestRenderer | null = null
  await act(async () => {
    renderer = create(createElement(Probe, { ...props, onRender }))
  })
  await settle()
  return {
    current: (): Controller => {
      if (!rendered) {
        throw new Error('probe never rendered')
      }
      return rendered
    },
    rerender: async (next: Partial<Omit<ProbeProps, 'onRender'>>) => {
      await act(async () => {
        renderer?.update(createElement(Probe, { ...props, ...next, onRender }))
      })
      await settle()
    },
    unmount: async () => {
      await act(async () => renderer?.unmount())
    }
  }
}

function tierValue(snapshot: readonly SessionOptionDescriptor[]) {
  const kind = snapshot.find((entry) => entry.id === 'serviceTier')?.kind
  return kind && 'currentValue' in kind ? kind.currentValue : undefined
}

const speedLines = (controller: Controller) => codexSpeedLinesOfSurface(controller.optionSurface)

describe('useMobileStructuredAgentOptions speed facts', () => {
  async function mountWith(reply: AgentSessionOptionsResult, host: CodexSpeedHostSupport) {
    const { mutate } = recordingMutate(async () => ({ status: 'unknown' }))
    return mountOptions({
      client: optionsClient(answeringOptions(reply)).client,
      mutate,
      codexSpeedHost: host
    })
  }

  it('reports the stored selection, the last request and unknown processing as separate lines', async () => {
    const harness = await mountWith(FAST_SELECTED, 'supported')

    expect(speedLines(harness.current())).toEqual([
      { kind: 'stored', label: 'Fast' },
      { kind: 'last-request', outcome: 'accepted', label: 'Fast' },
      { kind: 'processing' }
    ])
    await harness.unmount()
  })

  it('keeps a pending pick apart from the last accepted request', async () => {
    const harness = await mountWith(FAST_SELECTED, 'supported')

    await act(async () => {
      await harness.current().setStructuredOption('serviceTier', ULTRAFAST_TIER.value)
    })
    await settle()

    expect(speedLines(harness.current())).toEqual([
      { kind: 'pending', label: 'Ultrafast' },
      { kind: 'last-request', outcome: 'accepted', label: 'Fast' },
      { kind: 'processing' }
    ])
    await harness.unmount()
  })

  it('names the processing tier only when the host carried one, without touching the other lines', async () => {
    const harness = await mountWith(
      {
        ...FAST_SELECTED,
        speed: {
          ...FAST_SELECTED.speed!,
          processing: { turnId: 'turn-1', tierId: STANDARD_TIER.value }
        }
      },
      'supported'
    )

    expect(speedLines(harness.current())).toEqual([
      { kind: 'stored', label: 'Fast' },
      { kind: 'last-request', outcome: 'accepted', label: 'Fast' },
      { kind: 'processing', label: 'Standard' }
    ])
    await harness.unmount()
  })

  it('reports no speed lines where the host offers no speed select', async () => {
    const harness = await mountWith(FAST_SELECTED, 'unsupported')

    expect(speedLines(harness.current())).toEqual([])
    await harness.unmount()
  })

  it('shows a requested tier the host cannot send apart from the stored tier on a fresh client', async () => {
    const CUSTOM = 'synthetic-custom-lane'
    const harness = await mountWith(
      { ...FAST_SELECTED, speed: { selection: { tierId: CUSTOM, state: 'unavailable' } } },
      'supported'
    )

    const lines = speedLines(harness.current())
    expect(lines[0]).toEqual({ kind: 'stored', label: 'Fast' })
    const requested = lines.filter((line) => JSON.stringify(line).includes(CUSTOM))
    expect(requested).toHaveLength(1)
    expect(requested[0]?.kind).not.toBe('stored')
    await harness.unmount()
  })

  it('reports the accepted tier as stored beside a blocked request when the read lists no confirmed ids', async () => {
    const CUSTOM = 'synthetic-custom-lane'
    const { confirmed: _confirmed, ...current } = FAST_SELECTED.current
    const harness = await mountWith(
      { ...FAST_SELECTED, current, speed: { selection: { tierId: CUSTOM, state: 'unknown' } } },
      'supported'
    )

    const lines = speedLines(harness.current())
    expect(lines[0]).toEqual({ kind: 'stored', label: 'Fast' })
    expect(lines.filter((line) => JSON.stringify(line).includes(CUSTOM))).toHaveLength(1)
    // The blocked request is a separate claim: a fresh phone's sends stay out.
    expect(harness.current().isSpeedSendBlocked()).toBe(true)
    await harness.unmount()
  })

  it('restores the Fast toggle and refuses a tier write when the same client now reads an older host', async () => {
    const { calls, mutate } = recordingMutate(async () => accepted({ key: 'x', value: 'y' }, true))
    const harness = await mountOptions({
      client: optionsClient(answeringOptions(TIERED_OPTIONS)).client,
      mutate,
      codexSpeedHost: 'supported'
    })
    expect(tierValue(harness.current().optionSnapshot)).toBe('default')

    await harness.rerender({ codexSpeedHost: 'unsupported' })

    const snapshot = harness.current().optionSnapshot
    expect(snapshot.some((entry) => entry.id === 'serviceTier')).toBe(false)
    expect(snapshot.some((entry) => entry.id === 'fastMode')).toBe(true)
    let outcome: boolean | null = null
    await act(async () => {
      outcome = await harness.current().setStructuredOption('serviceTier', FAST_TIER.value)
    })
    expect(outcome).toBe(false)
    expect(calls).toHaveLength(0)
    await harness.unmount()
  })
})

// What the host reported of the last turn stays until a later read replaces it: an acknowledgement
// is next-turn intent, and a failed or late follow-up read must not leave the picker blank.
describe('useMobileStructuredAgentOptions last turn evidence', () => {
  const lastTurn: AgentSessionOptionsResult = {
    ...FAST_SELECTED,
    speed: {
      selection: { tierId: FAST_TIER.value, state: 'ready' },
      lastRequest: {
        clientMessageId: 'turn-1-message',
        tierId: FAST_TIER.value,
        turnId: 'turn-1',
        state: 'accepted'
      },
      applied: { clientMessageId: 'turn-1-message', tierId: FAST_TIER.value, turnId: 'turn-1' },
      processing: { turnId: 'turn-1', tierId: FAST_TIER.value }
    }
  }

  it.each(['rejected', 'unanswered'] as const)(
    'keeps it beside a newly accepted tier while the follow-up read is %s',
    async (followUp) => {
      let reads = 0
      const host = optionsClient(() => {
        reads += 1
        if (reads === 1) {
          return Promise.resolve(lastTurn)
        }
        return followUp === 'rejected'
          ? Promise.reject(new Error('options_read_failed'))
          : new Promise<AgentSessionOptionsResult>(() => {})
      })
      const { mutate } = recordingMutate(async () =>
        accepted(
          {
            key: 'serviceTier',
            value: ULTRAFAST_TIER.value,
            options: { serviceTier: ULTRAFAST_TIER.value }
          },
          true
        )
      )
      const harness = await mountOptions({
        client: host.client,
        mutate,
        codexSpeedHost: 'supported'
      })
      expect(speedLines(harness.current())).toContainEqual({ kind: 'processing', label: 'Fast' })

      let outcome = false
      await act(async () => {
        outcome = await harness.current().setStructuredOption('serviceTier', ULTRAFAST_TIER.value)
      })
      await vi.waitFor(() => expect(host.optionReads()).toBe(2))

      expect(outcome).toBe(true)
      expect(tierValue(harness.current().optionSnapshot)).toBe(ULTRAFAST_TIER.value)
      expect(speedLines(harness.current())).toEqual([
        { kind: 'pending', label: 'Ultrafast' },
        { kind: 'last-request', outcome: 'accepted', label: 'Fast' },
        { kind: 'processing', label: 'Fast' }
      ])
      await harness.unmount()
    }
  )
})

// v1.4.224 merges the prior options into every acknowledgement, so an explicit Fast-off comes back
// beside the saved canonical tier. The action is the person's, not the stored tier.
describe('useMobileStructuredAgentOptions older-host acknowledgement', () => {
  const savedUltrafast: AgentSessionOptionsResult = {
    ...TIERED_OPTIONS,
    current: {
      model: 'gpt-live',
      effort: 'medium',
      serviceTier: ULTRAFAST_TIER.value,
      confirmed: ['serviceTier']
    }
  }
  const afterFastOff: AgentSessionOptionsResult = {
    ...TIERED_OPTIONS,
    current: { model: 'gpt-live', effort: 'medium', fastMode: false, confirmed: ['fastMode'] }
  }

  it('replaces a saved Ultrafast with Fast off, in what it remembers and in what it tracks', async () => {
    const host = optionsClient(answeringOptions(savedUltrafast, afterFastOff))
    const { calls, mutate } = recordingMutate(async () =>
      accepted(
        {
          key: 'fastMode',
          value: 'false',
          options: { model: 'gpt-live', serviceTier: ULTRAFAST_TIER.value, fastMode: 'false' }
        },
        true
      )
    )
    const harness = await mountOptions({
      client: host.client,
      mutate,
      codexSpeedHost: 'unsupported'
    })
    expect(harness.current().optionSnapshot.some((entry) => entry.id === 'fastMode')).toBe(true)

    let outcome = false
    await act(async () => {
      outcome = await harness.current().setStructuredOption('fastMode', false)
    })
    await settle()

    expect(outcome).toBe(true)
    expect(calls[0]).toEqual({
      method: 'agentSession.setOption',
      fields: { key: 'fastMode', value: 'false' }
    })
    await vi.waitFor(() => expect(host.methods(SETTINGS_WRITE)).toHaveLength(1))
    const remembered = JSON.stringify(host.methods(SETTINGS_WRITE).map((entry) => entry.params))
    expect(remembered).toContain('"optionId":"fastMode"')
    expect(remembered).not.toContain(ULTRAFAST_TIER.value)

    // Once a host affirms tiers, the select reads what the person chose, not the saved tier.
    await harness.rerender({ codexSpeedHost: 'supported' })
    expect(tierValue(harness.current().optionSnapshot)).toBe('default')
    await harness.unmount()
  })
})

describe('useMobileStructuredAgentOptions client cutover', () => {
  async function mountOnPrevious(answer: (call: number) => Promise<WriteResult>) {
    const previousHost = optionsClient(answeringOptions(TIERED_OPTIONS))
    const nextHost = optionsClient(answeringOptions(TIERED_OPTIONS))
    const { calls, mutate } = recordingMutate(answer)
    const harness = await mountOptions({
      client: previousHost.client,
      mutate,
      codexSpeedHost: 'supported'
    })
    return { previousHost, nextHost, calls, harness }
  }

  const nothingWritten = (...hosts: ReturnType<typeof optionsClient>[]) => {
    for (const host of hosts) {
      expect(host.methods(SETTINGS_WRITE)).toEqual([])
    }
  }

  it('commits, persists and refreshes nothing from a write the previous client answers after the swap', async () => {
    const inFlight = deferred<WriteResult>()
    const { previousHost, nextHost, calls, harness } = await mountOnPrevious(
      async () => inFlight.promise
    )

    let write: Promise<boolean> | null = null
    await act(async () => {
      write = harness.current().setStructuredOption('serviceTier', FAST_TIER.value)
    })
    expect(calls).toHaveLength(1)

    await harness.rerender({ client: nextHost.client })
    expect(nextHost.optionReads()).toBe(1)
    expect(tierValue(harness.current().optionSnapshot)).toBe('default')

    await act(async () => {
      inFlight.resolve(tierWrite())
      await write
    })
    await settle()

    // The pick was the previous host's: the new host's own read stays the truth, and the
    // callback that still holds the previous client writes to neither host.
    expect(tierValue(harness.current().optionSnapshot)).toBe('default')
    nothingWritten(previousHost, nextHost)
    expect(previousHost.optionReads()).toBe(1)
    expect(nextHost.optionReads()).toBe(1)
    await harness.unmount()
  })

  it('commits and persists nothing from an unknown outcome the previous client reports after the swap', async () => {
    const inFlight = deferred<WriteResult>()
    const { previousHost, nextHost, harness } = await mountOnPrevious(async () => inFlight.promise)

    let write: Promise<boolean> | null = null
    await act(async () => {
      write = harness.current().setStructuredOption('serviceTier', FAST_TIER.value)
    })
    await harness.rerender({ client: nextHost.client })

    await act(async () => {
      inFlight.resolve({ status: 'unknown' })
      await write
    })
    await settle()

    // An unknown outcome commits optimistically only where the pick was made.
    expect(tierValue(harness.current().optionSnapshot)).toBe('default')
    expect(speedLines(harness.current())).toEqual([
      { kind: 'stored', label: 'Standard' },
      { kind: 'processing' }
    ])
    expect(harness.current().pendingOptionId).toBeNull()
    nothingWritten(previousHost, nextHost)
    await harness.unmount()
  })

  it('does not hold the new host behind a write the previous client has not answered', async () => {
    const inFlight = deferred<WriteResult>()
    const { previousHost, nextHost, calls, harness } = await mountOnPrevious(async (call) =>
      call === 0
        ? inFlight.promise
        : accepted({ key: 'serviceTier', value: ULTRAFAST_TIER.value }, false)
    )
    await act(async () => {
      void harness.current().setStructuredOption('serviceTier', FAST_TIER.value)
    })

    await harness.rerender({ client: nextHost.client })

    expect(harness.current().pendingOptionId).toBeNull()
    let outcome: boolean | null = null
    await act(async () => {
      outcome = await harness.current().setStructuredOption('serviceTier', ULTRAFAST_TIER.value)
    })
    // The host's answer names another fence than this view's snapshot: no success is reported.
    expect(outcome).toBe(false)
    expect(calls[1]).toEqual({
      method: 'agentSession.setOption',
      fields: { key: 'serviceTier', value: ULTRAFAST_TIER.value }
    })

    // The new host's own Ultra request is unanswered at this view's fence: it stays held.
    const before = {
      tier: tierValue(harness.current().optionSnapshot),
      lines: speedLines(harness.current()),
      blocked: harness.current().isSpeedSendBlocked(),
      pendingOptionId: harness.current().pendingOptionId,
      previousReads: previousHost.optionReads(),
      nextReads: nextHost.optionReads()
    }
    expect(before.blocked).toBe(true)

    await act(async () => {
      inFlight.resolve(tierWrite())
    })
    await settle()

    // The previous client's late answer changes nothing of the new host's pending intent.
    expect(tierValue(harness.current().optionSnapshot)).toBe(before.tier)
    expect(speedLines(harness.current())).toEqual(before.lines)
    expect(harness.current().isSpeedSendBlocked()).toBe(true)
    expect(harness.current().pendingOptionId).toBe(before.pendingOptionId)
    nothingWritten(previousHost, nextHost)
    expect(previousHost.optionReads()).toBe(before.previousReads)
    expect(nextHost.optionReads()).toBe(before.nextReads)
    await harness.unmount()
  })

  it('drops an options read the previous client answers after the swap', async () => {
    const late = deferred<AgentSessionOptionsResult>()
    const previousHost = optionsClient(() => late.promise)
    const nextHost = optionsClient(answeringOptions(TIERED_OPTIONS))
    const { mutate } = recordingMutate(async () => ({ status: 'unknown' }))
    const harness = await mountOptions({
      client: previousHost.client,
      mutate,
      codexSpeedHost: 'supported'
    })

    await harness.rerender({ client: nextHost.client })
    expect(tierValue(harness.current().optionSnapshot)).toBe('default')

    await act(async () => {
      late.resolve({ ...FAST_SELECTED, conversationCommands: ['compact'] })
    })
    await settle()

    expect(tierValue(harness.current().optionSnapshot)).toBe('default')
    expect(harness.current().conversationCommands).toEqual([])
    expect(speedLines(harness.current())).toEqual([
      { kind: 'stored', label: 'Standard' },
      { kind: 'processing' }
    ])
    await harness.unmount()
  })
})

// `sameFence: false` compares only the transcript's fence with the one the write was sent at: it is
// not proof that the host or session changed. An accepted answer at another fence says the host
// stored the pick somewhere this view cannot attribute, so the pick stays held until this view's
// own read, or an explicit accepted replacement, answers it.
describe('useMobileStructuredAgentOptions answer at another fence', () => {
  const answeredAtAnotherFence = () =>
    accepted(
      {
        key: 'serviceTier',
        value: ULTRAFAST_TIER.value,
        options: { serviceTier: ULTRAFAST_TIER.value }
      },
      false
    )

  const standardWrite = () =>
    accepted(
      {
        key: 'serviceTier',
        value: STANDARD_TIER.value,
        options: { serviceTier: STANDARD_TIER.value }
      },
      true
    )

  it('keeps the pick held and commits, remembers and reads nothing', async () => {
    const host = optionsClient(answeringOptions(TIERED_OPTIONS))
    const { calls, mutate } = recordingMutate(async () => answeredAtAnotherFence())
    const harness = await mountOptions({
      client: host.client,
      mutate,
      codexSpeedHost: 'supported'
    })
    const readsBefore = host.optionReads()

    let outcome: boolean | null = null
    await act(async () => {
      outcome = await harness.current().setStructuredOption('serviceTier', ULTRAFAST_TIER.value)
    })
    await settle()

    expect(outcome).toBe(false)
    expect(calls).toHaveLength(1)
    // Held, not dropped: a send goes back to the composer rather than out at the prior speed.
    expect(harness.current().isSpeedSendBlocked()).toBe(true)
    expect(speedLines(harness.current())[0]).toEqual({ kind: 'pending', label: 'Ultrafast' })
    expect(harness.current().pendingOptionId).toBeNull()
    expect(host.methods(SETTINGS_WRITE)).toEqual([])
    expect(host.optionReads()).toBe(readsBefore)
    await harness.unmount()
  })

  it('is released by an explicit replacement the host accepted at this fence', async () => {
    const host = optionsClient(answeringOptions(TIERED_OPTIONS))
    const { mutate } = recordingMutate(async (call) =>
      call === 0 ? answeredAtAnotherFence() : standardWrite()
    )
    const harness = await mountOptions({
      client: host.client,
      mutate,
      codexSpeedHost: 'supported'
    })
    await act(async () => {
      await harness.current().setStructuredOption('serviceTier', ULTRAFAST_TIER.value)
    })
    await settle()
    expect(harness.current().isSpeedSendBlocked()).toBe(true)

    let outcome: boolean | null = null
    await act(async () => {
      outcome = await harness.current().setStructuredOption('serviceTier', STANDARD_TIER.value)
    })
    await settle()

    expect(outcome).toBe(true)
    expect(harness.current().isSpeedSendBlocked()).toBe(false)
    await harness.unmount()
  })
})
