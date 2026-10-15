import { describe, expect, it } from 'vitest'
import {
  applyNativeChatSessionOptionPicks,
  resolveStructuredLaunchSeedOptions,
  updateNativeChatSessionOptionDefaults
} from './native-chat-session-option-defaults'
import type {
  PersistedNativeChatSessionOptions,
  SessionOptionValue
} from './native-chat-session-options'

// Synthetic ids: the catalog, not Orca, decides which request tier IDs exist.
const MODEL = 'synthetic-model-a'
const OTHER_MODEL = 'synthetic-model-b'
const CUSTOM_TIER = 'Tier.Ultra-9c1'

function savedCodex(
  values: Record<string, SessionOptionValue>
): PersistedNativeChatSessionOptions {
  return {
    codex: {
      model: MODEL,
      valuesByModel: {
        [MODEL]: values,
        [OTHER_MODEL]: { serviceTier: CUSTOM_TIER }
      }
    }
  }
}

describe('an explicit Fast toggle replaces a saved canonical Codex tier', () => {
  it.each([false, true])('Fast=%s drops the saved tier and seeds the legacy intent', (fast) => {
    const next = updateNativeChatSessionOptionDefaults({
      persisted: savedCodex({ effort: 'high', serviceTier: CUSTOM_TIER }),
      agent: 'codex',
      modelId: MODEL,
      optionId: 'fastMode',
      value: fast
    })

    expect(next.codex?.valuesByModel?.[MODEL]).toEqual({ effort: 'high', fastMode: fast })
    expect(next.codex?.valuesByModel?.[OTHER_MODEL]).toEqual({ serviceTier: CUSTOM_TIER })
    expect(resolveStructuredLaunchSeedOptions(next, 'codex')).toEqual({
      model: MODEL,
      effort: 'high',
      fastMode: String(fast)
    })
  })

  it('applies the same replacement through a batch of picks, keeping the other picks', () => {
    const next = applyNativeChatSessionOptionPicks({
      persisted: savedCodex({ effort: 'high', serviceTier: CUSTOM_TIER }),
      agent: 'codex',
      picks: [
        { modelId: MODEL, optionId: 'effort', value: 'low' },
        { modelId: MODEL, optionId: 'fastMode', value: false }
      ]
    })

    expect(next.codex?.valuesByModel?.[MODEL]).toEqual({ effort: 'low', fastMode: false })
    expect(resolveStructuredLaunchSeedOptions(next, 'codex')).toEqual({
      model: MODEL,
      effort: 'low',
      fastMode: 'false'
    })
  })
})

