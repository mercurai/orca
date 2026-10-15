// Restoring a record's options once the provider reports: a canonical serviceTier outranks saved
// fastMode and tier values, and saved intent the host cannot yet confirm survives the report.

import { describe, expect, it } from 'vitest'
import type { AgentSessionOptionsResult } from '../../../shared/agent-session-wire'
import { nativeSessionOptionsFromReport } from './structured-agent-session-option-restoration'

// Synthetic ids: the catalog, not Orca, decides which request tier IDs exist.
const MODEL = 'synthetic-model-a'
const OTHER_MODEL = 'synthetic-model-b'
const CUSTOM_TIER = 'Tier.Ultra-9c1'
const STALE_TIER = 'Tier.Retired-2f0'
const UNRELATED = { approvalsReviewer: 'user', personality: 'pragmatic' }

type ReportedCurrent = AgentSessionOptionsResult['current'] & { serviceTier?: string }
type EncodedOptions = Readonly<Record<string, string>>

function restore(
  reported: ReportedCurrent,
  priorOptions?: EncodedOptions,
  restoreSkipped: readonly string[] = []
): EncodedOptions {
  return nativeSessionOptionsFromReport({
    reported,
    restoreSkipped,
    ...(priorOptions ? { priorOptions } : {})
  })
}

describe('a canonical reported serviceTier on restore', () => {
  it('replaces the stale saved tier and keeps model, effort and unrelated options', () => {
    const options = restore(
      { model: MODEL, effort: 'high', serviceTier: CUSTOM_TIER },
      { model: OTHER_MODEL, effort: 'low', serviceTier: STALE_TIER, ...UNRELATED }
    )

    expect(options).toEqual({
      ...UNRELATED,
      model: MODEL,
      effort: 'high',
      serviceTier: CUSTOM_TIER
    })
  })

  it.each([
    ['saved Fast on', 'true', 'default'],
    ['saved Fast off', 'false', 'default'],
    ['saved Fast on', 'true', CUSTOM_TIER],
    ['saved Fast off', 'false', CUSTOM_TIER]
  ])('replaces a stale fastMode (%s) with the reported tier %s', (_name, fastMode, serviceTier) => {
    const options = restore(
      { model: MODEL, effort: 'medium', serviceTier },
      { model: MODEL, effort: 'medium', fastMode, ...UNRELATED }
    )

    expect(options).toEqual({ ...UNRELATED, model: MODEL, effort: 'medium', serviceTier })
    expect(options).not.toHaveProperty('fastMode')
  })

  it('replaces both a stale tier and a stale fastMode saved together', () => {
    const options = restore(
      { model: MODEL, serviceTier: 'default' },
      { model: MODEL, fastMode: 'true', serviceTier: STALE_TIER }
    )

    expect(options).toEqual({ model: MODEL, serviceTier: 'default' })
  })

  it.each([
    ['true', true],
    ['false', false]
  ])('outranks a reported fastMode=%s that rides beside it', (_name, fastMode) => {
    const options = restore({ model: MODEL, fastMode, serviceTier: CUSTOM_TIER }, { model: MODEL })

    expect(options).toEqual({ model: MODEL, serviceTier: CUSTOM_TIER })
    expect(options).not.toHaveProperty('fastMode')
  })

  it.each(['default', CUSTOM_TIER, 'UltraFast_v2', 'vendor/tier.3'])(
    'persists the exact id %s when nothing was saved before',
    (serviceTier) => {
      expect(restore({ model: MODEL, serviceTier })).toEqual({ model: MODEL, serviceTier })
    }
  )

  it('still drops an option the child could not take while it keeps the tier', () => {
    const options = restore(
      { model: MODEL, serviceTier: CUSTOM_TIER },
      { personality: 'pragmatic', approvalsReviewer: 'user', serviceTier: STALE_TIER },
      ['personality']
    )

    expect(options).toEqual({ approvalsReviewer: 'user', model: MODEL, serviceTier: CUSTOM_TIER })
  })
})

