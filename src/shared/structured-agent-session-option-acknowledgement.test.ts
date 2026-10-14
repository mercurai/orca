import { describe, expect, it } from 'vitest'
import { CODEX_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-claude-codex'
import type { AgentSessionSpeedFacts } from './agent-session-speed-facts'
import { codexSpeedLines } from './codex-speed-facts-presentation'
import { readCodexServiceTierOptions } from './codex-service-tier-selection'
import {
  acknowledgeStructuredAgentSessionAction,
  acknowledgedStructuredAgentSessionOptions,
  isStructuredAgentSessionSpeedOption,
  requestStructuredAgentSessionSpeed,
  settleStructuredAgentSessionSpeedRequest,
  structuredAgentSessionHeldWithRequested,
  structuredAgentSessionRequestConfirmed,
  structuredAgentSessionSpeedBlocked,
  withoutStructuredAgentSessionSpeedRequest
} from './structured-agent-session-option-acknowledgement'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot,
  type StructuredAgentSessionOptionState
} from './structured-agent-session-options'

const MODEL_ID = 'synthetic-speed-model'
const FAST = { value: 'synthetic-fast-lane', label: 'Fast' }
const ULTRAFAST = { value: 'synthetic-ultra-lane', label: 'Ultrafast' }

function liveState(
  current: { serviceTier?: string; fastMode?: boolean } = {},
  agent: Parameters<typeof createStructuredAgentSessionOptionState>[0] = 'codex'
): StructuredAgentSessionOptionState {
  const confirmed = [
    'model',
    ...(current.serviceTier ? ['serviceTier'] : []),
    ...(current.fastMode !== undefined ? ['fastMode'] : [])
  ]
  return applyStructuredAgentSessionOptions(
    createStructuredAgentSessionOptionState(agent),
    CODEX_SESSION_OPTION_CATALOG,
    {
      models: [
        {
          id: MODEL_ID,
          label: 'Synthetic Speed Model',
          isDefault: true,
          efforts: [],
          supportsFastMode: true,
          serviceTiers: [{ value: 'default', label: 'Standard' }, FAST, ULTRAFAST]
        }
      ],
      fastModeSupport: { supported: true },
      current: { model: MODEL_ID, confirmed, ...current }
    },
    'supported'
  )
}

