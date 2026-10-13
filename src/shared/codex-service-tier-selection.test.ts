import { describe, expect, it } from 'vitest'
import type { AgentSessionModelOption, AgentSessionOptionChoice } from './agent-session-wire'
import {
  admitCodexServiceTierForTurn,
  codexFastTierId,
  codexServiceTierState,
  codexServiceTierSupport,
  codexStandardTierId,
  CodexServiceTierSelectionError,
  normalizeCodexServiceTierOptions,
  parseCodexModelServiceTiers,
  readCodexServiceTierOptions
} from './codex-service-tier-selection'
import {
  AGENT_SESSION_CODEX_SERVICE_TIERS_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES,
  RUNTIME_PROTOCOL_VERSION
} from './protocol-version'

// Synthetic ids throughout: the provider catalog, not Orca, decides which request tiers exist.
const STANDARD = { id: 'default', name: 'Standard', description: 'Regular speed and usage' }
const FAST = { id: 'tier-fast-7f3', name: 'Fast', description: 'Faster responses, more usage' }
const ULTRAFAST = { id: 'tier-ultra-9c1', name: 'Ultrafast', description: 'Fastest, highest usage' }

const MODEL_A = 'synthetic-model-a'
const MODEL_B = 'synthetic-model-b'

function choice(tier: { id: string; name: string; description: string }): AgentSessionOptionChoice {
  return { value: tier.id, label: tier.name, description: tier.description }
}

const STANDARD_CHOICE = choice(STANDARD)
const FAST_CHOICE = choice(FAST)
const ULTRAFAST_CHOICE = choice(ULTRAFAST)

function model(id: string, serviceTiers?: AgentSessionOptionChoice[]): AgentSessionModelOption {
  return { id, label: id, isDefault: false, efforts: [], ...(serviceTiers ? { serviceTiers } : {}) }
}

const FULL = [STANDARD_CHOICE, FAST_CHOICE, ULTRAFAST_CHOICE]
const MODELS = [model(MODEL_A, FULL), model(MODEL_B, [STANDARD_CHOICE])]

function thrownBy(attempt: () => unknown): unknown {
  try {
    attempt()
  } catch (error) {
    return error
  }
  return undefined
}

// Asserts the rejection class and the machine-readable fields callers translate into a wire refusal.
function expectSelectionError(attempt: () => unknown, fields: Record<string, unknown>): void {
  const error = thrownBy(attempt)
  expect(error).toBeInstanceOf(CodexServiceTierSelectionError)
  expect(error).toMatchObject(fields)
}