describe('an explicit canonical tier replaces a saved Codex Fast boolean', () => {
  it.each([false, true])('drops a saved Fast=%s and seeds the tier', (fast) => {
    const next = updateNativeChatSessionOptionDefaults({
      persisted: savedCodex({ effort: 'high', fastMode: fast }),
      agent: 'codex',
      modelId: MODEL,
      optionId: 'serviceTier',
      value: CUSTOM_TIER
    })

    expect(next.codex?.valuesByModel?.[MODEL]).toEqual({
      effort: 'high',
      serviceTier: CUSTOM_TIER
    })
    expect(resolveStructuredLaunchSeedOptions(next, 'codex')).toEqual({
      model: MODEL,
      effort: 'high',
      serviceTier: CUSTOM_TIER
    })
  })

  // Canonical snapshot batches carry a compatibility fastMode projection, so a later
  // Fast pick must not erase the explicit tier.
  it.each([
    { order: 'Fast before tier', fastFirst: true },
    { order: 'tier before Fast', fastFirst: false }
  ])(
    'keeps the canonical tier over a legacy Fast pick in one batch ($order)',
    ({ fastFirst }) => {
      const fastPick = { modelId: MODEL, optionId: 'fastMode', value: false }
      const tierPick = { modelId: MODEL, optionId: 'serviceTier', value: CUSTOM_TIER }
      const next = applyNativeChatSessionOptionPicks({
        persisted: undefined,
        agent: 'codex',
        picks: fastFirst ? [fastPick, tierPick] : [tierPick, fastPick]
      })

      expect(next.codex?.valuesByModel?.[MODEL]).toEqual({ serviceTier: CUSTOM_TIER })
      expect(resolveStructuredLaunchSeedOptions(next, 'codex')).toEqual({
        model: MODEL,
        serviceTier: CUSTOM_TIER
      })
    }
  )

  it.each([true, false])(
    'keeps an unrelated effort pick when the canonical tier beats Fast in a batch (Fast first=%s)',
    (fastFirst) => {
      const fastPick = { modelId: MODEL, optionId: 'fastMode', value: true }
      const tierPick = { modelId: MODEL, optionId: 'serviceTier', value: CUSTOM_TIER }
      const effortPick = { modelId: MODEL, optionId: 'effort', value: 'low' }
      const next = applyNativeChatSessionOptionPicks({
        persisted: savedCodex({ effort: 'high', fastMode: false }),
        agent: 'codex',
        picks: fastFirst ? [fastPick, effortPick, tierPick] : [tierPick, effortPick, fastPick]
      })

      expect(next.codex?.valuesByModel?.[MODEL]).toEqual({
        effort: 'low',
        serviceTier: CUSTOM_TIER
      })
      expect(resolveStructuredLaunchSeedOptions(next, 'codex')).toEqual({
        model: MODEL,
        effort: 'low',
        serviceTier: CUSTOM_TIER
      })
    }
  )
})

describe('a batch keeps launch-default adoption in the original pick order', () => {
  // The Fast projection is applied early so the tier wins, but it must not change which
  // model the last pick adopts: here model A's pick is last, so A stays the launch default.
  it.each([
    { order: 'tier, other effort, Fast', tierFirst: true },
    { order: 'Fast, other effort, tier', tierFirst: false }
  ])('adopts the last-picked model and seeds its canonical tier ($order)', ({ tierFirst }) => {
    const tierPick = { modelId: MODEL, optionId: 'serviceTier', value: CUSTOM_TIER }
    const effortPick = { modelId: OTHER_MODEL, optionId: 'effort', value: 'low' }
    const fastPick = { modelId: MODEL, optionId: 'fastMode', value: true }
    const next = applyNativeChatSessionOptionPicks({
      persisted: {
        codex: {
          model: OTHER_MODEL,
          valuesByModel: { [OTHER_MODEL]: { serviceTier: 'synthetic-paid-tier' } }
        }
      },
      agent: 'codex',
      picks: tierFirst ? [tierPick, effortPick, fastPick] : [fastPick, effortPick, tierPick]
    })

    expect(next.codex?.model).toBe(MODEL)
    expect(next.codex?.valuesByModel).toEqual({
      [MODEL]: { serviceTier: CUSTOM_TIER },
      [OTHER_MODEL]: { serviceTier: 'synthetic-paid-tier', effort: 'low' }
    })
    expect(resolveStructuredLaunchSeedOptions(next, 'codex')).toEqual({
      model: MODEL,
      serviceTier: CUSTOM_TIER
    })
  })
})

