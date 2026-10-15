import { describe, expect, it } from 'vitest'
import {
  narrowStructuredLaunchSeedOptions,
  parseStructuredLaunchSeedOptions,
  resolveStructuredLaunchSeedOptions
} from './native-chat-session-option-defaults'
import type { PersistedNativeChatSessionOptions } from './native-chat-session-options'

// Synthetic ids: the catalog, not Orca, decides which request tier IDs exist.
const MODEL = 'synthetic-model-a'
const CUSTOM_TIER = 'Tier.Ultra-9c1'

describe('canonical serviceTier in launch seeds', () => {
  it('survives narrowing verbatim', () => {
    expect(narrowStructuredLaunchSeedOptions({ model: MODEL, serviceTier: CUSTOM_TIER })).toEqual({
      model: MODEL,
      serviceTier: CUSTOM_TIER
    })
  })

  it('survives parsing an encoded seed verbatim', () => {
    expect(parseStructuredLaunchSeedOptions({ model: MODEL, serviceTier: CUSTOM_TIER })).toEqual({
      model: MODEL,
      serviceTier: CUSTOM_TIER
    })
  })

  it('wins over a coexisting fastMode in an encoded seed', () => {
    expect(
      parseStructuredLaunchSeedOptions({ model: MODEL, serviceTier: CUSTOM_TIER, fastMode: 'true' })
    ).toEqual({ model: MODEL, serviceTier: CUSTOM_TIER })
    expect(
      parseStructuredLaunchSeedOptions({ model: MODEL, serviceTier: 'default', fastMode: 'false' })
    ).toEqual({ model: MODEL, serviceTier: 'default' })
  })

  it('drops a stale fastMode when narrowing a canonical selection', () => {
    expect(
      narrowStructuredLaunchSeedOptions({ model: MODEL, serviceTier: CUSTOM_TIER, fastMode: true })
    ).toEqual({ model: MODEL, serviceTier: CUSTOM_TIER })
  })

  it('still seeds a legacy fastMode seed that names no canonical tier', () => {
    expect(parseStructuredLaunchSeedOptions({ model: MODEL, fastMode: 'true' })).toEqual({
      model: MODEL,
      fastMode: 'true'
    })
  })

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['tab and newline', '\t\n']
  ])('does not seed an %s tier', (_name, blank) => {
    expect(narrowStructuredLaunchSeedOptions({ model: MODEL, serviceTier: blank })).toEqual({
      model: MODEL
    })
    expect(parseStructuredLaunchSeedOptions({ model: MODEL, serviceTier: blank })).toEqual({
      model: MODEL
    })
    expect(parseStructuredLaunchSeedOptions({ serviceTier: blank })).toBeUndefined()
    expect(narrowStructuredLaunchSeedOptions({ serviceTier: blank })).toBeUndefined()
  })

  it('does not seed a non-string tier', () => {
    expect(narrowStructuredLaunchSeedOptions({ model: MODEL, serviceTier: 5 })).toEqual({
      model: MODEL
    })
    expect(narrowStructuredLaunchSeedOptions({ model: MODEL, serviceTier: null })).toEqual({
      model: MODEL
    })
    expect(narrowStructuredLaunchSeedOptions({ model: MODEL, serviceTier: true })).toEqual({
      model: MODEL
    })
    expect(parseStructuredLaunchSeedOptions({ model: MODEL, serviceTier: 5 })).toEqual({
      model: MODEL
    })
  })

  it('keeps a legacy fastMode when the canonical tier beside it is unusable', () => {
    expect(
      narrowStructuredLaunchSeedOptions({ model: MODEL, serviceTier: '  ', fastMode: true })
    ).toEqual({ model: MODEL, fastMode: 'true' })
    expect(
      parseStructuredLaunchSeedOptions({ model: MODEL, serviceTier: '', fastMode: 'false' })
    ).toEqual({ model: MODEL, fastMode: 'false' })
  })

  it('seeds nothing for an untouched launch', () => {
    expect(narrowStructuredLaunchSeedOptions({})).toBeUndefined()
    expect(narrowStructuredLaunchSeedOptions(undefined)).toBeUndefined()
    expect(parseStructuredLaunchSeedOptions(undefined)).toBeUndefined()
  })
})