describe('a report that carries no canonical tier', () => {
  it.each([
    ['replaces a saved false', 'false', true, 'true'],
    ['replaces a saved true', 'true', false, 'false']
  ])('a legacy fastMode %s and invents no tier', (_name, saved, reportedFast, expected) => {
    const options = restore(
      { model: MODEL, effort: 'high', fastMode: reportedFast },
      { model: MODEL, effort: 'high', fastMode: saved, ...UNRELATED }
    )

    expect(options).toEqual({
      ...UNRELATED,
      model: MODEL,
      effort: 'high',
      fastMode: expected
    })
    expect(options).not.toHaveProperty('serviceTier')
  })

  it('records a first legacy fastMode without minting a tier from it', () => {
    const options = restore({ model: MODEL, fastMode: true })

    expect(options).toEqual({ model: MODEL, fastMode: 'true' })
    expect(options).not.toHaveProperty('serviceTier')
  })

  it("keeps another provider's boolean control and model as they were reported", () => {
    const options = restore(
      { model: 'opus[1m]', effort: 'max', fastMode: true },
      { model: 'sonnet', effort: 'low', fastMode: 'false', thinking: 'on' }
    )

    expect(options).toEqual({ model: 'opus[1m]', effort: 'max', fastMode: 'true', thinking: 'on' })
    expect(options).not.toHaveProperty('serviceTier')
  })

  it('adds no tier when a provider reports only its model and effort', () => {
    const options = restore({ model: 'opus[1m]', effort: 'max' }, { thinking: 'on' })

    expect(options).toEqual({ model: 'opus[1m]', effort: 'max', thinking: 'on' })
    expect(options).not.toHaveProperty('serviceTier')
  })

  it('still drops a stale saved fastMode when another provider reports neither fastMode nor tier', () => {
    const options = restore(
      { model: 'opus[1m]', effort: 'max' },
      { model: 'sonnet', effort: 'low', fastMode: 'true', thinking: 'on' }
    )

    expect(options).toEqual({ model: 'opus[1m]', effort: 'max', thinking: 'on' })
    expect(options).not.toHaveProperty('fastMode')
    expect(options).not.toHaveProperty('serviceTier')
  })
})

describe('a saved tier the host has not confirmed', () => {
  const saved = { model: MODEL, effort: 'high', serviceTier: STALE_TIER, ...UNRELATED }

  it('survives a report that names no tier', () => {
    expect(restore({ model: MODEL, effort: 'high' }, saved)).toEqual(saved)
  })

  it('survives a model and effort change to a model that lacks the tier', () => {
    expect(restore({ model: OTHER_MODEL, effort: 'low' }, saved)).toEqual({
      ...UNRELATED,
      model: OTHER_MODEL,
      effort: 'low',
      serviceTier: STALE_TIER
    })
  })

  // Two sequential reports; not a disk round trip.
  it.each(['default', CUSTOM_TIER])(
    'gives way only to the host acknowledging canonical tier %s',
    (acknowledged) => {
      const silent = restore({ model: MODEL, effort: 'high' }, saved)
      expect(silent.serviceTier).toBe(STALE_TIER)

      const acknowledgedOptions = restore(
        { model: MODEL, effort: 'high', serviceTier: acknowledged },
        silent
      )

      expect(acknowledgedOptions).toEqual({ ...saved, serviceTier: acknowledged })
    }
  )
})

// The Codex-owned reader reports an unresolved fastMode=true in current.fastMode; the generic
// restoration stays provider-neutral and honors that report.
describe('a legacy fastMode=true the catalog cannot resolve to a tier', () => {
  const saved = { model: MODEL, effort: 'high', fastMode: 'true', ...UNRELATED }

  it('stays when the report repeats fastMode=true without a tier, inventing none', () => {
    const options = restore({ model: MODEL, effort: 'high', fastMode: true }, saved)

    expect(options).toEqual(saved)
    expect(options).not.toHaveProperty('serviceTier')
  })

  it('stays through a model and effort change that still reports fastMode=true', () => {
    const options = restore({ model: OTHER_MODEL, effort: 'low', fastMode: true }, saved)

    expect(options).toEqual({ ...saved, model: OTHER_MODEL, effort: 'low' })
    expect(options).not.toHaveProperty('serviceTier')
  })

  it('gives way once the host reports the advertised Fast tier', () => {
    const options = restore({ model: MODEL, effort: 'high', serviceTier: CUSTOM_TIER }, saved)

    expect(options).toEqual({
      ...UNRELATED,
      model: MODEL,
      effort: 'high',
      serviceTier: CUSTOM_TIER
    })
    expect(options).not.toHaveProperty('fastMode')
  })
})