describe('parseCodexModelServiceTiers', () => {
  it('keeps modern serviceTiers as choices with exact ids, labels and descriptions', () => {
    expect(
      parseCodexModelServiceTiers({ serviceTiers: [STANDARD, FAST, ULTRAFAST] })
    ).toEqual(FULL)
  })

  it('reads snake_case service_tiers the same way', () => {
    expect(parseCodexModelServiceTiers({ service_tiers: [STANDARD, FAST] })).toEqual([
      STANDARD_CHOICE,
      FAST_CHOICE
    ])
  })

  it('prefers camelCase when both modern spellings are arrays', () => {
    expect(
      parseCodexModelServiceTiers({ serviceTiers: [STANDARD], service_tiers: [STANDARD, FAST] })
    ).toEqual([STANDARD_CHOICE])
  })

  it.each([
    ['serviceTiers', 'additionalSpeedTiers'],
    ['service_tiers', 'additional_speed_tiers']
  ])('lets an empty modern %s beat legacy %s', (modern, legacy) => {
    expect(parseCodexModelServiceTiers({ [modern]: [], [legacy]: ['fast', 'ultrafast'] })).toEqual([
      { value: 'default', label: 'Standard' }
    ])
  })

  it('lets a non-empty modern list beat legacy strings', () => {
    expect(
      parseCodexModelServiceTiers({ serviceTiers: [STANDARD], additionalSpeedTiers: ['fast'] })
    ).toEqual([STANDARD_CHOICE])
  })

  it('keeps a provider-advertised Standard id that is not the protocol default', () => {
    const standard = { ...STANDARD, id: 'tier-standard-2b4' }
    const tiers = parseCodexModelServiceTiers({ serviceTiers: [standard, FAST] })
    expect(tiers?.map((tier) => tier.value)).toEqual(['tier-standard-2b4', FAST.id])
  })

  it('adds protocol Standard first when the provider omits it, without touching other rows', () => {
    expect(parseCodexModelServiceTiers({ serviceTiers: [FAST, ULTRAFAST] })).toEqual([
      { value: 'default', label: 'Standard' },
      FAST_CHOICE,
      ULTRAFAST_CHOICE
    ])
  })

  it('deduplicates exact ids, first row wins, and keeps near-duplicates apart', () => {
    const shouted = { ...FAST, id: 'TIER-FAST-7F3' }
    const tiers = parseCodexModelServiceTiers({
      serviceTiers: [STANDARD, FAST, { ...FAST, name: 'Fast again' }, shouted]
    })
    expect(tiers).toEqual([
      STANDARD_CHOICE,
      FAST_CHOICE,
      { value: 'TIER-FAST-7F3', label: 'Fast', description: FAST.description }
    ])
  })

  it('skips malformed rows and falls back to the id when a row has no name', () => {
    const tiers = parseCodexModelServiceTiers({
      serviceTiers: [STANDARD, null, 'fast', { name: 'No id' }, { id: '  ' }, { id: 'bare-tier' }]
    })
    expect(tiers).toEqual([STANDARD_CHOICE, { value: 'bare-tier', label: 'bare-tier' }])
  })

  it.each(['additionalSpeedTiers', 'additional_speed_tiers'])(
    'turns legacy %s strings into exact request values beside Standard',
    (legacy) => {
      expect(
        parseCodexModelServiceTiers({ [legacy]: ['fast', 'ultrafast', 'turbo-x9', 'fast', 7, ''] })
      ).toEqual([
        { value: 'default', label: 'Standard' },
        { value: 'fast', label: 'fast' },
        { value: 'ultrafast', label: 'ultrafast' },
        { value: 'turbo-x9', label: 'turbo-x9' }
      ])
    }
  )

  it('treats an empty legacy list as known Standard-only support', () => {
    expect(parseCodexModelServiceTiers({ additionalSpeedTiers: [] })).toEqual([
      { value: 'default', label: 'Standard' }
    ])
  })

  it.each([
    ['no metadata', {}],
    ['non-array modern', { serviceTiers: 'fast', service_tiers: { id: 'fast' } }],
    ['non-array legacy', { additionalSpeedTiers: 'fast', additional_speed_tiers: 7 }],
    ['only unusable modern rows', { serviceTiers: [null, 3, { name: 'No id' }] }],
    ['only unusable legacy rows', { additionalSpeedTiers: [1, null, ' '] }]
  ])('leaves support unknown for %s', (_name, row) => {
    expect(parseCodexModelServiceTiers(row)).toBeUndefined()
  })

  it('never invents Ultrafast from a model name or a Fast-only list', () => {
    const modern = parseCodexModelServiceTiers({
      model: 'synthetic-ultrafast-model',
      serviceTiers: [STANDARD, FAST]
    })
    expect(modern?.map((tier) => tier.value)).toEqual([STANDARD.id, FAST.id])
    const legacy = parseCodexModelServiceTiers({ additionalSpeedTiers: ['fast'] })
    expect(legacy?.map((tier) => tier.value)).not.toContain('ultrafast')
  })
})

describe('Standard and Fast compatibility ids', () => {
  it('finds the advertised Standard id and falls back to the protocol default', () => {
    const custom = [{ value: 'tier-standard-2b4', label: 'Standard' }, FAST_CHOICE]
    expect(codexStandardTierId(custom)).toBe('tier-standard-2b4')
    expect(codexStandardTierId([FAST_CHOICE])).toBe('default')
    expect(codexStandardTierId(undefined)).toBe('default')
  })

  it('finds Fast by label or id, case-insensitively, and never picks Ultrafast', () => {
    expect(codexFastTierId(FULL)).toBe(FAST.id)
    expect(codexFastTierId([{ value: 'FAST', label: 'Quick' }])).toBe('FAST')
    expect(codexFastTierId([STANDARD_CHOICE, ULTRAFAST_CHOICE])).toBeUndefined()
    expect(codexFastTierId(undefined)).toBeUndefined()
  })
})

