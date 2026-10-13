import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionModelOption } from '../../shared/agent-session-wire'
import { fetchCodexModelCatalogListing } from './codex-structured-model-catalog'
import { restoredCodexSessionOptions } from './codex-structured-session-options'

// Synthetic ids throughout: the provider catalog, not Orca, decides which request tiers exist.
const STANDARD = { id: 'default', name: 'Standard', description: 'Regular speed and usage' }
const FAST = { id: 'tier-fast-7f3', name: 'Fast', description: 'Faster responses, more usage' }
const ULTRAFAST = { id: 'tier-ultra-9c1', name: 'Ultrafast', description: 'Fastest, highest usage' }

function choice(tier: { id: string; name: string; description: string }): {
  value: string
  label: string
  description: string
} {
  return { value: tier.id, label: tier.name, description: tier.description }
}

function modelRow(id: string, tierMetadata: Record<string, unknown>): Record<string, unknown> {
  return {
    model: id,
    displayName: id.toUpperCase(),
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
    defaultReasoningEffort: 'high',
    isDefault: false,
    ...tierMetadata
  }
}

async function listModels(...rows: Record<string, unknown>[]) {
  const request = vi.fn(async (method: string) =>
    method === 'model/list' ? { data: rows, nextCursor: null } : { config: {} }
  )
  return fetchCodexModelCatalogListing({ connection: { request } })
}

async function listedModel(row: Record<string, unknown>) {
  const listing = await listModels(row)
  const model = listing.models[0]
  if (!model) {
    throw new Error('listing returned no model')
  }
  return { model, listing }
}

// Narrow additive metadata from unknown so a red run reports absent behavior, not a missing type.
function tierValues(model: AgentSessionModelOption): unknown[] | null {
  if (!('serviceTiers' in model)) {
    return null
  }
  const tiers: unknown = model.serviceTiers
  if (!Array.isArray(tiers)) {
    return null
  }
  return tiers.map((tier: unknown) =>
    typeof tier === 'object' && tier !== null && 'value' in tier ? tier.value : undefined
  )
}

