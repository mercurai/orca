// The private record of a refused speed pick: when it is made, what keeps it, what clears it, and
// what it blocks. Synthetic ids only; the catalog, not Orca, decides which tiers exist.

import { describe, expect, it } from 'vitest'
import type { AgentSessionModelOption } from '../../shared/agent-session-wire'
import { CodexServiceTierSelectionError } from '../../shared/codex-service-tier-selection'
import type { RestingOptionsNormalizeInput } from '../../shared/structured-agent-session-resting-options'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import {
  admitCodexSpeedIntentForTurn,
  normalizeCodexSpeedIntent,
  readCodexSpeedIntent,
  refusedCodexServiceTier
} from './codex-structured-speed-intent'

const STANDARD = { value: 'default', label: 'Standard' }
const FAST = { value: 'tier-fast-7f3', label: 'Fast' }
const CUSTOM = { value: 'tier-custom-5e2', label: 'Custom' }
const MODEL = 'synthetic-model-a'

function model(serviceTiers?: AgentSessionModelOption['serviceTiers']): AgentSessionModelOption {
  return {
    id: MODEL,
    label: 'A',
    isDefault: true,
    efforts: [{ value: 'high', label: 'High' }],
    ...(serviceTiers ? { serviceTiers } : {})
  }
}

const advertised = [model([STANDARD, FAST])]
const prior = { model: MODEL, serviceTier: FAST.value }

function normalize(
  priorOptions: Record<string, string>,
  changes: Record<string, string>,
  overrides: Partial<RestingOptionsNormalizeInput> = {}
): Record<string, string> {
  return normalizeCodexSpeedIntent({
    priorOptions,
    changes,
    origin: 'set-option',
    models: advertised,
    currentModel: MODEL,
    catalogKnown: true,
    ...overrides
  })
}

/** The complete map a refused explicit pick asks the host to persist. */
function refusalOf(changes: Record<string, string>, models = advertised): Record<string, string> {
  try {
    normalize(prior, changes, { models })
  } catch (error) {
    if (error instanceof AgentSessionOptionRejectedError && error.refusalOptions) {
      expect(error.refusalReason).toBe('optionRejected')
      return { ...error.refusalOptions }
    }
    throw error
  }
  throw new Error('the pick was accepted')
}

describe('a refused explicit speed pick', () => {
  it('is refused with the complete map that remembers the request beside the accepted tier', () => {
    const refusal = refusalOf({ serviceTier: CUSTOM.value })

    expect(refusal.model).toBe(MODEL)
    expect(refusal.serviceTier).toBe(FAST.value)
    expect(refusedCodexServiceTier(refusal)).toBe(CUSTOM.value)
  })

  it('is remembered when the catalog states nothing about the tier, not only when it denies it', () => {
    const refusal = refusalOf({ serviceTier: CUSTOM.value }, [model()])

    expect(refusedCodexServiceTier(refusal)).toBe(CUSTOM.value)
  })

  it.each([
    ['a blank tier', { serviceTier: ' ' }],
    ['a malformed Fast toggle', { fastMode: 'maybe' }]
  ])('invents no record for %s', (_name, changes) => {
    let thrown: unknown
    try {
      normalize(prior, changes)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(CodexServiceTierSelectionError)
    expect(thrown).not.toBeInstanceOf(AgentSessionOptionRejectedError)
  })

  it('keeps the record through restore, model and effort changes', () => {
    const refusal = refusalOf({ serviceTier: CUSTOM.value })

    for (const [origin, changes] of [
      ['restore', {}],
      ['launch', {}],
      ['set-option', { model: MODEL }],
      ['set-option', { effort: 'high' }]
    ] as const) {
      const next = normalize(refusal, changes, { origin })
      expect(refusedCodexServiceTier(next)).toBe(CUSTOM.value)
      expect(next.serviceTier).toBe(FAST.value)
    }
  })

  it.each([
    ['an advertised tier', { serviceTier: FAST.value }],
    ['protocol Standard', { serviceTier: STANDARD.value }],
    ['a legacy Fast toggle', { fastMode: 'false' }]
  ])('is replaced only by an accepted explicit action: %s', (_name, changes) => {
    const refusal = refusalOf({ serviceTier: CUSTOM.value })

    expect(refusedCodexServiceTier(normalize(refusal, changes))).toBeUndefined()
  })

  it('stays when the replacement is itself refused, now naming the newest request', () => {
    const refusal = refusalOf({ serviceTier: CUSTOM.value })
    const other = { value: 'tier-other-1a9', label: 'Other' }

    let next: Record<string, string> | undefined
    try {
      normalize(refusal, { serviceTier: other.value })
    } catch (error) {
      next = error instanceof AgentSessionOptionRejectedError ? error.refusalOptions : undefined
    }

    expect(next && refusedCodexServiceTier(next)).toBe(other.value)
  })
})

describe('what a refused speed pick reports and blocks', () => {
  const readInput = (options: Record<string, string>, models = advertised) => ({
    options,
    models,
    currentModel: MODEL,
    catalogKnown: true
  })

  it('reads the accepted tier as current and the refused id as the blocked selection', () => {
    const read = readCodexSpeedIntent(readInput(refusalOf({ serviceTier: CUSTOM.value })))

    expect(read.current).toMatchObject({ serviceTier: FAST.value })
    expect(read.speed.selection).toEqual({ tierId: CUSTOM.value, state: 'unavailable' })
  })

  it('stays blocked even after a refresh offers the refused id', () => {
    const offered = [model([STANDARD, FAST, CUSTOM])]
    const options = refusalOf({ serviceTier: CUSTOM.value })

    expect(readCodexSpeedIntent(readInput(options, offered)).speed.selection).toEqual({
      tierId: CUSTOM.value,
      state: 'unavailable'
    })
    expect(() => admitCodexSpeedIntentForTurn(readInput(options, offered))).toThrow('refused')
  })

  it('reads unknown rather than unavailable while the catalog states no tiers', () => {
    const options = refusalOf({ serviceTier: CUSTOM.value })

    expect(readCodexSpeedIntent(readInput(options, [model()])).speed.selection).toEqual({
      tierId: CUSTOM.value,
      state: 'unknown'
    })
  })

  it('refuses the next turn naming the refused id, and sends the accepted tier once cleared', () => {
    const options = refusalOf({ serviceTier: CUSTOM.value })

    let thrown: unknown
    try {
      admitCodexSpeedIntentForTurn(readInput(options))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(CodexServiceTierSelectionError)
    expect(thrown).toMatchObject({ tierId: CUSTOM.value })

    expect(admitCodexSpeedIntentForTurn(readInput(prior))).toBe(FAST.value)
  })
})
