import { describe, expect, it } from 'vitest'
import { expireAgentModelCatalogsForSettings } from './agent-model-catalog-account-expiry'
import { AgentModelCatalogStore, type AgentModelCatalogSuccess } from './agent-model-catalog-store'

const complete = (id: string): AgentModelCatalogSuccess => ({
  origin: 'probe',
  complete: true,
  models: [{ id, label: id, isDefault: true, efforts: [] }]
})

describe('catalog admission evidence lifetime', () => {
  it('ages discovery independently of newer live capability evidence', () => {
    let now = 1_000
    const store = new AgentModelCatalogStore({ now: () => now })
    store.recordSuccess('scope', 'grok', complete('model'), 'discovery')
    now += 10 * 60_000
    store.recordSuccess('scope', 'grok', { ...complete('model'), origin: 'live-session' }, 'live')
    const entry = store.get('scope')!
    expect(store.isStale(entry)).toBe(true)
    expect(store.isStale(entry, 'latest')).toBe(false)
    now += 10 * 60_000
    expect(store.isStale(entry, 'latest')).toBe(true)
  })

  it('retires both freshness sources when the selected account changes at the same path', () => {
    const store = new AgentModelCatalogStore({ now: () => 1_000 })
    store.recordSuccess('scope', 'codex', complete('model'), 'discovery')
    const entry = store.get('scope')!
    expect(store.verified(entry)).toBe(true)
    expireAgentModelCatalogsForSettings(store, { activeCodexManagedAccountId: 'replacement' })
    expect(store.isStale(entry)).toBe(true)
    expect(store.isStale(entry, 'latest')).toBe(true)
    expect(store.observation('scope')).toBeNull()
  })

  it.each(['success', 'failure'] as const)(
    'a pre-change probe %s cannot certify or poison the replacement account',
    async (outcome) => {
      const store = new AgentModelCatalogStore({ now: () => 1_000 })
      const old = Promise.withResolvers<AgentModelCatalogSuccess>()
      const refreshing = store.refresh('scope', 'codex', () => old.promise)
      await Promise.resolve()
      expireAgentModelCatalogsForSettings(store, { activeCodexManagedAccountId: 'replacement' })
      expect(await refreshing).toBeNull()
      store.recordSuccess('scope', 'codex', complete('current'), 'discovery')
      if (outcome === 'success') {
        old.resolve(complete('retired'))
      } else {
        old.reject(new Error('retired account failure'))
      }
      await old.promise.catch(() => {})
      expect(store.observation('scope')?.models[0]?.id).toBe('current')
      expect(store.hasActiveFailure('scope')).toBe(false)
      expect(store.verified(store.get('scope')!)).toBe(true)
    }
  )
})