describe('speed requests', () => {
  it('names only Codex speed controls as speed actions', () => {
    expect(isStructuredAgentSessionSpeedOption('codex', 'serviceTier')).toBe(true)
    expect(isStructuredAgentSessionSpeedOption('codex', 'fastMode')).toBe(true)
    expect(isStructuredAgentSessionSpeedOption('codex', 'effort')).toBe(false)
    expect(isStructuredAgentSessionSpeedOption('claude', 'fastMode')).toBe(false)
  })

  it('holds a speed request apart from the stored selection and blocks sends', () => {
    const state = liveState({ serviceTier: FAST.value })

    const requested = requestStructuredAgentSessionSpeed(state, 'serviceTier', ULTRAFAST.value)

    expect(requested.requested).toEqual({ id: 'serviceTier', value: ULTRAFAST.value })
    expect(state.record.valuesByModel[MODEL_ID]?.serviceTier?.value).toBe(FAST.value)
    expect(structuredAgentSessionSpeedBlocked(requested)).toBe(true)
    expect(structuredAgentSessionHeldWithRequested({}, requested)).toEqual({
      serviceTier: ULTRAFAST.value
    })
  })

  it('makes no request of an option that is not a Codex speed control', () => {
    const state = liveState({ serviceTier: FAST.value })

    expect(requestStructuredAgentSessionSpeed(state, 'effort', 'high')).toBe(state)
    const claude = liveState({ fastMode: false }, 'claude')
    expect(requestStructuredAgentSessionSpeed(claude, 'fastMode', 'true')).toBe(claude)
  })

  it('keeps the request through a read that does not store it, and ends it when the host does', () => {
    const requested = requestStructuredAgentSessionSpeed(
      liveState({ serviceTier: FAST.value }),
      'serviceTier',
      ULTRAFAST.value
    )
    const result = (serviceTier: string) => ({
      models: [
        {
          id: MODEL_ID,
          label: 'Synthetic Speed Model',
          isDefault: true,
          efforts: [],
          serviceTiers: [{ value: 'default', label: 'Standard' }, FAST, ULTRAFAST]
        }
      ],
      current: { model: MODEL_ID, serviceTier, confirmed: ['model', 'serviceTier'] }
    })

    const stillFast = applyStructuredAgentSessionOptions(
      requested,
      CODEX_SESSION_OPTION_CATALOG,
      result(FAST.value),
      'supported'
    )
    expect(stillFast.requested).toEqual(requested.requested)

    const stored = applyStructuredAgentSessionOptions(
      requested,
      CODEX_SESSION_OPTION_CATALOG,
      result(ULTRAFAST.value),
      'supported'
    )
    expect(stored.requested).toBeUndefined()
  })

  it('does not end a request on a read while its write is still in flight', () => {
    const request = { id: 'serviceTier', value: ULTRAFAST.value }
    const inFlight: StructuredAgentSessionOptionState = {
      ...liveState(),
      requested: request,
      pendingId: 'serviceTier'
    }

    expect(
      structuredAgentSessionRequestConfirmed(request, {
        model: MODEL_ID,
        serviceTier: ULTRAFAST.value,
        confirmed: ['serviceTier']
      })
    ).toBe(true)
    const read = applyStructuredAgentSessionOptions(
      inFlight,
      CODEX_SESSION_OPTION_CATALOG,
      {
        models: [{ id: MODEL_ID, label: 'Synthetic', efforts: [] }],
        current: { model: MODEL_ID, serviceTier: ULTRAFAST.value, confirmed: ['serviceTier'] }
      },
      'supported'
    )
    expect(read.requested).toEqual(request)
  })

  it('blocks sends for a requested tier the host facts name as unsendable, and for no other', () => {
    const facts = (selection: AgentSessionSpeedFacts['selection']): AgentSessionSpeedFacts => ({
      selection
    })
    const state = liveState()

    expect(
      structuredAgentSessionSpeedBlocked({
        speed: facts({ tierId: 'custom', state: 'unavailable' })
      })
    ).toBe(true)
    expect(
      structuredAgentSessionSpeedBlocked({
        speed: facts({ legacyFastMode: true, state: 'unknown' })
      })
    ).toBe(true)
    expect(
      structuredAgentSessionSpeedBlocked({ speed: facts({ tierId: FAST.value, state: 'ready' }) })
    ).toBe(false)
    expect(structuredAgentSessionSpeedBlocked({ speed: facts({ state: 'unselected' }) })).toBe(
      false
    )
    expect(structuredAgentSessionSpeedBlocked(state)).toBe(false)
  })

  it('ends the request and the refusal facts only on an accepted replacement', () => {
    const state: StructuredAgentSessionOptionState = {
      ...requestStructuredAgentSessionSpeed(liveState(), 'serviceTier', ULTRAFAST.value),
      speed: { selection: { tierId: ULTRAFAST.value, state: 'unavailable' } }
    }

    const dropped = withoutStructuredAgentSessionSpeedRequest(state)
    expect(dropped.requested).toBeUndefined()
    expect(dropped.speed).toBeDefined()

    const settled = settleStructuredAgentSessionSpeedRequest(state)
    expect(settled.requested).toBeUndefined()
    // The refusal's own facts end with the request; earlier turn evidence is kept (see below).
    expect(settled.speed?.selection).not.toMatchObject({
      tierId: ULTRAFAST.value,
      state: 'unavailable'
    })
    expect(structuredAgentSessionSpeedBlocked(settled)).toBe(false)
  })

  it('settles a speed action when its acknowledgement is committed, and no other', () => {
    const requested = requestStructuredAgentSessionSpeed(liveState(), 'serviceTier', FAST.value)

    const speed = acknowledgeStructuredAgentSessionAction(requested, 'serviceTier', {
      serviceTier: FAST.value
    })
    expect(speed.requested).toBeUndefined()
    expect(speed.record.valuesByModel[MODEL_ID]?.serviceTier?.value).toBe(FAST.value)

    const effort = acknowledgeStructuredAgentSessionAction(requested, 'effort', {})
    expect(effort.requested).toEqual(requested.requested)
  })
})

