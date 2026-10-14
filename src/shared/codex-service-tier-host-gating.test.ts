import { describe, expect, it } from 'vitest'
import {
  CLAUDE_SESSION_OPTION_CATALOG,
  CODEX_SESSION_OPTION_CATALOG
} from './agent-session-option-catalog-claude-codex'
import type { AgentSessionSpeedFacts } from './agent-session-speed-facts'
import type { AgentSessionModelCatalogResult } from './agent-session-wire'
import {
  codexSpeedChoiceStatus,
  codexSpeedDescriptorCaptions,
  type CodexSpeedHostSupport
} from './codex-service-tier-presentation'
import type {
  SessionOptionDescriptor,
  SessionOptionSelectChoice
} from './native-chat-session-options'
import { structuredAgentSessionOptionView } from './structured-agent-session-option-view'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  canSetStructuredAgentSessionOption,
  commitStructuredAgentSessionOption,
  commitStructuredAgentSessionOptionValues,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot,
  type StructuredAgentSessionOptionState
} from './structured-agent-session-options'

const MODEL_ID = 'synthetic-speed-model'
const STANDARD = { value: 'default', label: 'Standard', description: 'Normal speed.' }
const FAST = { value: 'synthetic-fast-lane', label: 'Fast', description: 'Quicker replies.' }
const ULTRAFAST = { value: 'synthetic-ultra-lane', label: 'Ultrafast', description: 'Fastest.' }

type Tier = { value: string; label: string; description: string }

function tieredModel(serviceTiers: readonly Tier[] | undefined, supportsFastMode = false) {
  return {
    id: MODEL_ID,
    label: 'Synthetic Speed Model',
    isDefault: true,
    efforts: [],
    supportsFastMode,
    ...(serviceTiers ? { serviceTiers: [...serviceTiers] } : {})
  }
}

function liveResult(
  model: ReturnType<typeof tieredModel>,
  current: { serviceTier?: string; fastMode?: boolean } = {}
) {
  const confirmed = [
    'model',
    ...(current.serviceTier ? ['serviceTier'] : []),
    ...(current.fastMode !== undefined ? ['fastMode'] : [])
  ]
  return {
    models: [model],
    fastModeSupport: { supported: true },
    current: { model: MODEL_ID, confirmed, ...current }
  }
}

function liveState(
  result: ReturnType<typeof liveResult>,
  host?: CodexSpeedHostSupport,
  agent: Parameters<typeof createStructuredAgentSessionOptionState>[0] = 'codex',
  seed = CODEX_SESSION_OPTION_CATALOG
): StructuredAgentSessionOptionState {
  return applyStructuredAgentSessionOptions(
    createStructuredAgentSessionOptionState(agent),
    seed,
    result,
    host
  )
}

function hostCatalog(model: ReturnType<typeof tieredModel>): AgentSessionModelCatalogResult {
  return { origin: 'probe', models: [model], fetchedAt: 1_000 }
}

function hostState(
  model: ReturnType<typeof tieredModel>,
  host: CodexSpeedHostSupport | undefined
): StructuredAgentSessionOptionState {
  return applyStructuredAgentSessionModelCatalog(
    createStructuredAgentSessionOptionState('codex', CODEX_SESSION_OPTION_CATALOG),
    CODEX_SESSION_OPTION_CATALOG,
    hostCatalog(model),
    { newLaunch: true, ...(host ? { codexSpeedHost: host } : {}) }
  )
}

function descriptorFor(
  state: StructuredAgentSessionOptionState,
  id: string
): SessionOptionDescriptor | undefined {
  return structuredAgentSessionOptionSnapshot(state).find((entry) => entry.id === id)
}

function idsOf(state: StructuredAgentSessionOptionState): string[] {
  return structuredAgentSessionOptionSnapshot(state).map((entry) => entry.id)
}

function choicesOf(descriptor: SessionOptionDescriptor | undefined): SessionOptionSelectChoice[] {
  return descriptor?.kind.type === 'select' ? descriptor.kind.choices : []
}

