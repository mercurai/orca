import { describe, expect, it } from 'vitest'
import { CODEX_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-claude-codex'
import type { AgentSessionSpeedFacts } from './agent-session-speed-facts'
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
      structuredAgentSessionSpeedBlocked({ speed: facts({ legacyFastMode: true, state: 'unknown' }) })
    ).toBe(true)
    expect(
      structuredAgentSessionSpeedBlocked({ speed: facts({ tierId: FAST.value, state: 'ready' }) })
    ).toBe(false)
    expect(structuredAgentSessionSpeedBlocked({ speed: facts({ state: 'unselected' }) })).toBe(false)
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
    expect(settled.speed).toBeUndefined()
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