describe('acknowledgedStructuredAgentSessionOptions', () => {
  it('falls back to the action itself when the host names no options', () => {
    expect(
      acknowledgedStructuredAgentSessionOptions({ id: 'serviceTier', value: FAST.value }, undefined)
    ).toEqual({ serviceTier: FAST.value })
  })

  it('drops the saved tier an older host echoes beside an explicit Fast toggle', () => {
    expect(
      acknowledgedStructuredAgentSessionOptions(
        { id: 'fastMode', value: 'false' },
        { model: MODEL_ID, serviceTier: ULTRAFAST.value, fastMode: 'false' }
      )
    ).toEqual({ model: MODEL_ID, fastMode: 'false' })
  })

  it('keeps the exact tier a mapping host answers for a toggle alone', () => {
    expect(
      acknowledgedStructuredAgentSessionOptions(
        { id: 'fastMode', value: 'false' },
        { model: MODEL_ID, serviceTier: 'standard-lane' }
      )
    ).toEqual({ model: MODEL_ID, serviceTier: 'standard-lane' })
  })

  it('leaves a canonical action acknowledgement as the host sent it', () => {
    expect(
      acknowledgedStructuredAgentSessionOptions(
        { id: 'serviceTier', value: FAST.value },
        { serviceTier: FAST.value, fastMode: 'true' }
      )
    ).toEqual({ serviceTier: FAST.value, fastMode: 'true' })
  })
})

// What the host observed of the last turn is evidence about that turn: a new accepted choice is
// next-turn intent and replaces none of it until a positive read says so.
describe('speed evidence across an accepted action', () => {
  const PRIOR_TURN = {
    lastRequest: {
      clientMessageId: 'turn-1-message',
      tierId: FAST.value,
      turnId: 'turn-1',
      state: 'accepted' as const
    },
    applied: { clientMessageId: 'turn-1-message', tierId: FAST.value, turnId: 'turn-1' },
    processing: { turnId: 'turn-1', tierId: FAST.value }
  }

  function afterAcceptedUltrafast(): StructuredAgentSessionOptionState {
    const prior: StructuredAgentSessionOptionState = {
      ...liveState({ serviceTier: FAST.value }),
      speed: { selection: { tierId: FAST.value, state: 'ready' }, ...PRIOR_TURN }
    }
    return acknowledgeStructuredAgentSessionAction(
      requestStructuredAgentSessionSpeed(prior, 'serviceTier', ULTRAFAST.value),
      'serviceTier',
      { serviceTier: ULTRAFAST.value }
    )
  }

  it('keeps the prior turn request, applied and processing facts verbatim', () => {
    const settled = afterAcceptedUltrafast()

    expect(settled.requested).toBeUndefined()
    expect(settled.speed?.lastRequest).toEqual(PRIOR_TURN.lastRequest)
    expect(settled.speed?.applied).toEqual(PRIOR_TURN.applied)
    expect(settled.speed?.processing).toEqual(PRIOR_TURN.processing)
    // Neither the old stored claim nor a blocked one survives as the next-turn selection.
    expect([undefined, ULTRAFAST.value]).toContain(settled.speed?.selection.tierId)
    expect(['ready', 'unselected']).toContain(settled.speed?.selection.state)
    expect(structuredAgentSessionSpeedBlocked(settled)).toBe(false)
  })

  it('selects the new tier for the next turn without claiming it for the running one', () => {
    const settled = afterAcceptedUltrafast()
    const speed = structuredAgentSessionOptionSnapshot(settled).find(
      (entry) => entry.id === 'serviceTier'
    )

    expect(settled.record.valuesByModel[MODEL_ID]?.serviceTier?.value).toBe(ULTRAFAST.value)
    expect(codexSpeedLines(speed, settled.speed)).toEqual([
      { kind: 'pending', label: 'Ultrafast' },
      { kind: 'last-request', outcome: 'accepted', label: 'Fast' },
      { kind: 'processing', label: 'Fast' }
    ])
  })

  it('keeps an unreported processing tier unknown rather than inventing one', () => {
    const { processing: _processing, ...withoutProcessing } = PRIOR_TURN
    const prior: StructuredAgentSessionOptionState = {
      ...liveState({ serviceTier: FAST.value }),
      speed: { selection: { tierId: FAST.value, state: 'ready' }, ...withoutProcessing }
    }

    const settled = acknowledgeStructuredAgentSessionAction(
      requestStructuredAgentSessionSpeed(prior, 'serviceTier', ULTRAFAST.value),
      'serviceTier',
      { serviceTier: ULTRAFAST.value }
    )

    expect(settled.speed?.processing).toBeUndefined()
    expect(settled.speed?.applied).toEqual(PRIOR_TURN.applied)
  })
})

