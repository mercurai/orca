import { describe, expect, it } from 'vitest'
import { CODEX_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-claude-codex'
import {
  applyStructuredAgentSessionOptions,
  commitStructuredAgentSessionOptionValues,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from './structured-agent-session-options'

const MODEL = 'synthetic-speed-model'
const TIER = 'synthetic-priority-exact-id'
const standard = { value: 'default', label: 'Standard' }
const listedModel = {
  id: MODEL,
  label: 'Synthetic speed model',
  isDefault: true,
  efforts: [],
  serviceTiers: [{ value: TIER, label: 'Synthetic speed' }]
}

function initialState() {
  return createStructuredAgentSessionOptionState('codex')
}

describe('structured session speed state projection', () => {
  it('keeps requested, host-applied and unknown processing facts separate on the speed descriptor', () => {
    const speed = {
      requested: { tierId: TIER },
      support: 'available' as const,
      applied: { tierId: 'default', turnId: 'synthetic-earlier-turn' },
      processing: { status: 'unknown' as const }
    }
    const result = {
      models: [listedModel],
      current: { model: MODEL, serviceTier: TIER },
      speed
    }
    const state = applyStructuredAgentSessionOptions(
      initialState(),
      CODEX_SESSION_OPTION_CATALOG,
      result
    )

    expect(structuredAgentSessionOptionSnapshot(state).find(({ id }) => id === 'serviceTier'))
      .toMatchObject({
        speed,
        kind: { currentValue: TIER }
      })
  })

  it('invalidates same-model speed support after a changed pick when no refreshed answer arrives', () => {
    const nextTier = 'synthetic-next-exact-tier-id'
    const applied = { tierId: TIER, turnId: 'synthetic-previous-turn' }
    const result = {
      models: [
        {
          ...listedModel,
          serviceTiers: [...listedModel.serviceTiers, { value: nextTier, label: 'Next speed' }]
        }
      ],
      current: { model: MODEL, serviceTier: TIER },
      speed: {
        requested: { tierId: TIER },
        support: 'available' as const,
        applied,
        processing: { status: 'unknown' as const }
      }
    }
    const live = applyStructuredAgentSessionOptions(
      initialState(),
      CODEX_SESSION_OPTION_CATALOG,
      result
    )
    expect(structuredAgentSessionOptionSnapshot(live).find(({ id }) => id === 'serviceTier'))
      .toMatchObject({ speed: { requested: { tierId: TIER }, support: 'available', applied } })

    const changed = commitStructuredAgentSessionOptionValues(live, { serviceTier: nextTier })
    // A failed detached refresh applies no new result; the committed pick must stand on its own.
    const descriptor = structuredAgentSessionOptionSnapshot(changed)
      .find(({ id }) => id === 'serviceTier')

    expect(descriptor).toMatchObject({
      kind: { currentValue: nextTier },
      speed: {
        requested: { tierId: nextTier },
        support: 'unknown',
        applied,
        processing: { status: 'unknown' }
      }
    })
  })

  it('retains an unavailable requested exact id when the refreshed model no longer advertises it', () => {
    const speed = {
      requested: { tierId: TIER },
      support: 'unavailable' as const,
      processing: { status: 'unknown' as const }
    }
    const result = {
      models: [{ ...listedModel, serviceTiers: [] }],
      current: { model: MODEL, serviceTier: TIER },
      speed
    }
    const state = applyStructuredAgentSessionOptions(
      initialState(),
      CODEX_SESSION_OPTION_CATALOG,
      result
    )
    const descriptor = structuredAgentSessionOptionSnapshot(state)
      .find(({ id }) => id === 'serviceTier')

    expect(descriptor).toMatchObject({
      speed,
      kind: {
        type: 'select',
        currentValue: TIER,
        choices: expect.arrayContaining([standard, expect.objectContaining({ value: TIER })])
      }
    })
  })

  it.each(['loading', 'unknown'] as const)(
    'shows a Standard choice annotated with %s support rather than a legacy toggle',
    (support) => {
      const speed = { support, processing: { status: 'unknown' as const } }
      const result = {
        models: [
          {
            id: MODEL,
            label: 'Synthetic speed model',
            isDefault: true,
            efforts: [],
            supportsFastMode: true
          }
        ],
        fastModeSupport: { supported: true },
        current: { model: MODEL },
        speed
      }
      const state = applyStructuredAgentSessionOptions(
        initialState(),
        CODEX_SESSION_OPTION_CATALOG,
        result
      )
      const descriptors = structuredAgentSessionOptionSnapshot(state)

      expect(descriptors.find(({ id }) => id === 'serviceTier')).toMatchObject({
        speed,
        kind: { type: 'select', choices: expect.arrayContaining([standard]) }
      })
      expect(descriptors.some(({ id }) => id === 'fastMode')).toBe(false)
    }
  )

  it('preserves a pending legacy Fast request without claiming a resolved or processed tier', () => {
    const speed = {
      requested: { legacyFast: true as const },
      support: 'unknown' as const,
      processing: { status: 'unknown' as const }
    }
    const result = {
      models: [{ id: MODEL, label: 'Synthetic speed model', isDefault: true, efforts: [] }],
      current: { model: MODEL },
      speed
    }
    const state = applyStructuredAgentSessionOptions(
      initialState(),
      CODEX_SESSION_OPTION_CATALOG,
      result
    )
    const descriptor = structuredAgentSessionOptionSnapshot(state)
      .find(({ id }) => id === 'serviceTier')

    expect(descriptor).toMatchObject({ speed })
    expect(descriptor).not.toHaveProperty('speed.applied')
    expect(descriptor).not.toHaveProperty('speed.requested.tierId')
  })

  it('clears stale speed metadata when a different older host reports its supported Fast toggle', () => {
    const firstResult = {
      models: [listedModel],
      current: { model: MODEL, serviceTier: TIER },
      speed: {
        requested: { tierId: TIER },
        support: 'available' as const,
        processing: { status: 'unknown' as const }
      }
    }
    const first = applyStructuredAgentSessionOptions(
      initialState(),
      CODEX_SESSION_OPTION_CATALOG,
      firstResult
    )
    expect(structuredAgentSessionOptionSnapshot(first).find(({ id }) => id === 'serviceTier'))
      .toMatchObject({ speed: firstResult.speed })
    const oldHostResult = {
      models: [
        {
          id: 'synthetic-older-host-model',
          label: 'Older host model',
          isDefault: true,
          efforts: [],
          supportsFastMode: true
        }
      ],
      fastModeSupport: { supported: true },
      current: { model: 'synthetic-older-host-model', fastMode: true }
    }
    const switched = applyStructuredAgentSessionOptions(
      first,
      CODEX_SESSION_OPTION_CATALOG,
      oldHostResult
    )
    const descriptors = structuredAgentSessionOptionSnapshot(switched)

    expect(descriptors.map(({ id }) => id)).toEqual(['model', 'fastMode'])
    expect(descriptors.find(({ id }) => id === 'fastMode')).toMatchObject({
      kind: { type: 'boolean', currentValue: true }
    })
    expect(descriptors.every((descriptor) => !Object.hasOwn(descriptor, 'speed'))).toBe(true)
  })
})