describe('resolveStructuredLaunchSeedOptions with a canonical serviceTier', () => {
  const persisted = (
    agent: string,
    values: Record<string, string | boolean>
  ): PersistedNativeChatSessionOptions => ({
    [agent]: { model: MODEL, valuesByModel: { [MODEL]: values } }
  })

  it('preserves the custom tier a Codex user chose', () => {
    expect(
      resolveStructuredLaunchSeedOptions(
        persisted('codex', { effort: 'high', serviceTier: CUSTOM_TIER }),
        'codex'
      )
    ).toEqual({ model: MODEL, effort: 'high', serviceTier: CUSTOM_TIER })
  })

  it('drops the stale fastMode saved beside a canonical tier', () => {
    expect(
      resolveStructuredLaunchSeedOptions(
        persisted('codex', { serviceTier: CUSTOM_TIER, fastMode: true }),
        'codex'
      )
    ).toEqual({ model: MODEL, serviceTier: CUSTOM_TIER })
  })

  it('keeps a Claude fastMode boolean as its own control', () => {
    expect(
      resolveStructuredLaunchSeedOptions(persisted('claude', { fastMode: true }), 'claude')
    ).toEqual({ model: MODEL, fastMode: 'true' })
    expect(
      resolveStructuredLaunchSeedOptions(persisted('claude', { fastMode: false }), 'claude')
    ).toEqual({ model: MODEL, fastMode: 'false' })
  })

  it('never gives Claude the Codex-only serviceTier from its saved values', () => {
    expect(
      resolveStructuredLaunchSeedOptions(
        persisted('claude', { fastMode: true, serviceTier: CUSTOM_TIER }),
        'claude'
      )
    ).toEqual({ model: MODEL, fastMode: 'true' })
    expect(
      resolveStructuredLaunchSeedOptions(persisted('claude', { serviceTier: CUSTOM_TIER }), 'claude')
    ).toEqual({ model: MODEL })
  })

  it('introduces no paid tier into an untouched launch', () => {
    expect(resolveStructuredLaunchSeedOptions(undefined, 'codex')).toBeUndefined()
    expect(
      resolveStructuredLaunchSeedOptions({ codex: { valuesByModel: {} } }, 'codex')
    ).toBeUndefined()
    const modelOnly = resolveStructuredLaunchSeedOptions(persisted('codex', {}), 'codex')
    expect(modelOnly).toEqual({ model: MODEL })
    expect(modelOnly).not.toHaveProperty('serviceTier')
    expect(modelOnly).not.toHaveProperty('fastMode')
  })

  it.each(['gemini', 'opencode', 'cursor'] as const)(
    'never gives %s the Codex-only serviceTier',
    (agent) => {
      expect(
        resolveStructuredLaunchSeedOptions(
          persisted(agent, { effort: 'high', serviceTier: CUSTOM_TIER }),
          agent
        )
      ).toEqual({ model: MODEL, effort: 'high' })
    }
  )

  it('does not carry a tier saved for another model into this launch', () => {
    expect(
      resolveStructuredLaunchSeedOptions(
        {
          codex: {
            model: MODEL,
            valuesByModel: { 'synthetic-model-b': { serviceTier: CUSTOM_TIER } }
          }
        },
        'codex'
      )
    ).toEqual({ model: MODEL })
  })

  it('does not seed a blank saved tier', () => {
    expect(
      resolveStructuredLaunchSeedOptions(persisted('codex', { serviceTier: '  ' }), 'codex')
    ).toEqual({ model: MODEL })
  })
})
