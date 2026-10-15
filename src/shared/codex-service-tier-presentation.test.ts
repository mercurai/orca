import { describe, expect, it } from 'vitest'
import {
  CLAUDE_SESSION_OPTION_CATALOG,
  CODEX_SESSION_OPTION_CATALOG
} from './agent-session-option-catalog-claude-codex'
import type {
  SessionOptionDescriptor,
  SessionOptionSelectChoice
} from './native-chat-session-options'
import {
  applyStructuredAgentSessionOptions,
  canSetStructuredAgentSessionOption,
  commitStructuredAgentSessionOption,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionCatalog,
  structuredAgentSessionOptionSnapshot
} from './structured-agent-session-options'

const MODEL_ID = 'synthetic-speed-model'
const LEGACY_MODEL_ID = 'synthetic-legacy-model'
const STALE_TIER_ID = 'synthetic-retired-tier'

const STANDARD = {
  value: 'default',
  label: 'Standard',
  description: 'Normal speed at the normal usage rate.'
}
const FAST = {
  value: 'synthetic-fast-lane',
  label: 'Fast',
  description: 'Quicker replies; uses more of your allowance.'
}
const ULTRAFAST = {
  value: 'synthetic-ultra-lane',
  label: 'Ultrafast',
  description: 'Fastest replies; uses the most of your allowance.'
}

type TierRow = { value: string; label: string; description: string }

// Fixtures are inferred objects with additive fields, so they stay assignable to the
// declared wire types before the production types grow those fields.
function speedResult(serviceTiers: readonly TierRow[] | undefined, serviceTier?: string) {
  return {
    models: [
      {
        id: MODEL_ID,
        label: 'Synthetic Speed Model',
        isDefault: true,
        efforts: [],
        supportsFastMode: serviceTiers?.some((tier) => tier.value === FAST.value) ?? false,
        ...(serviceTiers ? { serviceTiers: [...serviceTiers] } : {})
      }
    ],
    fastModeSupport: { supported: true },
    current: {
      model: MODEL_ID,
      confirmed: ['model', ...(serviceTier ? ['serviceTier'] : [])],
      ...(serviceTier ? { serviceTier } : {})
    }
  }
}

function stateFor(
  result: Parameters<typeof applyStructuredAgentSessionOptions>[2],
  seed = CODEX_SESSION_OPTION_CATALOG,
  agent: Parameters<typeof createStructuredAgentSessionOptionState>[0] = 'codex'
) {
  return applyStructuredAgentSessionOptions(
    createStructuredAgentSessionOptionState(agent),
    seed,
    result
  )
}

function descriptorFor(
  snapshot: readonly SessionOptionDescriptor[],
  id: string
): SessionOptionDescriptor | undefined {
  return snapshot.find((descriptor) => descriptor.id === id)
}

function selectChoices(descriptor: SessionOptionDescriptor | undefined) {
  return descriptor?.kind.type === 'select' ? descriptor.kind.choices : []
}

function isDisabled(choice: SessionOptionSelectChoice): boolean {
  return 'disabled' in choice && choice.disabled === true
}

function admitted(choices: readonly SessionOptionSelectChoice[]) {
  return choices
    .filter((choice) => !isDisabled(choice))
    .map((choice) => ({
      value: choice.value,
      label: choice.label,
      description: choice.description
    }))
}

function tierDescriptor(state: ReturnType<typeof stateFor>) {
  return descriptorFor(structuredAgentSessionOptionSnapshot(state), 'serviceTier')
}

function unavailableRow(choices: readonly SessionOptionSelectChoice[], label: string) {
  return choices.find((choice) => choice.label === label)
}