describe('codexServiceTierSupport and codexServiceTierState', () => {
  const known = (modelId: string | undefined) =>
    codexServiceTierSupport({ models: MODELS, modelId, catalogKnown: true })

  it('is known only for a listed model with tier metadata in a known catalog', () => {
    expect(known(MODEL_A)).toEqual({ known: true, tiers: FULL })
    expect(known('synthetic-missing')).toEqual({ known: false })
    expect(known(undefined)).toEqual({ known: false })
    expect(
      codexServiceTierSupport({ models: MODELS, modelId: MODEL_A, catalogKnown: false })
    ).toEqual({ known: false })
    expect(
      codexServiceTierSupport({ models: [model(MODEL_A)], modelId: MODEL_A, catalogKnown: true })
    ).toEqual({ known: false })
  })

  it('admits protocol Standard whatever the metadata says', () => {
    expect(codexServiceTierState('default', { known: false })).toBe('ready')
    expect(codexServiceTierState('default', known(MODEL_B))).toBe('ready')
    expect(
      codexServiceTierState('default', { known: true, tiers: [{ value: 'tier-std', label: 'Standard' }] })
    ).toBe('ready')
  })

  it('admits an advertised id, blocks an unlisted id and cannot judge unknown support', () => {
    expect(codexServiceTierState(FAST.id, known(MODEL_A))).toBe('ready')
    expect(codexServiceTierState(FAST.id, known(MODEL_B))).toBe('unavailable')
    expect(codexServiceTierState(FAST.id, { known: false })).toBe('unknown')
    expect(codexServiceTierState('TIER-FAST-7F3', known(MODEL_A))).toBe('unavailable')
  })
})

