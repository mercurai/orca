import { describe, expect, it, vi } from 'vitest'
import {
  codexServiceTierState,
  codexServiceTierSupport,
  normalizeCodexServiceTierOptions
} from '../../shared/codex-service-tier-selection'
import {
  AgentModelCatalogStore,
  type AgentModelCatalogSource
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { codexSpeedCatalog, listingFromEntry } from './codex-structured-catalog-entry'
import { fetchCodexModelCatalogListing } from './codex-structured-model-catalog'

const FINGERPRINT = 'codex-test-account'
const OLD_FAST = 'old-fast-id'
const ULTRA = 'ultra-id'
const efforts = [{ value: 'high', label: 'High' }]
const access = (store: AgentModelCatalogStore) => ({
  store,
  fingerprint: FINGERPRINT,
  accountHomePath: '/a'
})

type Row = { id: string; serviceTiers?: { value: string; label: string }[] }

// Every write gets a later clock tick, so the newer of two listings is the one written last.
let clock = 0

function record(
  store: AgentModelCatalogStore,
  source: AgentModelCatalogSource,
  models: Row[],
  fastModeTierByModel: [string, string][] = []
): void {
  store.recordSuccess(
    FINGERPRINT,
    'codex',
    {
      models: models.map((model) => ({ ...model, label: model.id, isDefault: false, efforts })),
      fastModeTierByModel: new Map(fastModeTierByModel),
      origin: 'live-session'
    },
    source
  )
}

function storeWith(models: Row[], fastModeTierByModel: [string, string][] = []) {
  const store = new AgentModelCatalogStore({ now: () => ++clock })
  record(store, 'discovery', models, fastModeTierByModel)
  return store
}

// A model whose newest row states no tier metadata, after an older listing named its Fast id.
function storeWithStaleFastThenUnknownRow(): AgentModelCatalogStore {
  const store = storeWith(
    [
      {
        id: 'model-a',
        serviceTiers: [
          { value: 'default', label: 'Standard' },
          { value: OLD_FAST, label: 'Fast' }
        ]
      }
    ],
    [['model-a', OLD_FAST]]
  )
  record(store, 'live', [{ id: 'model-a' }])
  return store
}

function supportFor(store: AgentModelCatalogStore) {
  const catalog = codexSpeedCatalog(access(store))
  return {
    catalog,
    support: codexServiceTierSupport({
      models: catalog.models,
      modelId: 'model-a',
      catalogKnown: catalog.known
    })
  }
}

describe('a Codex catalog entry read for speed', () => {
  it('leaves tier support unknown for an entry that names only a Fast id, never a complete catalog', () => {
    const store = storeWith([{ id: 'model-a' }], [['model-a', 'legacy-fast-id']])

    const [model] = listingFromEntry(store.get(FINGERPRINT)!).models
    const { support } = supportFor(store)

    expect(model).not.toHaveProperty('serviceTiers')
    expect(support).toEqual({ known: false })
    expect(codexServiceTierState('legacy-fast-id', support)).toBe('unknown')
    expect(codexServiceTierState('default', support)).toBe('ready')
  })

  it('never overrides advertised tiers and never invents them for an unnamed model', () => {
    const advertised = [{ value: 'default', label: 'Standard' }]
    const store = storeWith(
      [{ id: 'model-a', serviceTiers: advertised }, { id: 'model-b' }],
      [['model-a', 'stale-fast-id']]
    )

    const [a, b] = listingFromEntry(store.get(FINGERPRINT)!).models

    expect(a?.serviceTiers).toEqual(advertised)
    expect(b).not.toHaveProperty('serviceTiers')
  })

  it('is known only for an account with a listing, so absence never reads as Standard-only', () => {
    const store = storeWith([{ id: 'model-a' }])

    expect(codexSpeedCatalog(access(store)).known).toBe(true)
    expect(codexSpeedCatalog({ store, fingerprint: 'other', accountHomePath: '/b' })).toEqual({
      models: [],
      known: false
    })
  })
})

describe('a newer listing row with no tier metadata beside an older listing that named Fast', () => {
  it('stays unknown instead of inheriting the older Fast id as a complete catalog', () => {
    const store = storeWithStaleFastThenUnknownRow()
    // The merged view takes the newer listing's row, which carries no tiers.
    expect(store.get(FINGERPRINT)?.models[0]).not.toHaveProperty('serviceTiers')

    const [model] = listingFromEntry(store.get(FINGERPRINT)!).models
    const { catalog, support } = supportFor(store)

    expect(catalog.known).toBe(true)
    expect(model).not.toHaveProperty('serviceTiers')
    expect(support).toEqual({ known: false })
  })

  it('classifies an unadvertised tier unknown, not unavailable, and admits no older Fast id', () => {
    const { support } = supportFor(storeWithStaleFastThenUnknownRow())

    expect(codexServiceTierState(ULTRA, support)).toBe('unknown')
    expect(codexServiceTierState(OLD_FAST, support)).toBe('unknown')
    expect(codexServiceTierState('default', support)).toBe('ready')
  })

  it('refuses an explicit older Fast id and leaves a Fast toggle unresolved', () => {
    const { catalog } = supportFor(storeWithStaleFastThenUnknownRow())
    const normalize = (changes: Record<string, string>) =>
      normalizeCodexServiceTierOptions({
        priorOptions: { model: 'model-a' },
        changes,
        origin: 'set-option',
        models: catalog.models,
        currentModel: 'model-a',
        catalogKnown: catalog.known
      })

    expect(() => normalize({ serviceTier: OLD_FAST })).toThrow('cannot be verified')
    expect(normalize({ fastMode: 'true' })).toEqual({ model: 'model-a', fastMode: 'true' })
  })

  it('lets a newer listing that advertises tiers replace the older Fast id outright', () => {
    const store = storeWithStaleFastThenUnknownRow()
    record(store, 'live', [
      { id: 'model-a', serviceTiers: [{ value: 'default', label: 'Standard' }] }
    ])

    const { support } = supportFor(store)

    expect(support.known).toBe(true)
    expect(codexServiceTierState(OLD_FAST, support)).toBe('unavailable')
  })
})

describe('a fresh provider listing in either catalog format', () => {
  async function recordProviderRow(store: AgentModelCatalogStore, tiers: Record<string, unknown>) {
    const request = vi.fn(async (method: string) =>
      method === 'model/list'
        ? {
            data: [
              {
                model: 'model-a',
                supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
                ...tiers
              }
            ],
            nextCursor: null
          }
        : { config: {} }
    )
    const listing = await fetchCodexModelCatalogListing({ connection: { request } })
    store.recordSuccess(FINGERPRINT, 'codex', { ...listing, origin: 'live-session' }, 'discovery')
  }

  it('parses the legacy additionalSpeedTiers format into advertised tiers', async () => {
    const store = new AgentModelCatalogStore({ now: () => ++clock })
    await recordProviderRow(store, { additionalSpeedTiers: ['fast'] })

    const { support } = supportFor(store)

    expect(support).toEqual({
      known: true,
      tiers: [
        { value: 'default', label: 'Standard' },
        { value: 'fast', label: 'fast' }
      ]
    })
    expect(codexServiceTierState('fast', support)).toBe('ready')
    expect(codexServiceTierState(ULTRA, support)).toBe('unavailable')
  })

  it('parses a modern empty list as known Standard-only support', async () => {
    const store = new AgentModelCatalogStore({ now: () => ++clock })
    await recordProviderRow(store, { serviceTiers: [] })

    const { support } = supportFor(store)

    expect(support).toEqual({ known: true, tiers: [{ value: 'default', label: 'Standard' }] })
  })
})
