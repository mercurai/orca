import { describe, expect, it, vi } from 'vitest'
import {
  agentModelCatalogFingerprint,
  agentModelCatalogScopeFingerprint
} from './agent-model-catalog-fingerprint'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import {
  AGENT_MODEL_CATALOG_FRESH_MS,
  AgentModelCatalogStore,
  type AgentModelCatalogSuccess
} from './agent-model-catalog-store'

const home = (path: string) => ({ variable: 'CODEX_HOME', path })
const key = (path: string) =>
  agentModelCatalogFingerprint({
    agent: 'codex',
    accountHome: home(path),
    wslDistro: null
  })
const listing = (id = 'synthetic-model'): AgentModelCatalogSuccess => ({
  origin: 'probe',
  complete: true,
  models: [{ id, label: id, efforts: [], isDefault: true }]
})

function rig() {
  let now = 1_700_000_000_000
  let selected = '/synthetic/account-a'
  const store = new AgentModelCatalogStore({ now: () => now })
  const pending = Promise.withResolvers<AgentModelCatalogSuccess>()
  const probeEntered = Promise.withResolvers<void>()
  const probe = vi.fn(() => {
    probeEntered.resolve()
    return pending.promise
  })
  const service = createAgentModelCatalogService({
    store,
    getConversation: () => undefined,
    getRecord: () => undefined,
    drivesRecord: () => true,
    resolveAccountHome: async () => home(selected),
    probes: { codex: probe }
  })
  return {
    store,
    service: {
      ...service,
      async read(params: Parameters<typeof service.read>[0]) {
        if (params.savedOnly) {
          return service.prepareSaved(params)
        }
        await service.prepareSaved(params)
        void service.demand(params)
        return service.read(params)
      }
    },
    pending,
    probe,
    probeEntered: probeEntered.promise,
    selectedKey: () => key(selected),
    advance: (ms: number) => {
      now += ms
    },
    select: (path: string) => {
      selected = path
      store.expireAgent('codex')
    }
  }
}