function currentOf(descriptor: SessionOptionDescriptor | undefined): string | undefined {
  return descriptor?.kind.type === 'select' ? descriptor.kind.currentValue : undefined
}

function offered(descriptor: SessionOptionDescriptor | undefined): string[] {
  return choicesOf(descriptor)
    .filter((choice) => choice.disabled !== true)
    .map((choice) => choice.value)
}

/** The presentation rows for tiers whose support the catalog could not state. */
function unverifiedLabels(descriptor: SessionOptionDescriptor | undefined): string[] {
  return choicesOf(descriptor)
    .filter(
      (choice) =>
        choice.disabled === true && codexSpeedChoiceStatus(descriptor!, choice) === 'unverified'
    )
    .map((choice) => choice.label)
    .filter((label) => label === 'Fast' || label === 'Ultrafast')
}

describe('Codex speed selector gated by the execution host', () => {
  it.each<CodexSpeedHostSupport>(['unsupported', 'unknown'])(
    'keeps the boolean Fast control and drops the tier select when the host is %s',
    (host) => {
      const state = liveState(
        liveResult(tieredModel([STANDARD, FAST, ULTRAFAST], true), { fastMode: false }),
        host
      )

      expect(idsOf(state)).toContain('fastMode')
      expect(idsOf(state)).not.toContain('serviceTier')
      expect(canSetStructuredAgentSessionOption(state, 'fastMode', true)).toBe(true)
      expect(canSetStructuredAgentSessionOption(state, 'serviceTier', FAST.value)).toBe(false)
    }
  )

  it('offers the tier select once the host affirms the capability', () => {
    const result = liveResult(tieredModel([STANDARD, FAST], true), { serviceTier: FAST.value })
    const state = liveState(result, 'supported')

    expect(idsOf(state)).toContain('serviceTier')
    expect(idsOf(state)).not.toContain('fastMode')
    expect(canSetStructuredAgentSessionOption(state, 'serviceTier', FAST.value)).toBe(true)
  })

  it('offers protocol Standard with unverified Fast and Ultrafast when a capable host lists no tiers', () => {
    const state = liveState(liveResult(tieredModel(undefined)), 'supported')
    const tier = descriptorFor(state, 'serviceTier')

    expect(offered(tier)).toEqual(['default'])
    const rows = choicesOf(tier).filter((choice) => choice.disabled === true)
    expect(rows.map((row) => row.label)).toEqual(['Fast', 'Ultrafast'])
    expect(rows.every((row) => codexSpeedChoiceStatus(tier!, row) === 'unverified')).toBe(true)
    expect(codexSpeedDescriptorCaptions(tier!)).toEqual([
      'next-turn',
      'not-chosen',
      'support-unverified'
    ])
    for (const row of rows) {
      expect(canSetStructuredAgentSessionOption(state, 'serviceTier', row.value)).toBe(false)
    }
    expect(canSetStructuredAgentSessionOption(state, 'serviceTier', 'default')).toBe(true)
  })

  it('offers the Standard selector with unverified paid rows, not the toggle, when a capable host lists no tiers for a Fast-capable model', () => {
    const state = liveState(
      liveResult(tieredModel(undefined, true), { fastMode: true }),
      'supported'
    )
    const tier = descriptorFor(state, 'serviceTier')

    expect(idsOf(state)).toContain('serviceTier')
    expect(idsOf(state)).not.toContain('fastMode')
    expect(offered(tier)).toEqual(['default'])
    expect(unverifiedLabels(tier)).toEqual(['Fast', 'Ultrafast'])
    expect(canSetStructuredAgentSessionOption(state, 'fastMode', true)).toBe(false)
    // The saved legacy Fast intent shows on the disabled Fast row, never as Standard.
    const selected = choicesOf(tier).find((choice) => choice.value === currentOf(tier))
    expect(selected).toMatchObject({ label: 'Fast', disabled: true })
    expect(codexSpeedDescriptorCaptions(tier!)).toEqual(
      expect.arrayContaining(['support-unverified', 'selection-blocked'])
    )
  })

  it('offers the same Standard selector from a host listing of a Fast-capable model without tiers', () => {
    const state = hostState(tieredModel(undefined, true), 'supported')
    const view = structuredAgentSessionOptionView(state, { model: MODEL_ID }, {})
    const tier = descriptorFor(view, 'serviceTier')

    expect(idsOf(view)).not.toContain('fastMode')
    expect(offered(tier)).toEqual(['default'])
    expect(unverifiedLabels(tier)).toEqual(['Fast', 'Ultrafast'])
    expect(canSetStructuredAgentSessionOption(view, 'serviceTier', 'default')).toBe(true)
  })

  it.each<CodexSpeedHostSupport>(['unsupported', 'unknown'])(
    'keeps the Fast toggle for a Fast-capable model without tiers only while the host is %s',
    (host) => {
      const state = liveState(liveResult(tieredModel(undefined, true), { fastMode: false }), host)

      expect(idsOf(state)).toContain('fastMode')
      expect(idsOf(state)).not.toContain('serviceTier')
    }
  )

  it('never gives Claude a tier select or a tracked tier, even with tier metadata', () => {
    const result = liveResult(tieredModel([STANDARD, FAST], true), {
      serviceTier: FAST.value,
      fastMode: false
    })
    const claude = liveState(result, 'supported', 'claude', CLAUDE_SESSION_OPTION_CATALOG)

    expect(idsOf(claude)).toContain('fastMode')
    expect(idsOf(claude)).not.toContain('serviceTier')
    expect(claude.record.valuesByModel[MODEL_ID]?.serviceTier).toBeUndefined()

    const fromHost = applyStructuredAgentSessionModelCatalog(
      createStructuredAgentSessionOptionState('claude', CLAUDE_SESSION_OPTION_CATALOG),
      CLAUDE_SESSION_OPTION_CATALOG,
      hostCatalog(tieredModel([STANDARD, FAST], true)),
      { newLaunch: false, codexSpeedHost: 'supported' }
    )
    const options = fromHost.catalog?.models.find((model) => model.id === MODEL_ID)?.options ?? []
    expect(options.map((option) => option.id)).not.toContain('serviceTier')
  })
})