describe('normalizeCodexServiceTierOptions', () => {
  function normalize(
    input: Partial<Parameters<typeof normalizeCodexServiceTierOptions>[0]> & {
      origin: Parameters<typeof normalizeCodexServiceTierOptions>[0]['origin']
    }
  ) {
    return normalizeCodexServiceTierOptions({
      priorOptions: {},
      changes: {},
      models: MODELS,
      currentModel: MODEL_A,
      catalogKnown: true,
      ...input
    })
  }

  describe('migrating legacy fastMode', () => {
    it('maps false to protocol Standard when support is unknown', () => {
      expect(
        normalize({
          origin: 'restore',
          priorOptions: { model: MODEL_A, fastMode: 'false' },
          catalogKnown: false
        })
      ).toEqual({ model: MODEL_A, serviceTier: 'default' })
    })

    it('maps false to the advertised Standard id', () => {
      const models = [model(MODEL_A, [{ value: 'tier-std', label: 'Standard' }, FAST_CHOICE])]
      expect(
        normalize({ origin: 'restore', models, priorOptions: { model: MODEL_A, fastMode: 'false' } })
      ).toEqual({ model: MODEL_A, serviceTier: 'tier-std' })
    })

    it('maps true to the advertised Fast id only', () => {
      expect(
        normalize({ origin: 'restore', priorOptions: { model: MODEL_A, fastMode: 'true' } })
      ).toEqual({ model: MODEL_A, serviceTier: FAST.id })
    })

    it.each([
      ['a Standard-only model', { model: MODEL_B, fastMode: 'true' }, true],
      ['an unknown catalog', { model: MODEL_A, fastMode: 'true' }, false]
    ])('keeps true as unresolved intent on %s', (_name, priorOptions, catalogKnown) => {
      const options = normalize({ origin: 'launch', priorOptions, catalogKnown })
      expect(options).toEqual(priorOptions)
      expect(options).not.toHaveProperty('serviceTier')
    })

    it('drops a fastMode value that is neither true nor false', () => {
      expect(
        normalize({ origin: 'restore', priorOptions: { model: MODEL_A, fastMode: 'maybe' } })
      ).toEqual({ model: MODEL_A })
    })
  })

  describe('restore and launch', () => {
    it.each(['restore', 'launch'] as const)('%s lets a canonical tier beat saved legacy', (origin) => {
      expect(
        normalize({
          origin,
          priorOptions: { model: MODEL_A, serviceTier: ULTRAFAST.id, fastMode: 'false' }
        })
      ).toEqual({ model: MODEL_A, serviceTier: ULTRAFAST.id })
      expect(
        normalize({
          origin,
          priorOptions: { model: MODEL_A, serviceTier: FAST.id },
          changes: { fastMode: 'false' }
        })
      ).toEqual({ model: MODEL_A, serviceTier: FAST.id })
    })

    it.each(['restore', 'launch'] as const)(
      '%s keeps an unavailable or unknown custom id as intent without throwing',
      (origin) => {
        const retired = { model: MODEL_B, serviceTier: 'Tier.Retired-2f0', approvalsReviewer: 'user' }
        expect(normalize({ origin, priorOptions: retired })).toEqual(retired)
        expect(normalize({ origin, priorOptions: retired, catalogKnown: false })).toEqual(retired)
      }
    )

    it('drops a blank canonical tier rather than treating it as a selection', () => {
      expect(
        normalize({ origin: 'launch', priorOptions: { model: MODEL_A }, changes: { serviceTier: '  ' } })
      ).toEqual({ model: MODEL_A })
    })
  })

  describe('set-option', () => {
    it('stores an advertised tier, removes stale fastMode and keeps every other key', () => {
      expect(
        normalize({
          origin: 'set-option',
          priorOptions: { model: MODEL_A, effort: 'high', fastMode: 'false', personality: 'pragmatic' },
          changes: { serviceTier: ULTRAFAST.id }
        })
      ).toEqual({
        model: MODEL_A,
        effort: 'high',
        personality: 'pragmatic',
        serviceTier: ULTRAFAST.id
      })
    })

    it('accepts protocol Standard even when metadata is unknown', () => {
      expect(
        normalize({
          origin: 'set-option',
          priorOptions: { model: MODEL_A },
          changes: { serviceTier: 'default' },
          catalogKnown: false
        })
      ).toEqual({ model: MODEL_A, serviceTier: 'default' })
    })

    it.each([
      ['an unlisted id on a known catalog', { catalogKnown: true, tier: ULTRAFAST.id, model: MODEL_B }, 'unavailable'],
      ['a custom id on an unknown catalog', { catalogKnown: false, tier: FAST.id, model: MODEL_A }, 'unknown'],
      ['a blank id', { catalogKnown: true, tier: '  ', model: MODEL_A }, 'invalid']
    ])('rejects an explicit write of %s', (_name, { catalogKnown, tier, model: modelId }, reason) => {
      const attempt = () =>
        normalize({
          origin: 'set-option',
          priorOptions: { model: modelId },
          changes: { serviceTier: tier },
          catalogKnown
        })
      expectSelectionError(attempt, { reason })
    })

    it('validates against the model named in the same change', () => {
      expect(
        normalize({
          origin: 'set-option',
          priorOptions: { model: MODEL_B },
          changes: { model: MODEL_A, serviceTier: ULTRAFAST.id }
        })
      ).toEqual({ model: MODEL_A, serviceTier: ULTRAFAST.id })
      expectSelectionError(
        () =>
          normalize({
            origin: 'set-option',
            priorOptions: { model: MODEL_A },
            changes: { model: MODEL_B, serviceTier: ULTRAFAST.id }
          }),
        { reason: 'unavailable', tierId: ULTRAFAST.id }
      )
    })

    it('falls back to the current model when no option names one', () => {
      expect(
        normalize({ origin: 'set-option', changes: { serviceTier: FAST.id }, currentModel: MODEL_A })
      ).toEqual({ serviceTier: FAST.id })
      expectSelectionError(
        () =>
          normalize({ origin: 'set-option', changes: { serviceTier: FAST.id }, currentModel: MODEL_B }),
        { reason: 'unavailable', tierId: FAST.id }
      )
    })

    it('treats an old-client fastMode toggle as a new action replacing the canonical tier', () => {
      const prior = { model: MODEL_A, serviceTier: ULTRAFAST.id, effort: 'low' }
      expect(normalize({ origin: 'set-option', priorOptions: prior, changes: { fastMode: 'false' } })).toEqual({
        model: MODEL_A,
        effort: 'low',
        serviceTier: 'default'
      })
      expect(normalize({ origin: 'set-option', priorOptions: prior, changes: { fastMode: 'true' } })).toEqual({
        model: MODEL_A,
        effort: 'low',
        serviceTier: FAST.id
      })
    })

    it.each([
      ['an advertised tier', ULTRAFAST.id, true],
      ['a retired custom tier', 'Tier.Retired-2f0', false]
    ])(
      'refuses a malformed explicit fastMode toggle over %s without touching it',
      (_name, tier, catalogKnown) => {
        const priorOptions = Object.freeze({ model: MODEL_A, serviceTier: tier, effort: 'low' })
        for (const fastMode of ['maybe', 'TRUE', '']) {
          const changes = Object.freeze({ fastMode })
          expectSelectionError(
            () =>
              normalizeCodexServiceTierOptions({
                priorOptions,
                changes,
                origin: 'set-option',
                models: MODELS,
                currentModel: MODEL_A,
                catalogKnown
              }),
            { reason: 'invalid', legacyFastMode: true }
          )
          expect(priorOptions).toEqual({ model: MODEL_A, serviceTier: tier, effort: 'low' })
          expect(changes).toEqual({ fastMode })
        }
      }
    )

    it('ignores a malformed fastMode that rides beside an explicit serviceTier', () => {
      expect(
        normalize({
          origin: 'set-option',
          priorOptions: { model: MODEL_A },
          changes: { serviceTier: FAST.id, fastMode: 'maybe' }
        })
      ).toEqual({ model: MODEL_A, serviceTier: FAST.id })
    })

    it('keeps an unresolved Fast toggle as intent and removes the canonical tier it replaced', () => {
      const options = normalize({
        origin: 'set-option',
        priorOptions: { model: MODEL_B, serviceTier: 'default' },
        changes: { fastMode: 'true' }
      })
      expect(options).toEqual({ model: MODEL_B, fastMode: 'true' })
    })

    it('lets an explicit serviceTier beat a fastMode sent in the same change', () => {
      expect(
        normalize({
          origin: 'set-option',
          priorOptions: { model: MODEL_A },
          changes: { serviceTier: ULTRAFAST.id, fastMode: 'false' }
        })
      ).toEqual({ model: MODEL_A, serviceTier: ULTRAFAST.id })
    })
  })

  describe('model and effort changes', () => {
    it('retain the tier on a destination model that lacks it, still without throwing', () => {
      expect(
        normalize({
          origin: 'set-option',
          priorOptions: { model: MODEL_A, serviceTier: ULTRAFAST.id },
          changes: { model: MODEL_B }
        })
      ).toEqual({ model: MODEL_B, serviceTier: ULTRAFAST.id })
    })

    it('retain the tier through an effort change', () => {
      expect(
        normalize({
          origin: 'set-option',
          priorOptions: { model: MODEL_B, serviceTier: ULTRAFAST.id },
          changes: { effort: 'high' }
        })
      ).toEqual({ model: MODEL_B, effort: 'high', serviceTier: ULTRAFAST.id })
    })

    it('resolve an unresolved Fast intent once the destination model advertises Fast', () => {
      expect(
        normalize({
          origin: 'set-option',
          priorOptions: { model: MODEL_B, fastMode: 'true' },
          changes: { model: MODEL_A }
        })
      ).toEqual({ model: MODEL_A, serviceTier: FAST.id })
    })
  })

  it('never mutates its inputs', () => {
    const priorOptions = Object.freeze({ model: MODEL_A, fastMode: 'false' })
    const changes = Object.freeze({ effort: 'high' })
    expect(
      normalizeCodexServiceTierOptions({
        priorOptions,
        changes,
        origin: 'set-option',
        models: MODELS,
        currentModel: MODEL_A,
        catalogKnown: true
      })
    ).toEqual({ model: MODEL_A, effort: 'high', serviceTier: 'default' })
  })
})