describe('account-scoped catalog confidence', () => {
  it('marks fresh listed choices available without starting a probe', async () => {
    const r = rig()
    r.store.recordSuccess(r.selectedKey(), 'codex', listing(), 'discovery')

    expect(
      await r.service.read({ agent: 'codex', workspacePath: null, savedOnly: true })
    ).toMatchObject({
      origin: 'probe',
      catalogState: 'available'
    })
    expect(r.probe).not.toHaveBeenCalled()
  })

  it('returns replacement tier rows when the catalog changes during workspace resolution', async () => {
    const r = rig()
    const entered = Promise.withResolvers<void>()
    const workspace = Promise.withResolvers<boolean>()
    const advertised = (value: string): AgentModelCatalogSuccess => ({
      ...listing(),
      models: [
        {
          id: 'synthetic-model',
          label: 'Synthetic',
          efforts: [],
          isDefault: false,
          serviceTiers: [{ value, label: 'Fast' }]
        }
      ]
    })
    r.store.recordSuccess(r.selectedKey(), 'codex', advertised('retired-fast-id'), 'discovery')
    const service = createAgentModelCatalogService({
      store: r.store,
      getConversation: () => undefined,
      getRecord: () => undefined,
      drivesRecord: () => true,
      resolveAccountHome: async () => home('/synthetic/account-a'),
      workspaceMayOverrideDefaultModel: () => {
        entered.resolve()
        return workspace.promise
      }
    })
    const reading = service.prepareSaved({
      agent: 'codex',
      savedOnly: true,
      workspacePath: '/synthetic/project',
      legacyOptionsDisplay: true
    })
    await entered.promise
    r.store.recordSuccess(
      agentModelCatalogScopeFingerprint(r.selectedKey(), '/synthetic/project'),
      'codex',
      advertised('current-fast-id'),
      'discovery'
    )
    workspace.resolve(false)

    expect(await reading).toMatchObject({
      catalogState: 'available',
      models: [
        { id: 'synthetic-model', serviceTiers: [{ value: 'current-fast-id', label: 'Fast' }] }
      ]
    })
  })

  it('keeps fresh choices available during a background refresh', async () => {
    const r = rig()
    r.store.recordSuccess(r.selectedKey(), 'codex', listing(), 'discovery')
    const refreshing = r.store.refresh(r.selectedKey(), 'codex', () => r.pending.promise)
    try {
      expect(r.store.isListing(r.selectedKey())).toBe(true)
      expect(
        await r.service.read({ agent: 'codex', workspacePath: null, savedOnly: true })
      ).toMatchObject({
        origin: 'probe',
        catalogState: 'available'
      })
      expect(r.probe).not.toHaveBeenCalled()
    } finally {
      r.pending.resolve(listing())
      await refreshing
    }
  })

  it.each(['aged', 'invalidated'] as const)(
    'keeps %s saved choices unknown without probing',
    async (kind) => {
      const r = rig()
      r.store.recordSuccess(r.selectedKey(), 'codex', listing(), 'discovery')
      if (kind === 'aged') {
        r.advance(AGENT_MODEL_CATALOG_FRESH_MS)
      } else {
        r.store.expireAgent('codex')
      }

      expect(
        await r.service.read({ agent: 'codex', workspacePath: null, savedOnly: true })
      ).toMatchObject({
        origin: 'probe',
        catalogState: 'unknown'
      })
      expect(r.probe).not.toHaveBeenCalled()
    }
  )

  it('marks an active generic failure unknown even with fresh saved choices', async () => {
    const r = rig()
    r.store.recordSuccess(r.selectedKey(), 'codex', listing(), 'discovery')
    await r.store.refresh(r.selectedKey(), 'codex', () =>
      Promise.reject(new Error('Synthetic account discovery failure'))
    )

    expect(
      await r.service.read({ agent: 'codex', workspacePath: null, savedOnly: true })
    ).toMatchObject({
      origin: 'probe',
      catalogState: 'unknown'
    })
    expect(r.probe).not.toHaveBeenCalled()
  })

  it('keeps an expired held unavailable reason unknown beside fresh choices', async () => {
    const r = rig()
    r.store.recordSuccess(
      r.selectedKey(),
      'codex',
      {
        ...listing(),
        unavailable: { reason: 'notSignedIn' }
      },
      'discovery'
    )
    // Live capabilities do not replace the probe's account-level unavailable reason.
    r.store.recordSuccess(
      r.selectedKey(),
      'codex',
      {
        ...listing(),
        origin: 'live-session'
      },
      'live'
    )
    r.store.expireFailure(r.selectedKey())

    expect(
      await r.service.read({ agent: 'codex', workspacePath: null, savedOnly: true })
    ).toMatchObject({
      catalogState: 'unknown',
      unavailable: { reason: 'notSignedIn' }
    })
    expect(r.probe).not.toHaveBeenCalled()
  })

  it('reports a pending first listing as loading and resolves to available', async () => {
    const r = rig()
    try {
      expect(await r.service.read({ agent: 'codex', workspacePath: null })).toMatchObject({
        origin: 'unknown',
        catalogState: 'loading',
        listingInProgress: true
      })
      await r.probeEntered
      expect(
        await r.service.read({ agent: 'codex', workspacePath: null, savedOnly: true })
      ).toMatchObject({
        origin: 'unknown',
        catalogState: 'loading'
      })
      await vi.waitFor(() => expect(r.probe).toHaveBeenCalledOnce())
    } finally {
      r.pending.resolve(listing())
    }
    expect(
      await r.service.read({ agent: 'codex', workspacePath: null, waitForListing: true })
    ).toMatchObject({
      origin: 'probe',
      catalogState: 'available'
    })
  })

  it('does not list a missing saved-only catalog', async () => {
    const r = rig()
    expect(await r.service.read({ agent: 'codex', workspacePath: null, savedOnly: true })).toEqual({
      origin: 'unknown',
      catalogState: 'unknown'
    })
    expect(r.probe).not.toHaveBeenCalled()
  })

  it('reports stale choices loading while their refresh is running', async () => {
    const r = rig()
    r.store.recordSuccess(r.selectedKey(), 'codex', listing(), 'discovery')
    r.advance(AGENT_MODEL_CATALOG_FRESH_MS)
    try {
      expect(await r.service.read({ agent: 'codex', workspacePath: null })).toMatchObject({
        origin: 'probe',
        catalogState: 'loading'
      })
      await vi.waitFor(() => expect(r.probe).toHaveBeenCalledOnce())
    } finally {
      r.pending.resolve(listing())
      await r.store.pendingListing(r.selectedKey())
    }
  })

  it('never borrows another account freshness or active listing', async () => {
    const r = rig()
    r.store.recordSuccess(r.selectedKey(), 'codex', listing('account-a-model'), 'discovery')
    r.store.expireAgent('codex')
    try {
      await r.service.read({ agent: 'codex', workspacePath: null })
      await r.probeEntered
      r.select('/synthetic/account-b')
      expect(
        await r.service.read({ agent: 'codex', workspacePath: null, savedOnly: true })
      ).toEqual({
        origin: 'unknown',
        catalogState: 'unknown'
      })
      await vi.waitFor(() => expect(r.probe).toHaveBeenCalledOnce())
    } finally {
      r.pending.resolve(listing())
      await r.store.pendingListing(key('/synthetic/account-a'))
    }
  })
})