describe('a malformed speed choice is ignored before it is stored or adopted', () => {
  const MALFORMED: {
    name: string
    saved: Record<string, SessionOptionValue>
    optionId: 'fastMode' | 'serviceTier'
    value: SessionOptionValue
  }[] = [
    {
      name: 'blank tier over a saved tier',
      saved: { serviceTier: CUSTOM_TIER },
      optionId: 'serviceTier',
      value: '   '
    },
    {
      name: 'blank tier over a saved Fast',
      saved: { fastMode: true },
      optionId: 'serviceTier',
      value: '   '
    },
    {
      name: 'text Fast over a saved tier',
      saved: { serviceTier: CUSTOM_TIER },
      optionId: 'fastMode',
      value: 'false'
    },
    {
      name: 'text Fast over a saved Fast',
      saved: { fastMode: true },
      optionId: 'fastMode',
      value: 'false'
    }
  ]

  // The launch default is the other model, so adopting the malformed pick's model is visible.
  function persistedWith(
    saved: Record<string, SessionOptionValue>
  ): PersistedNativeChatSessionOptions {
    return {
      codex: {
        model: OTHER_MODEL,
        valuesByModel: { [MODEL]: saved, [OTHER_MODEL]: { effort: 'high' } }
      },
      claude: { model: MODEL, valuesByModel: { [MODEL]: { effort: 'max', fastMode: true } } }
    }
  }

  it.each(MALFORMED)('leaves every map, scope, and seed unchanged: $name', (malformed) => {
    const persisted = persistedWith(malformed.saved)
    const seedBefore = resolveStructuredLaunchSeedOptions(persisted, 'codex')

    const next = updateNativeChatSessionOptionDefaults({
      persisted,
      agent: 'codex',
      modelId: MODEL,
      optionId: malformed.optionId,
      value: malformed.value
    })

    expect(next).toEqual(persisted)
    expect(resolveStructuredLaunchSeedOptions(next, 'codex')).toEqual(seedBefore)
  })

  it.each(MALFORMED)('drops it from a batch and applies the rest: $name', (malformed) => {
    const persisted = persistedWith(malformed.saved)

    const next = applyNativeChatSessionOptionPicks({
      persisted,
      agent: 'codex',
      picks: [
        { modelId: OTHER_MODEL, optionId: 'effort', value: 'low' },
        { modelId: MODEL, optionId: malformed.optionId, value: malformed.value }
      ]
    })

    expect(next.codex?.model).toBe(OTHER_MODEL)
    expect(next.codex?.valuesByModel).toEqual({
      [MODEL]: malformed.saved,
      [OTHER_MODEL]: { effort: 'low' }
    })
    expect(next.claude).toEqual(persisted.claude)
    expect(resolveStructuredLaunchSeedOptions(next, 'codex')).toEqual({
      model: OTHER_MODEL,
      effort: 'low'
    })
  })
})

describe('Fast actions stay scoped to the Codex entry', () => {
  it('keeps Claude Fast and unrelated values when a Codex Fast action is applied', () => {
    const persisted: PersistedNativeChatSessionOptions = {
      ...savedCodex({ serviceTier: CUSTOM_TIER }),
      claude: { model: MODEL, valuesByModel: { [MODEL]: { effort: 'max', fastMode: true } } }
    }

    const next = updateNativeChatSessionOptionDefaults({
      persisted,
      agent: 'codex',
      modelId: MODEL,
      optionId: 'fastMode',
      value: false
    })

    expect(next.claude).toEqual(persisted.claude)
    expect(resolveStructuredLaunchSeedOptions(next, 'claude')).toEqual({
      model: MODEL,
      effort: 'max',
      fastMode: 'true'
    })
  })

  it('keeps the Codex tier when a Claude Fast toggle is applied', () => {
    const persisted: PersistedNativeChatSessionOptions = {
      ...savedCodex({ serviceTier: CUSTOM_TIER }),
      claude: { model: MODEL, valuesByModel: { [MODEL]: { effort: 'max', fastMode: true } } }
    }

    const next = updateNativeChatSessionOptionDefaults({
      persisted,
      agent: 'claude',
      modelId: MODEL,
      optionId: 'fastMode',
      value: false
    })

    expect(next.codex).toEqual(persisted.codex)
    expect(resolveStructuredLaunchSeedOptions(next, 'claude')).toEqual({
      model: MODEL,
      effort: 'max',
      fastMode: 'false'
    })
    expect(resolveStructuredLaunchSeedOptions(next, 'codex')).toEqual({
      model: MODEL,
      serviceTier: CUSTOM_TIER
    })
  })
})