// B's live catalog and C's resting read both report the stored canonical tier in `current` and
// name no `confirmed` list for it. The host's own selection fact then has to carry the proof.
describe('a read that stores the request but omits the confirmed list', () => {
  const MODELS = [
    {
      id: MODEL_ID,
      label: 'Synthetic Speed Model',
      isDefault: true,
      efforts: [],
      serviceTiers: [{ value: 'default', label: 'Standard' }, FAST, ULTRAFAST]
    }
  ]

  /** The shape the provider's reader produces: its `current` and `speed`, no `confirmed`. */
  function hostRead(options: Record<string, string>) {
    const read = readCodexServiceTierOptions({
      options,
      models: MODELS,
      currentModel: MODEL_ID,
      catalogKnown: true
    })
    return { models: MODELS, current: { model: MODEL_ID, ...read.current }, speed: read.speed }
  }

  const requestUltrafast = () =>
    requestStructuredAgentSessionSpeed(
      liveState({ serviceTier: FAST.value }),
      'serviceTier',
      ULTRAFAST.value
    )

  const applyRead = (
    state: StructuredAgentSessionOptionState,
    result: ReturnType<typeof hostRead>
  ) => applyStructuredAgentSessionOptions(state, CODEX_SESSION_OPTION_CATALOG, result, 'supported')

  it('reports the stored canonical tier with no confirmed list at all', () => {
    const read = hostRead({ model: MODEL_ID, serviceTier: ULTRAFAST.value })

    expect(read.current.serviceTier).toBe(ULTRAFAST.value)
    expect(read.speed.selection).toEqual({ tierId: ULTRAFAST.value, state: 'ready' })
    expect('confirmed' in read.current).toBe(false)
  })

  it('releases a request the host stored when its own ready selection names exactly it', () => {
    const applied = applyRead(
      requestUltrafast(),
      hostRead({ model: MODEL_ID, serviceTier: ULTRAFAST.value })
    )

    expect(applied.requested).toBeUndefined()
    expect(structuredAgentSessionSpeedBlocked(applied)).toBe(false)
    expect(applied.record.valuesByModel[MODEL_ID]?.serviceTier?.value).toBe(ULTRAFAST.value)
    // The host stored it and said so through its own selection: reported, not a pending pick.
    const tier = structuredAgentSessionOptionSnapshot(applied).find(
      (entry) => entry.id === 'serviceTier'
    )
    expect(tier?.valueSource).toBe('reported')
    expect(codexSpeedLines(tier, applied.speed)[0]).toEqual({ kind: 'stored', label: 'Ultrafast' })
  })

  it('keeps a request the host stored a different tier than', () => {
    const request = requestUltrafast()

    const applied = applyRead(request, hostRead({ model: MODEL_ID, serviceTier: FAST.value }))

    expect(applied.requested).toEqual(request.requested)
    expect(structuredAgentSessionSpeedBlocked(applied)).toBe(true)
  })

  it.each<{ name: string; selection: AgentSessionSpeedFacts['selection'] }>([
    {
      name: 'names another tier as blocked',
      selection: { tierId: 'retired-lane', state: 'unavailable' }
    },
    {
      name: 'cannot verify the same tier',
      selection: { tierId: FAST.value, state: 'unknown' }
    },
    {
      name: 'finds the same tier unavailable',
      selection: { tierId: FAST.value, state: 'unavailable' }
    }
  ])(
    'never releases a request when the host selection $name, even beside the same canonical tier',
    ({ selection }) => {
      const request = requestStructuredAgentSessionSpeed(
        liveState({ serviceTier: FAST.value }),
        'serviceTier',
        FAST.value
      )
      const read = {
        ...hostRead({ model: MODEL_ID, serviceTier: FAST.value }),
        speed: { selection }
      }

      const applied = applyRead(request, read)

      expect(applied.requested).toEqual(request.requested)
      expect(structuredAgentSessionSpeedBlocked(applied)).toBe(true)
    }
  )

  it('keeps the request while its own write is still in flight', () => {
    const inFlight: StructuredAgentSessionOptionState = {
      ...requestUltrafast(),
      pendingId: 'serviceTier'
    }

    const applied = applyRead(inFlight, hostRead({ model: MODEL_ID, serviceTier: ULTRAFAST.value }))

    expect(applied.requested).toEqual(inFlight.requested)
  })

  it('leaves an older provider that confirms the tier by name releasing it as before', () => {
    const applied = applyStructuredAgentSessionOptions(
      requestUltrafast(),
      CODEX_SESSION_OPTION_CATALOG,
      {
        models: MODELS,
        current: { model: MODEL_ID, serviceTier: ULTRAFAST.value, confirmed: ['serviceTier'] }
      },
      'supported'
    )

    expect(applied.requested).toBeUndefined()
  })
})