describe('readCodexServiceTierOptions', () => {
  function read(options: Record<string, string>, catalogKnown = true, currentModel = MODEL_A) {
    return readCodexServiceTierOptions({ options, models: MODELS, currentModel, catalogKnown })
  }

  it('reports unselected for an untouched session and invents no current values', () => {
    expect(read({ model: MODEL_A })).toEqual({ current: {}, speed: { selection: { state: 'unselected' } } })
  })

  it('reports an advertised canonical tier as ready with the exact id', () => {
    expect(read({ model: MODEL_A, serviceTier: ULTRAFAST.id })).toEqual({
      current: { serviceTier: ULTRAFAST.id },
      speed: { selection: { tierId: ULTRAFAST.id, state: 'ready' } }
    })
  })

  it('projects the legacy boolean only for Standard and the advertised Fast', () => {
    expect(read({ model: MODEL_A, serviceTier: FAST.id }).current).toEqual({
      serviceTier: FAST.id,
      fastMode: true
    })
    expect(read({ model: MODEL_A, serviceTier: 'default' }).current).toEqual({
      serviceTier: 'default',
      fastMode: false
    })
  })

  it('reports protocol Standard as ready even when the catalog is unknown', () => {
    expect(read({ model: MODEL_A, serviceTier: 'default' }, false).speed.selection).toEqual({
      tierId: 'default',
      state: 'ready'
    })
  })

  it('separates unavailable (known catalog lacks it) from unknown (cannot tell)', () => {
    expect(read({ model: MODEL_B, serviceTier: ULTRAFAST.id }).speed.selection).toEqual({
      tierId: ULTRAFAST.id,
      state: 'unavailable'
    })
    expect(read({ model: MODEL_A, serviceTier: ULTRAFAST.id }, false).speed.selection).toEqual({
      tierId: ULTRAFAST.id,
      state: 'unknown'
    })
  })

  it('keeps a retired custom id as the current value', () => {
    expect(read({ model: MODEL_A, serviceTier: 'Tier.Retired-2f0' }).current).toEqual({
      serviceTier: 'Tier.Retired-2f0'
    })
  })

  it('uses the current model when the options name none', () => {
    expect(read({ serviceTier: ULTRAFAST.id }, true, MODEL_B).speed.selection.state).toBe('unavailable')
    expect(read({ serviceTier: ULTRAFAST.id }, true, MODEL_A).speed.selection.state).toBe('ready')
  })

  it('migrates a saved fastMode on read: false to Standard, true to the advertised Fast', () => {
    expect(read({ model: MODEL_A, fastMode: 'false' })).toEqual({
      current: { serviceTier: 'default', fastMode: false },
      speed: { selection: { tierId: 'default', state: 'ready' } }
    })
    expect(read({ model: MODEL_A, fastMode: 'true' })).toEqual({
      current: { serviceTier: FAST.id, fastMode: true },
      speed: { selection: { tierId: FAST.id, state: 'ready' } }
    })
  })

  it('reports unresolved Fast intent as legacy, unavailable on a known catalog and unknown otherwise', () => {
    expect(read({ model: MODEL_B, fastMode: 'true' })).toEqual({
      current: { fastMode: true },
      speed: { selection: { legacyFastMode: true, state: 'unavailable' } }
    })
    expect(read({ model: MODEL_A, fastMode: 'true' }, false)).toEqual({
      current: { fastMode: true },
      speed: { selection: { legacyFastMode: true, state: 'unknown' } }
    })
  })

  it('lets a canonical tier beat a coexisting fastMode', () => {
    expect(read({ model: MODEL_A, serviceTier: ULTRAFAST.id, fastMode: 'false' })).toEqual({
      current: { serviceTier: ULTRAFAST.id },
      speed: { selection: { tierId: ULTRAFAST.id, state: 'ready' } }
    })
  })

  it('ignores a blank tier and an undecodable fastMode', () => {
    expect(read({ model: MODEL_A, serviceTier: ' ', fastMode: 'maybe' }).speed.selection).toEqual({
      state: 'unselected'
    })
  })
})

