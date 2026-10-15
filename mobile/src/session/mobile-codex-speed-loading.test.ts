// Codex speed loading on the phone: what the real options hook shows while the host's speed support,
// its options read or its model catalog is still being waited on, apart from a wait that failed and
// from a settled host. Reads are real and deferred. The client-only phase reaches the hook through a
// spread, so a missing phase fails as a missing difference in what the picker shows, not as a missing
// import. The frozen kinds `loading` and `support-unverified` are compared by name, as plain strings
// so an old hook fails the assertion rather than the import; elsewhere a wait is "the settled lines
// plus one more", and a failure is "a different extra line".

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionModelCatalogResult,
  AgentSessionOptionResult,
  AgentSessionOptionsResult
} from '../../../src/shared/agent-session-wire'
import type { CodexSpeedHostSupport } from '../../../src/shared/codex-service-tier-presentation'
import {
  codexSpeedLinesOfSurface,
  type CodexSpeedLine
} from '../../../src/shared/codex-speed-facts-presentation'
import { AGENT_SESSION_CODEX_SERVICE_TIERS_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import type { RpcClient } from '../transport/rpc-client'
import { structuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'
import type {
  StructuredAgentSessionMutate,
  StructuredAgentSessionMutationResult
} from './mobile-structured-agent-session-rpc'
import { useMobileStructuredAgentOptions } from './use-mobile-structured-agent-options'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined
  }
}))

type Phase = 'pending' | 'failed' | 'settled'

const STANDARD = { value: 'default', label: 'Standard' }
const FAST = { value: 'synthetic-fast-lane', label: 'Fast' }
const ULTRA = { value: 'synthetic-ultra-lane', label: 'Ultrafast' }
const OTHER = { value: 'synthetic-other-lane', label: 'Other' }

const LISTED: AgentSessionOptionsResult = {
  models: [
    {
      id: 'gpt-live',
      label: 'GPT Live',
      isDefault: true,
      defaultEffort: 'medium',
      efforts: [{ value: 'medium', label: 'Medium' }],
      supportsFastMode: true,
      serviceTiers: [STANDARD, FAST, ULTRA]
    }
  ],
  fastModeSupport: { supported: true },
  current: { model: 'gpt-live', effort: 'medium', serviceTier: STANDARD.value }
}

const FAST_SAVED: AgentSessionOptionsResult = {
  ...LISTED,
  current: { ...LISTED.current, serviceTier: FAST.value },
  speed: {
    selection: { tierId: FAST.value, state: 'ready' },
    lastRequest: { clientMessageId: 'm1', tierId: FAST.value, state: 'accepted' }
  }
}
const ULTRA_SAVED: AgentSessionOptionsResult = {
  ...LISTED,
  current: { ...LISTED.current, serviceTier: ULTRA.value },
  speed: { selection: { tierId: ULTRA.value, state: 'ready' } }
}
// Another host's chat: a different model and tier, so a stale answer is told apart from the current.
const OTHER_SAVED: AgentSessionOptionsResult = {
  models: [
    {
      id: 'gpt-other',
      label: 'GPT Other',
      isDefault: true,
      defaultEffort: 'low',
      efforts: [{ value: 'low', label: 'Low' }],
      supportsFastMode: true,
      serviceTiers: [STANDARD, OTHER]
    }
  ],
  fastModeSupport: { supported: true },
  current: { model: 'gpt-other', effort: 'low', serviceTier: OTHER.value },
  speed: { selection: { tierId: OTHER.value, state: 'ready' } }
}

const FAST_LINES: CodexSpeedLine[] = [
  { kind: 'stored', label: 'Fast' },
  { kind: 'last-request', outcome: 'accepted', label: 'Fast' },
  { kind: 'processing' }
]
const ULTRA_LINES: CodexSpeedLine[] = [
  { kind: 'stored', label: 'Ultrafast' },
  { kind: 'processing' }
]
const OTHER_LINES: CodexSpeedLine[] = [
  { kind: 'stored', label: 'Other' },
  { kind: 'processing' }
]

type Held<T> = { params: unknown; resolve: (value: T) => void; reject: (error: Error) => void }