describe('Codex catalog service tiers', () => {
  it('keeps modern serviceTiers as choices with exact provider ids, Standard included', async () => {
    const { model } = await listedModel(
      modelRow('synthetic-model-a', { serviceTiers: [STANDARD, FAST] })
    )
    expect(model).toMatchObject({ serviceTiers: [choice(STANDARD), choice(FAST)] })
  })

  it('preserves both Fast and Ultrafast custom ids in provider order', async () => {
    const { model, listing } = await listedModel(
      modelRow('synthetic-model-a', { serviceTiers: [STANDARD, FAST, ULTRAFAST] })
    )
    expect(model).toMatchObject({
      serviceTiers: [choice(STANDARD), choice(FAST), choice(ULTRAFAST)]
    })
    // Compatibility projections come from the same rows.
    expect(model.supportsFastMode).toBe(true)
    expect(listing.fastModeTierByModel.get('synthetic-model-a')).toBe(FAST.id)
  })

  it('keeps a provider-advertised Standard id that is not the protocol default', async () => {
    const standard = { ...STANDARD, id: 'tier-standard-2b4' }
    const { model } = await listedModel(
      modelRow('synthetic-model-a', { serviceTiers: [standard, FAST] })
    )
    expect(tierValues(model)).toEqual(['tier-standard-2b4', FAST.id])
  })

  it('reads snake_case service_tiers metadata the same way', async () => {
    const { model } = await listedModel(
      modelRow('synthetic-model-a', { service_tiers: [STANDARD, FAST, ULTRAFAST] })
    )
    expect(tierValues(model)).toEqual([STANDARD.id, FAST.id, ULTRAFAST.id])
  })

  it.each([
    ['serviceTiers', 'additionalSpeedTiers'],
    ['service_tiers', 'additional_speed_tiers']
  ])('lets an empty modern %s override legacy %s', async (modern, legacy) => {
    const { model, listing } = await listedModel(
      modelRow('synthetic-model-a', { [modern]: [], [legacy]: ['fast', 'ultrafast'] })
    )
    expect(tierValues(model)).toEqual(['default'])
    expect(model.supportsFastMode).toBe(false)
    expect(listing.fastModeTierByModel.has('synthetic-model-a')).toBe(false)
  })

  it.each(['additionalSpeedTiers', 'additional_speed_tiers'])(
    'retains legacy %s strings as exact request values beside Standard',
    async (legacy) => {
      const { model } = await listedModel(
        modelRow('synthetic-model-a', { [legacy]: ['fast', 'ultrafast', 'turbo-x9'] })
      )
      expect(tierValues(model)).toEqual(
        expect.arrayContaining(['default', 'fast', 'ultrafast', 'turbo-x9'])
      )
    }
  )

  it('answers each model from its own metadata in one listing', async () => {
    const listing = await listModels(
      modelRow('synthetic-model-a', { serviceTiers: [STANDARD, FAST, ULTRAFAST] }),
      modelRow('synthetic-model-b', { serviceTiers: [] })
    )
    const [first, second] = listing.models
    expect(tierValues(first!)).toEqual([STANDARD.id, FAST.id, ULTRAFAST.id])
    expect(tierValues(second!)).toEqual(['default'])
  })

  it.each([
    ['no metadata', {}],
    ['non-array modern metadata', { serviceTiers: 'fast', service_tiers: { id: 'fast' } }],
    ['non-array legacy metadata', { additionalSpeedTiers: 'fast', additional_speed_tiers: 7 }]
  ])('leaves serviceTiers absent for %s', async (_name, metadata) => {
    const { model } = await listedModel(modelRow('synthetic-model-a', metadata))
    expect('serviceTiers' in model).toBe(false)
  })

  it('never invents an Ultrafast choice from a model name or a Fast-only list', async () => {
    const modern = await listedModel(
      modelRow('synthetic-ultra-model', { serviceTiers: [STANDARD, FAST] })
    )
    expect(tierValues(modern.model)).toEqual([STANDARD.id, FAST.id])
    const legacy = await listedModel(
      modelRow('synthetic-ultra-model', { additionalSpeedTiers: ['fast'] })
    )
    expect(tierValues(legacy.model)).not.toContain('ultrafast')
    const unknown = await listedModel(modelRow('synthetic-ultra-model', {}))
    expect('serviceTiers' in unknown.model).toBe(false)
  })
})

describe('restoredCodexSessionOptions with service tiers', () => {
  it('preserves an explicit serviceTier and removes the stale coexisting fastMode', () => {
    expect(
      Object.fromEntries(
        restoredCodexSessionOptions({
          model: 'synthetic-model-a',
          serviceTier: ULTRAFAST.id,
          fastMode: 'true'
        })
      )
    ).toEqual({ model: 'synthetic-model-a', serviceTier: ULTRAFAST.id })
    expect(
      Object.fromEntries(restoredCodexSessionOptions({ serviceTier: FAST.id, fastMode: 'false' }))
    ).toEqual({ serviceTier: FAST.id })
  })

  it('preserves an explicit protocol-default serviceTier', () => {
    expect(Object.fromEntries(restoredCodexSessionOptions({ serviceTier: 'default' }))).toEqual({
      serviceTier: 'default'
    })
  })

  it('restores fastMode=false without metadata as canonical serviceTier=default', () => {
    expect(
      Object.fromEntries(
        restoredCodexSessionOptions({ model: 'synthetic-model-a', fastMode: 'false' })
      )
    ).toEqual({ model: 'synthetic-model-a', serviceTier: 'default' })
  })

  it('keeps unresolved legacy fastMode=true as intent without inventing default', () => {
    const restored = Object.fromEntries(
      restoredCodexSessionOptions({ model: 'synthetic-model-a', fastMode: 'true' })
    )
    expect(restored).toEqual({ model: 'synthetic-model-a', fastMode: 'true' })
    expect(restored).not.toHaveProperty('serviceTier')
  })
})