describe('admitCodexServiceTierForTurn', () => {
  function admit(options: Record<string, string>, catalogKnown = true) {
    return () =>
      admitCodexServiceTierForTurn({ options, models: MODELS, currentModel: MODEL_A, catalogKnown })
  }

  it('sends nothing for an untouched session', () => {
    expect(admit({ model: MODEL_A })()).toBeUndefined()
  })

  it('returns the exact id of a ready selection', () => {
    expect(admit({ model: MODEL_A, serviceTier: ULTRAFAST.id })()).toBe(ULTRAFAST.id)
    expect(admit({ model: MODEL_A, fastMode: 'false' })()).toBe('default')
    expect(admit({ model: MODEL_A, fastMode: 'true' })()).toBe(FAST.id)
  })

  it('admits migrated Standard when the catalog is unknown', () => {
    expect(admit({ model: MODEL_A, fastMode: 'false' }, false)()).toBe('default')
  })

  it('rejects an unavailable tier with its reason and id, never downgrading', () => {
    expectSelectionError(admit({ model: MODEL_B, serviceTier: ULTRAFAST.id }), {
      reason: 'unavailable',
      tierId: ULTRAFAST.id
    })
  })

  it('rejects an unverifiable custom tier and unresolved legacy Fast', () => {
    expectSelectionError(admit({ model: MODEL_A, serviceTier: ULTRAFAST.id }, false), {
      reason: 'unknown',
      tierId: ULTRAFAST.id
    })
    expectSelectionError(admit({ model: MODEL_B, fastMode: 'true' }), {
      reason: 'unavailable',
      legacyFastMode: true
    })
    expectSelectionError(admit({ model: MODEL_A, fastMode: 'true' }, false), {
      reason: 'unknown',
      legacyFastMode: true
    })
  })
})