describe('Codex service-tier presentation', () => {
  it('projects Standard, Fast and Ultrafast as one serviceTier select', () => {
    const result = speedResult([STANDARD, FAST, ULTRAFAST], FAST.value)
    const state = stateFor(result)

    const snapshot = structuredAgentSessionOptionSnapshot(state)
    const tier = descriptorFor(snapshot, 'serviceTier')
    expect(tier).toMatchObject({
      id: 'serviceTier',
      transport: 'agent-session',
      valueSource: 'reported',
      settable: true,
      kind: { type: 'select', currentValue: FAST.value }
    })
    expect(admitted(selectChoices(tier))).toEqual([STANDARD, FAST, ULTRAFAST])
    // The tier select replaces the boolean even though the compatibility flag is still true.
    expect(snapshot.map((descriptor) => descriptor.id)).not.toContain('fastMode')

    const catalog = structuredAgentSessionOptionCatalog(CODEX_SESSION_OPTION_CATALOG, result)
    const model = catalog.models.find((candidate) => candidate.id === MODEL_ID)
    const option = model?.options.find((candidate) => candidate.id === 'serviceTier')
    expect(option?.kind.type).toBe('select')
    expect(admitted(option?.kind.type === 'select' ? option.kind.choices : [])).toEqual([
      STANDARD,
      FAST,
      ULTRAFAST
    ])
    expect(model?.options.map((candidate) => candidate.id)).not.toContain('fastMode')

    expect(canSetStructuredAgentSessionOption(state, 'serviceTier', ULTRAFAST.value)).toBe(true)
  })

  it('offers protocol Standard when the provider omits it', () => {
    const state = stateFor(speedResult([FAST]))

    expect(admitted(selectChoices(tierDescriptor(state)))).toEqual([
      expect.objectContaining({ value: 'default', label: 'Standard' }),
      FAST
    ])
    expect(canSetStructuredAgentSessionOption(state, 'serviceTier', 'default')).toBe(true)
  })

  it('shows unadvertised Ultrafast as a disabled row that is never admitted', () => {
    const state = stateFor(speedResult([STANDARD, FAST], STANDARD.value))
    const choices = selectChoices(tierDescriptor(state))

    expect(admitted(choices)).toEqual([STANDARD, FAST])
    const ultrafast = unavailableRow(choices, 'Ultrafast')
    expect(ultrafast).toBeDefined()
    expect(ultrafast && isDisabled(ultrafast)).toBe(true)

    const values = choices.map((choice) => choice.value)
    expect(new Set(values).size).toBe(values.length)
    expect(canSetStructuredAgentSessionOption(state, 'serviceTier', ultrafast?.value ?? '')).toBe(
      false
    )
  })

  it('keeps Standard selectable and shows missing Fast and Ultrafast as disabled rows', () => {
    const state = stateFor(speedResult([STANDARD], STANDARD.value))
    const choices = selectChoices(tierDescriptor(state))

    expect(admitted(choices)).toEqual([STANDARD])
    for (const label of ['Fast', 'Ultrafast']) {
      const row = unavailableRow(choices, label)
      expect(row).toBeDefined()
      expect(row && isDisabled(row)).toBe(true)
      expect(canSetStructuredAgentSessionOption(state, 'serviceTier', row?.value ?? '')).toBe(
        false
      )
    }
    const values = choices.map((choice) => choice.value)
    expect(new Set(values).size).toBe(values.length)
  })

  it('keeps a known Standard-only model visible and an unknown one hidden', () => {
    const standardOnly = stateFor(speedResult([], 'default'))
    const standardChoices = selectChoices(tierDescriptor(standardOnly))
    expect(admitted(standardChoices)).toEqual([
      expect.objectContaining({ value: 'default', label: 'Standard' })
    ])

    // Absent metadata is unknown support, not Standard-only: no tier control at all.
    const unknown = stateFor(speedResult(undefined))
    expect(tierDescriptor(unknown)).toBeUndefined()
  })

  it('keeps a stale requested id visible and disabled without admitting it', () => {
    const state = stateFor(speedResult([STANDARD, FAST], STALE_TIER_ID))
    const tier = tierDescriptor(state)
    const choices = selectChoices(tier)

    expect(tier).toMatchObject({ kind: { type: 'select', currentValue: STALE_TIER_ID } })
    const stale = choices.filter((choice) => choice.value === STALE_TIER_ID)
    expect(stale).toHaveLength(1)
    expect(isDisabled(stale[0]!)).toBe(true)
    expect(admitted(choices)).toEqual([STANDARD, FAST])
    expect(canSetStructuredAgentSessionOption(state, 'serviceTier', STALE_TIER_ID)).toBe(false)
    expect(canSetStructuredAgentSessionOption(state, 'serviceTier', FAST.value)).toBe(true)
  })

  it('keeps a pending request visible but disabled after a refresh withdraws its tier', () => {
    const before = stateFor(speedResult([STANDARD, FAST, ULTRAFAST], FAST.value))
    const requested = commitStructuredAgentSessionOption(before, 'serviceTier', ULTRAFAST.value)

    const refreshed = applyStructuredAgentSessionOptions(
      requested,
      CODEX_SESSION_OPTION_CATALOG,
      speedResult([STANDARD, FAST])
    )

    // Revalidation must not erase the user's requested intent.
    expect(refreshed.record.valuesByModel[MODEL_ID]?.serviceTier?.value).toBe(ULTRAFAST.value)
    const tier = tierDescriptor(refreshed)
    expect(tier).toMatchObject({ kind: { currentValue: ULTRAFAST.value } })
    const rows = selectChoices(tier).filter((choice) => choice.value === ULTRAFAST.value)
    expect(rows).toHaveLength(1)
    expect(isDisabled(rows[0]!)).toBe(true)
    expect(admitted(selectChoices(tier))).toEqual([STANDARD, FAST])
    expect(canSetStructuredAgentSessionOption(refreshed, 'serviceTier', ULTRAFAST.value)).toBe(
      false
    )
  })

  it('keeps the boolean Fast control when service-tier fields are absent', () => {
    const result = speedResult(undefined)
    result.models[0]!.supportsFastMode = true
    const reported = {
      ...result,
      current: { ...result.current, fastMode: false, confirmed: ['model', 'fastMode'] }
    }
    const codex = stateFor(reported)

    const snapshot = structuredAgentSessionOptionSnapshot(codex)
    expect(snapshot.map((descriptor) => descriptor.id)).toEqual(['model', 'fastMode'])
    expect(descriptorFor(snapshot, 'fastMode')).toMatchObject({
      kind: { type: 'boolean', currentValue: false },
      valueSource: 'reported',
      settable: true
    })
    expect(canSetStructuredAgentSessionOption(codex, 'fastMode', true)).toBe(true)
    expect(canSetStructuredAgentSessionOption(codex, 'serviceTier', 'default')).toBe(false)

    const claude = stateFor(result, CLAUDE_SESSION_OPTION_CATALOG, 'claude')
    expect(claude.record.agent).toBe('claude')
    expect(structuredAgentSessionOptionSnapshot(claude).map(({ id }) => id)).toContain('fastMode')
    expect(descriptorFor(structuredAgentSessionOptionSnapshot(claude), 'serviceTier')).toBe(
      undefined
    )
  })

  it('keeps Claude on its own fastMode boolean even when tier metadata is reported', () => {
    const tiered = speedResult([STANDARD, FAST], FAST.value)
    const result = {
      ...tiered,
      current: { ...tiered.current, fastMode: false, confirmed: ['model', 'fastMode'] }
    }
    const claude = stateFor(result, CLAUDE_SESSION_OPTION_CATALOG, 'claude')

    expect(claude.record.agent).toBe('claude')
    const snapshot = structuredAgentSessionOptionSnapshot(claude)
    expect(descriptorFor(snapshot, 'fastMode')).toMatchObject({
      kind: { type: 'boolean', currentValue: false }
    })
    expect(descriptorFor(snapshot, 'serviceTier')).toBeUndefined()
    expect(canSetStructuredAgentSessionOption(claude, 'serviceTier', FAST.value)).toBe(false)

    const model = claude.catalog?.models.find((candidate) => candidate.id === MODEL_ID)
    expect(model).toBeDefined()
    expect(model?.options.map((candidate) => candidate.id)).not.toContain('serviceTier')
    expect(
      CLAUDE_SESSION_OPTION_CATALOG.models.flatMap((entry) => entry.options.map(({ id }) => id))
    ).not.toContain('serviceTier')
  })

  it('chooses the control per model when only some models advertise service tiers', () => {
    const modern = speedResult([STANDARD, FAST])
    const result = {
      ...modern,
      models: [
        ...modern.models,
        {
          id: LEGACY_MODEL_ID,
          label: 'Synthetic Legacy Model',
          isDefault: false,
          efforts: [],
          supportsFastMode: true
        }
      ]
    }
    const onModern = stateFor(result)
    const legacyCurrent = { model: LEGACY_MODEL_ID, confirmed: ['model'] }
    const onLegacy = stateFor({ ...result, current: legacyCurrent })

    const modernIds = structuredAgentSessionOptionSnapshot(onModern).map(({ id }) => id)
    expect(modernIds).toContain('serviceTier')
    expect(modernIds).not.toContain('fastMode')

    const legacyIds = structuredAgentSessionOptionSnapshot(onLegacy).map(({ id }) => id)
    expect(legacyIds).toContain('fastMode')
    expect(legacyIds).not.toContain('serviceTier')
  })
})