describe('Codex speed selection defaults and legacy intent', () => {
  it('shows no chosen tier for an untouched or model-only draft', () => {
    const state = hostState(tieredModel([STANDARD, FAST]), 'supported')

    // Standard is never displayed as chosen: the configured speed stays unknown.
    const untouched = descriptorFor(
      structuredAgentSessionOptionView(state, undefined, {}),
      'serviceTier'
    )
    expect(currentOf(untouched)).toBeUndefined()
    expect(untouched?.valueSource ?? 'unknown').toBe('unknown')

    const modelOnly = descriptorFor(
      structuredAgentSessionOptionView(state, { model: MODEL_ID }, {}),
      'serviceTier'
    )
    expect(modelOnly).toMatchObject({ valueSource: 'unknown' })
    expect(currentOf(modelOnly)).toBeUndefined()
    expect(codexSpeedDescriptorCaptions(modelOnly!)).toContain('not-chosen')
  })

  it('shows an explicit held pick as dispatched, not as host-confirmed', () => {
    const state = hostState(tieredModel([STANDARD, FAST]), 'supported')
    const view = structuredAgentSessionOptionView(
      state,
      { model: MODEL_ID },
      { serviceTier: FAST.value }
    )

    expect(descriptorFor(view, 'serviceTier')).toMatchObject({ valueSource: 'dispatched' })
    expect(currentOf(descriptorFor(view, 'serviceTier'))).toBe(FAST.value)
    expect(canSetStructuredAgentSessionOption(view, 'serviceTier', FAST.value)).toBe(true)
  })

  it('shows unresolved legacy Fast on the disabled Fast row, never as Standard', () => {
    const state = liveState(liveResult(tieredModel([STANDARD]), { fastMode: true }), 'supported')
    const tier = descriptorFor(state, 'serviceTier')

    const selected = choicesOf(tier).find((choice) => choice.value === currentOf(tier))
    expect(selected).toMatchObject({ label: 'Fast', disabled: true })
    expect(currentOf(tier)).not.toBe('default')
    expect(tier).toMatchObject({ valueSource: 'reported' })
    expect(codexSpeedDescriptorCaptions(tier!)).toContain('selection-blocked')
  })

  it('resolves legacy Fast to the advertised Fast tier and legacy false to Standard', () => {
    const fast = liveState(
      liveResult(tieredModel([STANDARD, FAST]), { fastMode: true }),
      'supported'
    )
    expect(currentOf(descriptorFor(fast, 'serviceTier'))).toBe(FAST.value)

    const standard = liveState(
      liveResult(tieredModel([STANDARD, FAST]), { fastMode: false }),
      'supported'
    )
    expect(currentOf(descriptorFor(standard, 'serviceTier'))).toBe('default')
  })

  it('lets an explicit pick of one speed control replace the other', () => {
    const state = liveState(
      liveResult(tieredModel([STANDARD, FAST], true), { serviceTier: FAST.value, fastMode: true }),
      'supported'
    )
    expect(state.record.valuesByModel[MODEL_ID]?.fastMode).toBeDefined()

    commitStructuredAgentSessionOption(state, 'serviceTier', 'default')
    expect(state.record.valuesByModel[MODEL_ID]?.fastMode).toBeUndefined()

    commitStructuredAgentSessionOption(state, 'fastMode', 'true')
    expect(state.record.valuesByModel[MODEL_ID]?.serviceTier).toBeUndefined()
  })

  it('treats the host boolean beside a canonical tier as its projection, not a second pick', () => {
    const state = liveState(liveResult(tieredModel([STANDARD, FAST], true)), 'supported')

    commitStructuredAgentSessionOptionValues(state, {
      model: MODEL_ID,
      serviceTier: FAST.value,
      fastMode: 'true'
    })

    expect(state.record.valuesByModel[MODEL_ID]?.serviceTier?.value).toBe(FAST.value)
    expect(currentOf(descriptorFor(state, 'serviceTier'))).toBe(FAST.value)
  })
})