/** A host whose reads answer at once from `script`, or wait for the test while it holds null. */
function scriptedHost() {
  const script: {
    options: AgentSessionOptionsResult | null
    catalog: AgentSessionModelCatalogResult | null
  } = { options: null, catalog: null }
  const options: Held<AgentSessionOptionsResult>[] = []
  const catalogs: Held<AgentSessionModelCatalogResult>[] = []

  function read<T>(reply: T | null, queue: Held<T>[], params: unknown): Promise<T> {
    if (reply !== null) {
      return Promise.resolve(reply)
    }
    return new Promise<T>((resolve, reject) => {
      queue.push({ params, resolve, reject })
    })
  }

  const client: RpcClient = {
    sendRequest: async (method: string, params?: unknown) => {
      let result: unknown = {}
      if (method === 'agentSession.options') {
        result = await read(script.options, options, params)
      } else if (method === 'agentSession.modelCatalog') {
        result = await read(script.catalog, catalogs, params)
      }
      return { id: 'rpc-1', ok: true as const, result, _meta: { runtimeId: 'runtime-1' } }
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
  return { client, script, options, catalogs }
}

type ScriptedHost = ReturnType<typeof scriptedHost>

function answered(
  reply: AgentSessionOptionsResult,
  catalog: AgentSessionModelCatalogResult | null = { origin: 'unknown' }
): ScriptedHost {
  const host = scriptedHost()
  host.script.options = reply
  host.script.catalog = catalog
  return host
}

type WriteResult = StructuredAgentSessionMutationResult<AgentSessionOptionResult>

function recordingMutate(next: () => Promise<WriteResult>) {
  const calls: { method: string; fields: Record<string, unknown> }[] = []
  const mock = vi.fn()
  mock.mockImplementation(
    (method: string, _fingerprintMethod: string, fields: Record<string, unknown>) => {
      calls.push({ method, fields })
      return next()
    }
  )
  const mutate: StructuredAgentSessionMutate = mock
  return { calls, mutate }
}

const unansweredMutate = () => recordingMutate(async () => ({ status: 'unknown' }))

async function settle() {
  await act(async () => {
    for (let tick = 0; tick < 10; tick += 1) {
      await Promise.resolve()
    }
  })
}

async function mountHook<TProps, TResult>(useHook: (props: TProps) => TResult, initial: TProps) {
  let props = initial
  let latest: { value: TResult } | null = null
  function Component(args: { hookProps: TProps }): null {
    latest = { value: useHook(args.hookProps) }
    return null
  }
  let renderer: ReactTestRenderer | null = null
  await act(async () => {
    renderer = create(createElement(Component, { hookProps: props }))
  })
  await settle()
  return {
    current: (): TResult => {
      if (!latest) {
        throw new Error('hook never rendered')
      }
      return latest.value
    },
    rerender: async (patch: Partial<TProps>) => {
      props = { ...props, ...patch }
      await act(async () => {
        renderer?.update(createElement(Component, { hookProps: props }))
      })
      await settle()
    },
    unmount: async () => {
      await act(async () => renderer?.unmount())
    }
  }
}

type OptionsProps = {
  client: RpcClient
  mutate: StructuredAgentSessionMutate
  codexSpeedHost?: CodexSpeedHostSupport
  codexSpeedHostPhase?: Phase
  sourceIdentity?: string
  turnId?: string
}
type Controller = ReturnType<typeof useMobileStructuredAgentOptions>

function useOptionsProbe(props: OptionsProps): Controller {
  // The phase is a client-only argument the hook does not type yet; a spread keeps the call valid.
  const phaseArgs = props.codexSpeedHostPhase
    ? { codexSpeedHostPhase: props.codexSpeedHostPhase }
    : {}
  return useMobileStructuredAgentOptions({
    agent: 'codex',
    client: props.client,
    sessionId: 'session-1',
    ...(props.sourceIdentity ? { sourceIdentity: props.sourceIdentity } : {}),
    enabled: true,
    fence: 1,
    turnId: props.turnId ?? null,
    mutate: props.mutate,
    ...(props.codexSpeedHost ? { codexSpeedHost: props.codexSpeedHost } : {}),
    ...phaseArgs
  })
}

const linesOf = (controller: Controller): readonly CodexSpeedLine[] =>
  codexSpeedLinesOfSurface(controller.optionSurface)

const speedDescriptor = (controller: Controller) =>
  controller.optionSnapshot.find((entry) => entry.id === 'serviceTier')

function tierValue(controller: Controller): string | undefined {
  const kind = speedDescriptor(controller)?.kind
  return kind && 'currentValue' in kind ? kind.currentValue : undefined
}

/** A wait is the settled lines plus one more: none of the independent lines is dropped for it. */
function expectExtraLine(lines: readonly CodexSpeedLine[], settled: readonly CodexSpeedLine[]) {
  expect(lines).toEqual(expect.arrayContaining([...settled]))
  expect(lines.length).toBeGreaterThan(settled.length)
}

async function mountSupported(host: ScriptedHost, patch: Partial<OptionsProps> = {}) {
  return mountHook(useOptionsProbe, {
    client: host.client,
    mutate: unansweredMutate().mutate,
    codexSpeedHost: 'supported',
    codexSpeedHostPhase: 'settled',
    ...patch
  })
}

describe('speed support still unresolved', () => {
  it.each([
    ['without a phase', undefined],
    ['while pending', 'pending'],
    ['after failing', 'failed']
  ] as const)('keeps a saved opaque tier visible, disabled and unwritable %s', async (_name, phase) => {
    const { calls, mutate } = unansweredMutate()
    const harness = await mountHook(useOptionsProbe, {
      client: answered(ULTRA_SAVED).client,
      mutate,
      codexSpeedHost: 'unknown',
      ...(phase ? { codexSpeedHostPhase: phase } : {})
    })

    const tier = speedDescriptor(harness.current())
    expect(tier?.kind).toMatchObject({ type: 'select', currentValue: ULTRA.value })
    const choices = tier?.kind.type === 'select' ? tier.kind.choices : []
    expect(choices.find((choice) => choice.value === ULTRA.value)).toMatchObject({ disabled: true })
    let outcome: boolean | null = null
    await act(async () => {
      outcome = await harness.current().setStructuredOption('serviceTier', STANDARD.value)
    })
    expect(outcome).toBe(false)
    expect(calls).toHaveLength(0)
    await harness.unmount()
  })

  it('tells a support wait that is running from one that failed, keeping the saved tier line', async () => {
    const harness = await mountHook(useOptionsProbe, {
      client: answered(ULTRA_SAVED).client,
      mutate: unansweredMutate().mutate,
      codexSpeedHost: 'unknown',
      codexSpeedHostPhase: 'pending'
    })
    const waiting = linesOf(harness.current())
    await harness.rerender({ codexSpeedHostPhase: 'failed' })
    const failed = linesOf(harness.current())

    for (const lines of [waiting, failed]) {
      expect(lines.filter((line) => line.kind === 'stored')).toHaveLength(1)
      expect(lines).toContainEqual({ kind: 'processing' })
      expect(lines.length).toBeGreaterThan(ULTRA_LINES.length)
    }
    expect(failed).not.toEqual(waiting)
    await harness.unmount()
  })

  it('ends the wait once the host affirms support and offers the tier again', async () => {
    const harness = await mountHook(useOptionsProbe, {
      client: answered(ULTRA_SAVED).client,
      mutate: unansweredMutate().mutate,
      codexSpeedHost: 'unknown',
      codexSpeedHostPhase: 'pending'
    })
    expect(linesOf(harness.current()).length).toBeGreaterThan(ULTRA_LINES.length)

    await harness.rerender({ codexSpeedHost: 'supported', codexSpeedHostPhase: 'settled' })

    expect(linesOf(harness.current())).toEqual(ULTRA_LINES)
    const tier = speedDescriptor(harness.current())
    const choices = tier?.kind.type === 'select' ? tier.kind.choices : []
    expect(choices.find((choice) => choice.value === ULTRA.value)?.disabled).toBeFalsy()
    await harness.unmount()
  })

  it('lets a host that proves older replace the retained tier through an explicit Fast control', async () => {
    const { calls, mutate } = recordingMutate(async () => ({
      status: 'accepted',
      value: { key: 'fastMode', value: 'false', options: { model: 'gpt-live', fastMode: 'false' } },
      sameFence: true
    }))
    const harness = await mountHook(useOptionsProbe, {
      client: answered(ULTRA_SAVED).client,
      mutate,
      codexSpeedHost: 'unknown',
      codexSpeedHostPhase: 'failed'
    })
    expect(tierValue(harness.current())).toBe(ULTRA.value)

    await harness.rerender({ codexSpeedHost: 'unsupported', codexSpeedHostPhase: 'settled' })

    const fast = harness.current().optionSnapshot.find((entry) => entry.id === 'fastMode')
    expect(fast?.settable).toBe(true)
    let outcome: boolean | null = null
    await act(async () => {
      outcome = await harness.current().setStructuredOption('fastMode', false)
    })
    expect(outcome).toBe(true)
    expect(calls[0]).toEqual({
      method: 'agentSession.setOption',
      fields: { key: 'fastMode', value: 'false' }
    })
    await harness.unmount()
  })
})

describe('waits on a confirmed host', () => {
  it('shows nothing extra for a settled phase or for a caller that passes none', async () => {
    const withPhase = await mountSupported(answered(FAST_SAVED))
    const withoutPhase = await mountHook(useOptionsProbe, {
      client: answered(FAST_SAVED).client,
      mutate: unansweredMutate().mutate,
      codexSpeedHost: 'supported'
    })

    expect(linesOf(withPhase.current())).toEqual(FAST_LINES)
    expect(linesOf(withoutPhase.current())).toEqual(FAST_LINES)
    await withPhase.unmount()
    await withoutPhase.unmount()
  })

  it('shows an options read that is running, then its answer, then its failure', async () => {
    const host = answered(FAST_SAVED)
    const harness = await mountSupported(host)
    expect(linesOf(harness.current())).toEqual(FAST_LINES)

    host.script.options = null
    await harness.rerender({ turnId: 'turn-1' })
    expect(host.options).toHaveLength(1)
    const waiting = linesOf(harness.current())
    expectExtraLine(waiting, FAST_LINES)

    await act(async () => host.options[0]!.resolve(FAST_SAVED))
    await settle()
    expect(linesOf(harness.current())).toEqual(FAST_LINES)

    await harness.rerender({ turnId: 'turn-2' })
    expect(host.options).toHaveLength(2)
    await act(async () => host.options[1]!.reject(new Error('options_read_failed')))
    await settle()
    // The read failed: it is no longer waited on, and what it would have said stays unknown.
    const failed = linesOf(harness.current())
    expectExtraLine(failed, FAST_LINES)
    expect(failed).not.toEqual(waiting)
    await harness.unmount()
  })

  it('shows a catalog read that is running and settles when it answers', async () => {
    const host = answered(FAST_SAVED, null)
    const harness = await mountSupported(host)
    expect(host.catalogs).toHaveLength(1)
    expectExtraLine(linesOf(harness.current()), FAST_LINES)

    await act(async () => host.catalogs[0]!.resolve({ origin: 'unknown' }))
    await settle()

    expect(linesOf(harness.current())).toEqual(FAST_LINES)
    await harness.unmount()
  })

  it('ends the wait as unknown when the catalog read fails', async () => {
    const host = answered(FAST_SAVED, null)
    const harness = await mountSupported(host)
    const waiting = linesOf(harness.current())
    expectExtraLine(waiting, FAST_LINES)

    await act(async () => host.catalogs[0]!.reject(new Error('catalog_read_failed')))
    await settle()

    const failed = linesOf(harness.current())
    expectExtraLine(failed, FAST_LINES)
    expect(failed).not.toEqual(waiting)
    await harness.unmount()
  })

  it('ends a joined listing wait as unknown when the host fails it', async () => {
    const host = answered(FAST_SAVED, null)
    const harness = await mountSupported(host)
    await act(async () =>
      host.catalogs[0]!.resolve({ origin: 'unknown', listingInProgress: true })
    )
    await settle()
    expect(host.catalogs).toHaveLength(2)
    expect(host.catalogs[1]!.params).toMatchObject({ waitForListing: true })
    const joined = linesOf(harness.current())
    expectExtraLine(joined, FAST_LINES)

    await act(async () => host.catalogs[1]!.reject(new Error('listing_wait_failed')))
    await settle()

    const failed = linesOf(harness.current())
    expectExtraLine(failed, FAST_LINES)
    expect(failed).not.toEqual(joined)
    await harness.unmount()
  })
})

const kindsOf = (lines: readonly CodexSpeedLine[]): readonly string[] =>
  lines.map((line) => line.kind)

async function finishRead(
  host: ScriptedHost,
  read: 'options' | 'catalog',
  outcome: 'answers' | 'fails'
) {
  await act(async () => {
    if (read === 'options') {
      const held = host.options[0]!
      if (outcome === 'answers') {
        held.resolve(FAST_SAVED)
      } else {
        held.reject(new Error('options_read_failed'))
      }
    } else {
      const held = host.catalogs[0]!
      if (outcome === 'answers') {
        held.resolve({ origin: 'unknown' })
      } else {
        held.reject(new Error('catalog_read_failed'))
      }
    }
  })
  await settle()
}

// Both reads are in flight at once. One finishing, either way, is not the wait being over.
describe('options and catalog reads overlapping', () => {
  it.each([
    ['options', 'answers'],
    ['catalog', 'answers'],
    ['options', 'fails'],
    ['catalog', 'fails']
  ] as const)(
    'keeps loading when the %s read %s first, until the other read answers',
    async (first, outcome) => {
      const host = scriptedHost()
      const harness = await mountSupported(host)
      expect(host.options).toHaveLength(1)
      expect(host.catalogs).toHaveLength(1)
      expect(kindsOf(linesOf(harness.current()))).toContain('loading')

      await finishRead(host, first, outcome)
      const midway = kindsOf(linesOf(harness.current()))
      expect(midway).toContain('loading')
      // A failure is reported only once nothing is waited on any more.
      expect(midway).not.toContain('support-unverified')

      await finishRead(host, first === 'options' ? 'catalog' : 'options', 'answers')
      const settled = linesOf(harness.current())
      expect(kindsOf(settled)).not.toContain('loading')
      if (outcome === 'answers') {
        expect(settled).toEqual(FAST_LINES)
        expect(kindsOf(settled)).not.toContain('support-unverified')
      } else {
        expect(kindsOf(settled)).toContain('support-unverified')
        if (first === 'catalog') {
          // The options answered, so the stored and requested lines stay beside the failure.
          expect(settled).toEqual(expect.arrayContaining([...FAST_LINES]))
        }
      }
      await harness.unmount()
    }
  )
})

// The previous generation (another client, or another source on the same client) still has a read
// in flight when the view moves on. Whatever it answers is not the current view's phase or intent.
describe('a previous generation answering late', () => {
  it.each([
    ['client', 'rejects'],
    ['client', 'answers'],
    ['source', 'rejects'],
    ['source', 'answers']
  ] as const)('after a %s swap, a read that %s changes neither phase nor tier', async (swap, outcome) => {
    const previous = answered(FAST_SAVED)
    const harness = await mountSupported(previous)
    expect(linesOf(harness.current())).toEqual(FAST_LINES)
    previous.script.options = null
    await harness.rerender({ turnId: 'turn-1' })
    const late = previous.options[0]!

    // The new generation's options landed; its catalog read is still running.
    let current = previous
    if (swap === 'client') {
      current = answered(OTHER_SAVED, null)
      await harness.rerender({ client: current.client })
    } else {
      previous.script.options = OTHER_SAVED
      previous.script.catalog = null
      await harness.rerender({ sourceIdentity: 'other-source' })
    }
    expect(current.catalogs).toHaveLength(1)
    expect(tierValue(harness.current())).toBe(OTHER.value)
    const waiting = linesOf(harness.current())
    expectExtraLine(waiting, OTHER_LINES)

    await act(async () => {
      if (outcome === 'rejects') {
        late.reject(new Error('previous_generation_failed'))
      } else {
        late.resolve(FAST_SAVED)
      }
    })
    await settle()

    expect(tierValue(harness.current())).toBe(OTHER.value)
    expect(linesOf(harness.current())).toEqual(waiting)

    await act(async () => current.catalogs[0]!.resolve({ origin: 'unknown' }))
    await settle()
    expect(linesOf(harness.current())).toEqual(OTHER_LINES)
    await harness.unmount()
  })
})

// The session hook is the one parent that hands the options hook its host support: the phase it is
// given beside that support must reach the same speed lines.
describe('useMobileStructuredAgentSession host support phase', () => {
  const onSendError = vi.fn()
  const SUPPORTED = structuredAgentSessionHostSupport([
    AGENT_SESSION_CODEX_SERVICE_TIERS_RUNTIME_CAPABILITY
  ])

  function useSessionProbe(props: { client: RpcClient; hostSupportPhase?: Phase }) {
    const phaseArgs = props.hostSupportPhase ? { hostSupportPhase: props.hostSupportPhase } : {}
    return useMobileStructuredAgentSession({
      client: props.client,
      sessionId: 'session-1',
      sourceIdentity: 'host-a\0workspace-a',
      enabled: true,
      connected: true,
      hostSupport: SUPPORTED,
      agent: 'codex',
      onSendError,
      ...phaseArgs
    })
  }

  it('reaches the options hook as the phase of the speed lines, and ends with it', async () => {
    const harness = await mountHook(useSessionProbe, {
      client: answered(FAST_SAVED).client,
      hostSupportPhase: 'pending'
    })
    const lines = () => codexSpeedLinesOfSurface(harness.current().optionSurface)

    expectExtraLine(lines(), FAST_LINES)
    await harness.rerender({ hostSupportPhase: 'settled' })
    expect(lines()).toEqual(FAST_LINES)
    await harness.unmount()
  })
})