// B's refusal read and C's resting read keep the accepted canonical tier as `current` and report
// the refused pick only as the blocked selection beside it, still with no `confirmed` list. The
// accepted tier is then the host's stored one; the blocked request is a separate claim and stays
// held. Provenance and admission differ: only a ready selection naming the request releases it.
describe('a refusal read that keeps the accepted tier beside a blocked request', () => {
  const CUSTOM = 'synthetic-custom-lane'
  const MODELS = [
    {
      id: MODEL_ID,
      label: 'Synthetic Speed Model',
      isDefault: true,
      efforts: [],
      serviceTiers: [{ value: 'default', label: 'Standard' }, FAST, ULTRAFAST]
    }
  ]
  const HOST_EVIDENCE = {
    lastRequest: {
      clientMessageId: 'turn-1-message',
      tierId: FAST.value,
      turnId: 'turn-1',
      state: 'accepted' as const
    },
    applied: { clientMessageId: 'turn-1-message', tierId: FAST.value, turnId: 'turn-1' },
    processing: { turnId: 'turn-1', tierId: FAST.value }
  }

  /** The reader's own `current` for a stored tier, then the additive selection of what it refused. */
  function refusalRead(
    storedTier: string,
    selection?: AgentSessionSpeedFacts['selection']
  ): {
    models: typeof MODELS
    current: ReturnType<typeof readCodexServiceTierOptions>['current'] & { model: string }
    speed: AgentSessionSpeedFacts
  } {
    const stored = readCodexServiceTierOptions({
      options: { model: MODEL_ID, serviceTier: storedTier },
      models: MODELS,
      currentModel: MODEL_ID,
      catalogKnown: true
    })
    return {
      models: MODELS,
      current: { model: MODEL_ID, ...stored.current },
      speed: { ...stored.speed, ...HOST_EVIDENCE, ...(selection ? { selection } : {}) }
    }
  }

  const applyRead = (
    state: StructuredAgentSessionOptionState,
    read: ReturnType<typeof refusalRead>
  ) => applyStructuredAgentSessionOptions(state, CODEX_SESSION_OPTION_CATALOG, read, 'supported')

  const storedTierOf = (state: StructuredAgentSessionOptionState) =>
    state.record.valuesByModel[MODEL_ID]?.serviceTier

  const BLOCKED: {
    name: string
    selection: AgentSessionSpeedFacts['selection']
    request: { id: string; value: string }
  }[] = [
    {
      name: 'an unavailable requested tier',
      selection: { tierId: CUSTOM, state: 'unavailable' },
      request: { id: 'serviceTier', value: CUSTOM }
    },
    {
      name: 'a requested tier it cannot verify',
      selection: { tierId: CUSTOM, state: 'unknown' },
      request: { id: 'serviceTier', value: CUSTOM }
    },
    {
      name: 'unresolved legacy Fast',
      selection: { legacyFastMode: true, state: 'unknown' },
      request: { id: 'fastMode', value: 'true' }
    }
  ]

  it.each(BLOCKED)(
    'records the accepted tier as stored beside $name and keeps the request blocked',
    ({ selection, request }) => {
      const held = requestStructuredAgentSessionSpeed(liveState(), request.id, request.value)
      const read = refusalRead(FAST.value, selection)
      expect('confirmed' in read.current).toBe(false)

      const applied = applyRead(held, read)

      expect(storedTierOf(applied)).toEqual({ value: FAST.value, source: 'reported' })
      const tier = structuredAgentSessionOptionSnapshot(applied).find(
        (entry) => entry.id === 'serviceTier'
      )
      expect(tier?.valueSource).toBe('reported')
      const lines = codexSpeedLines(tier, applied.speed)
      expect(lines[0]).toEqual({ kind: 'stored', label: 'Fast' })
      expect(lines.filter((line) => line.kind === 'requested')).toHaveLength(1)
      expect(applied.requested).toEqual(held.requested)
      expect(structuredAgentSessionSpeedBlocked(applied)).toBe(true)
      // What the host observed of earlier turns is the read's own and stays whole.
      expect(applied.speed).toEqual(read.speed)
      expect(applied.speed?.lastRequest).toEqual(HOST_EVIDENCE.lastRequest)
      expect(applied.speed?.applied).toEqual(HOST_EVIDENCE.applied)
      expect(applied.speed?.processing).toEqual(HOST_EVIDENCE.processing)
    }
  )

  it('keeps the blocked request through a later read that stores another tier', () => {
    const held = requestStructuredAgentSessionSpeed(liveState(), 'serviceTier', CUSTOM)
    const refused = applyRead(
      held,
      refusalRead(FAST.value, { tierId: CUSTOM, state: 'unavailable' })
    )

    const later = applyRead(refused, refusalRead(ULTRAFAST.value))

    expect(storedTierOf(later)).toEqual({ value: ULTRAFAST.value, source: 'reported' })
    expect(later.requested).toEqual(held.requested)
    expect(structuredAgentSessionSpeedBlocked(later)).toBe(true)
  })

  it('still releases a request only on a ready selection that names exactly it', () => {
    const held = requestStructuredAgentSessionSpeed(liveState(), 'serviceTier', ULTRAFAST.value)

    const blocked = applyRead(
      held,
      refusalRead(FAST.value, { tierId: ULTRAFAST.value, state: 'unavailable' })
    )
    expect(blocked.requested).toEqual(held.requested)

    const released = applyRead(blocked, refusalRead(ULTRAFAST.value))
    expect(released.requested).toBeUndefined()
    expect(structuredAgentSessionSpeedBlocked(released)).toBe(false)
  })
})