describe('Codex speed metadata refresh', () => {
  const live = () =>
    liveState(liveResult(tieredModel([STANDARD, FAST]), { serviceTier: FAST.value }), 'supported')

  it('lets a refreshed host listing add a tier to a live session without changing its selection', () => {
    const refreshed = applyStructuredAgentSessionModelCatalog(
      live(),
      CODEX_SESSION_OPTION_CATALOG,
      hostCatalog(tieredModel([STANDARD, FAST, ULTRAFAST])),
      { newLaunch: false, codexSpeedHost: 'supported' }
    )

    expect(refreshed.catalogSource).toBe('live')
    expect(offered(descriptorFor(refreshed, 'serviceTier'))).toEqual([
      'default',
      FAST.value,
      ULTRAFAST.value
    ])
    expect(currentOf(descriptorFor(refreshed, 'serviceTier'))).toBe(FAST.value)
  })

  it('keeps a requested tier visible but disabled when a refresh withdraws it', () => {
    const requested = commitStructuredAgentSessionOption(
      applyStructuredAgentSessionModelCatalog(
        live(),
        CODEX_SESSION_OPTION_CATALOG,
        hostCatalog(tieredModel([STANDARD, FAST, ULTRAFAST])),
        { newLaunch: false, codexSpeedHost: 'supported' }
      ),
      'serviceTier',
      ULTRAFAST.value
    )

    const refreshed = applyStructuredAgentSessionModelCatalog(
      requested,
      CODEX_SESSION_OPTION_CATALOG,
      hostCatalog(tieredModel([STANDARD, FAST])),
      { newLaunch: false, codexSpeedHost: 'supported' }
    )

    const tier = descriptorFor(refreshed, 'serviceTier')
    expect(currentOf(tier)).toBe(ULTRAFAST.value)
    expect(offered(tier)).toEqual(['default', FAST.value])
    expect(canSetStructuredAgentSessionOption(refreshed, 'serviceTier', ULTRAFAST.value)).toBe(
      false
    )
  })

  it('leaves speed metadata alone when the host has no listing', () => {
    const state = live()
    const refreshed = applyStructuredAgentSessionModelCatalog(
      state,
      CODEX_SESSION_OPTION_CATALOG,
      { origin: 'unknown' },
      { newLaunch: false, codexSpeedHost: 'supported' }
    )

    expect(refreshed).toBe(state)
  })

  it.each([false, true])(
    'withdraws paid choices, keeping the request, when a listing of the same model drops its tiers (supportsFastMode %s)',
    (supportsFastMode) => {
      const refreshed = applyStructuredAgentSessionModelCatalog(
        live(),
        CODEX_SESSION_OPTION_CATALOG,
        hostCatalog(tieredModel(undefined, supportsFastMode)),
        { newLaunch: false, codexSpeedHost: 'supported' }
      )
      const tier = descriptorFor(refreshed, 'serviceTier')

      // Absent metadata is unknown support: the stale Fast row must not stay admissible.
      expect(offered(tier)).toEqual(['default'])
      expect(unverifiedLabels(tier)).toEqual(['Fast', 'Ultrafast'])
      expect(canSetStructuredAgentSessionOption(refreshed, 'serviceTier', FAST.value)).toBe(false)
      expect(canSetStructuredAgentSessionOption(refreshed, 'serviceTier', 'default')).toBe(true)
      // The request is intent, kept apart from what the catalog can back.
      expect(refreshed.record.valuesByModel[MODEL_ID]?.serviceTier?.value).toBe(FAST.value)
      expect(currentOf(tier)).toBe(FAST.value)
      expect(codexSpeedDescriptorCaptions(tier!)).toEqual(
        expect.arrayContaining(['support-unverified', 'selection-blocked'])
      )
    }
  )

  it.each<CodexSpeedHostSupport>(['unsupported', 'unknown'])(
    'restores the Fast toggle and drops every tier choice when the host capability becomes %s',
    (host) => {
      const refreshed = applyStructuredAgentSessionModelCatalog(
        live(),
        CODEX_SESSION_OPTION_CATALOG,
        {
          ...hostCatalog(tieredModel([STANDARD, FAST, ULTRAFAST], true)),
          fastModeSupport: { supported: true }
        },
        { newLaunch: false, codexSpeedHost: host }
      )

      expect(idsOf(refreshed)).toContain('fastMode')
      expect(idsOf(refreshed)).not.toContain('serviceTier')
      expect(canSetStructuredAgentSessionOption(refreshed, 'fastMode', true)).toBe(true)
      expect(canSetStructuredAgentSessionOption(refreshed, 'serviceTier', FAST.value)).toBe(false)
      expect(canSetStructuredAgentSessionOption(refreshed, 'serviceTier', ULTRAFAST.value)).toBe(
        false
      )
      // The paid request stays recorded for when the host affirms the capability again.
      expect(refreshed.record.valuesByModel[MODEL_ID]?.serviceTier?.value).toBe(FAST.value)
    }
  )
})

describe('Codex speed facts in option state', () => {
  const facts: AgentSessionSpeedFacts = {
    selection: { tierId: FAST.value, state: 'ready' },
    lastRequest: { clientMessageId: 'm1', tierId: FAST.value, state: 'sent' }
  }

  it('keeps the host facts of the latest read and drops them when a read carries none', () => {
    const result = liveResult(tieredModel([STANDARD, FAST]), { serviceTier: FAST.value })
    const withFacts = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('codex'),
      CODEX_SESSION_OPTION_CATALOG,
      { ...result, speed: facts },
      'supported'
    )
    expect(withFacts.speed).toEqual(facts)

    const older = applyStructuredAgentSessionOptions(
      withFacts,
      CODEX_SESSION_OPTION_CATALOG,
      result,
      'supported'
    )
    expect(older.speed).toBeUndefined()
  })

  it('never holds speed facts for another agent', () => {
    const result = liveResult(tieredModel([STANDARD, FAST], true), { fastMode: false })
    const claude = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('claude'),
      CLAUDE_SESSION_OPTION_CATALOG,
      { ...result, speed: facts }
    )

    expect(claude.speed).toBeUndefined()
  })
})