// Tier ids are stored as durable option values, so the record's 512-character bound applies.
describe('bounded tier ids', () => {
  const fits = 't'.repeat(512)
  const tooLong = 't'.repeat(513)
  const fitsChoice = { value: fits, label: 'Fits' }
  const tooLongChoice = { value: tooLong, label: 'Too long' }
  const read = (options: Record<string, string>, models: AgentSessionModelOption[], known = true) =>
    readCodexServiceTierOptions({ options, models, currentModel: MODEL_A, catalogKnown: known })

  describe('catalog parsing', () => {
    it('keeps an exact 512-character id and drops a 513-character one, never truncating', () => {
      const modern = parseCodexModelServiceTiers({
        serviceTiers: [STANDARD, { id: fits, name: 'Fits' }, { id: tooLong, name: 'Too long' }]
      })
      expect(modern).toEqual([STANDARD_CHOICE, fitsChoice])
      const legacy = parseCodexModelServiceTiers({ additional_speed_tiers: [fits, tooLong] })
      expect(legacy?.map((tier) => tier.value)).toEqual(['default', fits])
    })

    it.each([
      ['modern', { serviceTiers: [{ id: tooLong }] }],
      ['legacy', { additionalSpeedTiers: [tooLong] }]
    ])('leaves support unknown when every %s row is oversized', (_name, row) => {
      expect(parseCodexModelServiceTiers(row)).toBeUndefined()
    })

    it('replaces an oversized advertised Standard with protocol Standard', () => {
      expect(
        parseCodexModelServiceTiers({ serviceTiers: [{ id: tooLong, name: 'Standard' }, FAST] })
      ).toEqual([{ value: 'default', label: 'Standard' }, FAST_CHOICE])
    })
  })

  describe('compatibility ids and admission state', () => {
    it('never resolves Standard or Fast to an oversized id', () => {
      expect(codexStandardTierId([{ value: tooLong, label: 'Standard' }])).toBe('default')
      expect(codexFastTierId([{ value: tooLong, label: 'Fast' }])).toBeUndefined()
      expect(codexFastTierId([{ value: fits, label: 'Fast' }])).toBe(fits)
    })

    it('cannot admit an oversized id even when a caller lists it', () => {
      const listed = { known: true, tiers: [fitsChoice, tooLongChoice] } as const
      expect(codexServiceTierState(fits, listed)).toBe('ready')
      expect(codexServiceTierState(tooLong, listed)).toBe('unavailable')
      expect(codexServiceTierState(tooLong, { known: false })).toBe('unknown')
    })
  })

  describe('normalization and reading', () => {
    const wide = [model(MODEL_A, [STANDARD_CHOICE, fitsChoice])]
    const normalize = (
      origin: 'restore' | 'launch' | 'set-option',
      priorOptions: Record<string, string>,
      changes: Record<string, string> = {},
      models = wide
    ) =>
      normalizeCodexServiceTierOptions({
        priorOptions,
        changes,
        origin,
        models,
        currentModel: MODEL_A,
        catalogKnown: true
      })

    it('writes a 512-character advertised tier and rejects a 513-character one as invalid', () => {
      expect(normalize('set-option', { model: MODEL_A }, { serviceTier: fits })).toEqual({
        model: MODEL_A,
        serviceTier: fits
      })
      expectSelectionError(() => normalize('set-option', { model: MODEL_A }, { serviceTier: tooLong }), {
        reason: 'invalid'
      })
    })

    it('rejects an oversized write even when a hand-built catalog row lists it', () => {
      const hostile = [model(MODEL_A, [STANDARD_CHOICE, tooLongChoice])]
      expectSelectionError(
        () => normalize('set-option', { model: MODEL_A }, { serviceTier: tooLong }, hostile),
        { reason: 'invalid' }
      )
    })

    it('never migrates old Fast to an oversized tier or to Standard', () => {
      const hostile = [model(MODEL_A, [STANDARD_CHOICE, { value: tooLong, label: 'Fast' }])]
      const options = normalize('restore', { model: MODEL_A, fastMode: 'true' }, {}, hostile)
      expect(options).toEqual({ model: MODEL_A, fastMode: 'true' })
      expect(read({ model: MODEL_A, fastMode: 'true' }, hostile).speed.selection).toEqual({
        legacyFastMode: true,
        state: 'unavailable'
      })
    })

    it('migrates old Fast to a 512-character advertised Fast and old Standard past an oversized one', () => {
      const edge = [model(MODEL_A, [{ value: fits, label: 'Fast' }])]
      expect(normalize('restore', { model: MODEL_A, fastMode: 'true' }, {}, edge)).toEqual({
        model: MODEL_A,
        serviceTier: fits
      })
      const hostile = [model(MODEL_A, [{ value: tooLong, label: 'Standard' }])]
      expect(normalize('restore', { model: MODEL_A, fastMode: 'false' }, {}, hostile)).toEqual({
        model: MODEL_A,
        serviceTier: 'default'
      })
    })

    it('keeps a saved oversized canonical tier as blocked intent, never as Standard', () => {
      const saved = { model: MODEL_A, serviceTier: tooLong }
      expect(normalize('launch', saved)).toEqual(saved)
      expect(read(saved, wide).speed.selection).toEqual({ tierId: tooLong, state: 'unavailable' })
      expect(read(saved, wide, false).speed.selection).toEqual({ tierId: tooLong, state: 'unknown' })
      expectSelectionError(
        () =>
          admitCodexServiceTierForTurn({
            options: saved,
            models: wide,
            currentModel: MODEL_A,
            catalogKnown: true
          }),
        { reason: 'unavailable' }
      )
    })
  })
})

describe('Codex service-tier runtime capability', () => {
  it('is published by every host that publishes the runtime capability list, with no protocol bump', () => {
    expect(AGENT_SESSION_CODEX_SERVICE_TIERS_RUNTIME_CAPABILITY).toBe(
      'agent-session.codex-service-tiers.v1'
    )
    expect(RUNTIME_CAPABILITIES).toContain(AGENT_SESSION_CODEX_SERVICE_TIERS_RUNTIME_CAPABILITY)
    expect(RUNTIME_PROTOCOL_VERSION).toBe(3)
  })
})
