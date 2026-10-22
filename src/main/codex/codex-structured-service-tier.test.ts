import { fetchCodexModelCatalogListing } from './codex-structured-model-catalog'
import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  acquireReadyCodexForTest,
  codexStartReport,
  THREAD_ID,
  USER_MESSAGE,
  adapterFor as baseAdapterFor,
  answerWithOpenedTurn,
  fakeCodex,
  identityFor,
  type Route
} from './codex-structured-session-adapter-fixture'
import { AgentModelCatalogStore, AGENT_MODEL_CATALOG_FAILURE_TTL_MS } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { agentModelCatalogSessionAccess } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { createAgentModelCatalogSettingsExpiry } from '../native-chat/agent-model-catalog/agent-model-catalog-account-expiry'
import type { CodexStructuredSessionAdapter } from './codex-structured-session-adapter'
import { CODEX_STRUCTURED_AGENT } from './codex-structured-agent-definition'

const discoveryRequests = new WeakMap<ReturnType<typeof fakeCodex>, ReturnType<typeof vi.fn<Route>>>()
const discoveryWork = new WeakMap<ReturnType<typeof fakeCodex>, Promise<unknown>[]>()

function adapterFor(...args: Parameters<typeof baseAdapterFor>): CodexStructuredSessionAdapter {
  const [codex, launch = {}, events = [], deps = {}] = args
  const modelCatalog = deps.modelCatalog ?? new AgentModelCatalogStore()
  const home = launch.codexHome ?? '/codex/home'
  const access = agentModelCatalogSessionAccess(modelCatalog, CODEX_STRUCTURED_AGENT, home)!
  const request = vi.fn<Route>((params) => codex.routes['model/list']?.(params) ?? {})
  discoveryRequests.set(codex, request)
  const work: Promise<unknown>[] = []
  discoveryWork.set(codex, work)
  const probe = async () => {
    const answer = await fetchCodexModelCatalogListing({ connection: {
      request: async (method, params) => method === 'model/list' ? request(params) : {}
    } })
    return { models: answer.models, origin: 'probe' as const, complete: true }
  }
  const demand = async () => {
    if (modelCatalog.shouldRefresh(access.fingerprint)) {
      work.push(modelCatalog.refresh(access.fingerprint, 'codex', probe, probe))
    }
  }
  const adapter = baseAdapterFor(codex, { ...launch, codexHome: home }, events, {
    ...deps, modelCatalog, demandModelCatalog: demand
  })
  const open = adapter.open.bind(adapter)
  adapter.open = async (input) => {
    const answer = await open(input)
    await demand()
    return answer
  }
  return adapter
}

function listing(tier = 'priority') {
  return {
    data: [
      {
        model: 'gpt-live',
        supportedReasoningEfforts: [],
        serviceTiers: [{ id: tier, name: 'Fast' }]
      }
    ],
    nextCursor: null
  }
}

async function acquire(
  adapter: CodexStructuredSessionAdapter,
  sessionId = 'session-1',
  serviceTier = 'priority'
) {
  return acquireReadyCodexForTest(adapter, {
    identity: identityFor(sessionId),
    fence: 7,
    spawnToken: `spawn-${sessionId}`,
    options: { serviceTier }
  })
}

async function send(adapter: CodexStructuredSessionAdapter, id: string, sessionId = 'session-1') {
  return adapter.dispatch({ sessionId, clientMessageId: id, body: USER_MESSAGE, fence: 7 })
}

function finishTurn(codex: ReturnType<typeof fakeCodex>, turnId: string) {
  codex.connections.at(-1)?.handlers.onNotification?.('turn/completed', {
    threadId: THREAD_ID,
    turn: { id: turnId, status: 'completed' }
  })
}

describe('Codex structured service tier without send-path catalog waits', () => {
  it('retains the saved tier but refuses it when its own listing rejects', async () => {
    const codex = fakeCodex({
      'model/list': () => {
        throw new Error('model listing unavailable')
      }
    })
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'turn-tier')
    const adapter = adapterFor(codex)

    await acquire(adapter)
    expect(codexStartReport(adapter).reportedOptions).toMatchObject({
      serviceTier: 'priority'
    })
    expect(await send(adapter, 'first')).toMatchObject({
      state: 'rejected',
      rejection: { neverReachedAgent: true }
    })
    expect(codex.connections[0].calls.filter((call) => call.method === 'turn/start')).toEqual([])
    await adapter.setOption({
      sessionId: 'session-1',
      fence: 7,
      key: 'serviceTier',
      value: 'default'
    })
    expect(await send(adapter, 'standard')).toMatchObject({ state: 'admitted' })
    expect(
      codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params
    ).toMatchObject({ serviceTier: 'default' })
  })

  it('refuses the saved tier while its own bounded listing is still pending', async () => {
    const pending = Promise.withResolvers<unknown>()
    const codex = fakeCodex({ 'model/list': () => pending.promise })
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'first-turn')
    const adapter = adapterFor(codex, { codexHome: '/codex/home' }, [], {
      modelCatalog: new AgentModelCatalogStore()
    })
    await acquire(adapter)
    await vi.waitFor(() =>
      expect(discoveryRequests.get(codex)).toHaveBeenCalledOnce()
    )
    expect(await send(adapter, 'first')).toMatchObject({
      state: 'rejected',
      rejection: { neverReachedAgent: true }
    })
    expect(codex.connections[0].calls.filter((call) => call.method === 'turn/start')).toEqual([])
    expect((await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).current).toMatchObject(
      { serviceTier: 'priority' }
    )
    pending.resolve(listing())
  })

  it('steers an active turn while catalog discovery remains pending', async () => {
    const pending = Promise.withResolvers<unknown>()
    const codex = fakeCodex({ 'model/list': () => pending.promise })
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'running-turn')
    codex.routes['turn/steer'] = () => ({ turn: { id: 'running-turn' } })
    // Production adapters always have the host catalog store. Its initial picker
    // read exposes loading instead of joining this intentionally stalled listing.
    const adapter = adapterFor(codex, { codexHome: '/codex/home' }, [], {
      modelCatalog: new AgentModelCatalogStore()
    })
    await acquire(adapter, 'session-1', 'default')
    await send(adapter, 'first')
    await adapter.setOption({
      sessionId: 'session-1',
      fence: 7,
      key: 'serviceTier',
      value: 'priority'
    })
    expect(await send(adapter, 'follow-up')).toMatchObject({ state: 'admitted' })
    const steer = codex.connections[0].calls.find((call) => call.method === 'turn/steer')
    expect(steer).toBeDefined()
    expect(steer?.params).not.toHaveProperty('serviceTier')
    expect((await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).current).toMatchObject(
      { serviceTier: 'priority' }
    )
    expect(codex.connections[0].calls.filter((call) => call.method === 'model/list')).toHaveLength(
      0
    )
    pending.resolve(listing())
  })

  it('stops a Standard turn but refuses its paid replacement while listing stalls', async () => {
    const pending = Promise.withResolvers<unknown>()
    const codex = fakeCodex({ 'model/list': () => pending.promise })
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'running-turn')
    // Production adapters always have the host catalog store. Its initial picker
    // read exposes loading instead of joining this intentionally stalled listing.
    const adapter = adapterFor(codex, { codexHome: '/codex/home' }, [], {
      modelCatalog: new AgentModelCatalogStore()
    })
    await acquire(adapter, 'session-1', 'default')
    await send(adapter, 'first')
    await adapter.setOption({
      sessionId: 'session-1',
      fence: 7,
      key: 'serviceTier',
      value: 'priority'
    })

    await expect(adapter.cancelTurn({ sessionId: 'session-1', fence: 7 })).resolves.toMatchObject({
      cancelled: true
    })
    finishTurn(codex, 'running-turn')
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'replacement-turn')
    expect(await send(adapter, 'replacement')).toMatchObject({
      state: 'rejected',
      rejection: { neverReachedAgent: true }
    })
    const starts = codex.connections[0].calls.filter((call) => call.method === 'turn/start')
    expect(starts).toHaveLength(1)
    expect(starts[0]?.params).toMatchObject({ serviceTier: 'default' })
    expect((await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).current).toMatchObject(
      { serviceTier: 'priority' }
    )
    pending.resolve(listing())
  })

  it('refuses paid speed during a background failure and retries after the failure TTL', async () => {
    let now = 1_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const modelCatalog = new AgentModelCatalogStore({ now: () => now })
    const listModels: Mock<Route> = vi
      .fn<Route>()
      .mockImplementationOnce(() => {
        throw new Error('catalog unavailable')
      })
      .mockImplementation(() => listing())
    const codex = fakeCodex({ 'model/list': listModels })
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'turn-tier')
    const adapter = adapterFor(codex, { codexHome: '/codex/home' }, [], { modelCatalog })
    const access = agentModelCatalogSessionAccess(
      modelCatalog,
      CODEX_STRUCTURED_AGENT,
      '/codex/home'
    )!
    try {
      await acquire(adapter)
      await vi.waitFor(() => expect(modelCatalog.hasActiveFailure(access.fingerprint)).toBe(true))
      expect(await send(adapter, 'first')).toMatchObject({
        state: 'rejected',
        rejection: { neverReachedAgent: true }
      })
      expect(codex.connections[0].calls.some((call) => call.method === 'turn/start')).toBe(false)
      await acquire(adapter, 'session-2')
      expect(listModels).toHaveBeenCalledOnce()
      now += AGENT_MODEL_CATALOG_FAILURE_TTL_MS
      await acquire(adapter, 'session-3')
      await vi.waitFor(() => expect(listModels).toHaveBeenCalledTimes(2))
      await vi.waitFor(() => expect(modelCatalog.hasActiveFailure(access.fingerprint)).toBe(false))
      expect(await send(adapter, 'after-refresh', 'session-3')).toMatchObject({ state: 'admitted' })
      expect(
        codex.connections.at(-1)?.calls.find((call) => call.method === 'turn/start')?.params
      ).toMatchObject({ serviceTier: 'priority' })
    } finally {
      clock.mockRestore()
    }
  })

  it('does not record an invalidated discovery over its replacement’s', async () => {
    const oldListing = Promise.withResolvers<unknown>()
    const newListing = Promise.withResolvers<unknown>()
    const codex = fakeCodex({
      'model/list': vi
        .fn<Route>()
        .mockImplementationOnce(() => oldListing.promise)
        .mockImplementationOnce(() => newListing.promise)
    })
    const modelCatalog = new AgentModelCatalogStore()
    const adapter = adapterFor(codex, { codexHome: '/codex/home' }, [], { modelCatalog })
    const access = agentModelCatalogSessionAccess(
      modelCatalog,
      CODEX_STRUCTURED_AGENT,
      '/codex/home'
    )!
    await acquire(adapter)
    modelCatalog.expireAgent('codex')
    await acquire(adapter)
    oldListing.resolve(listing('priority-old'))
    newListing.resolve(listing('priority-new'))
    await vi.waitFor(() =>
      expect(modelCatalog.get(access.fingerprint)?.models[0]?.serviceTiers?.[0]?.value).toBe(
        'priority-new'
      )
    )
  })

  it.each(['resolve', 'reject'] as const)(
    'ignores a cold-cache background listing that %ss after same-home account reauthentication',
    async (outcome) => {
      const pending = Promise.withResolvers<unknown>()
      const codex = fakeCodex({ 'model/list': () => pending.promise })
      const modelCatalog = new AgentModelCatalogStore()
      const adapter = adapterFor(codex, { codexHome: '/codex/home' }, [], { modelCatalog })
      await acquire(adapter)
      const session = adapter['sessions'].get('session-1')
      if (!session?.catalogAccess) {
        throw new Error('Expected the acquired session and pinned catalog access')
      }
      const { fingerprint } = session.catalogAccess
      await vi.waitFor(() =>
        expect(discoveryRequests.get(codex)).toHaveBeenCalledOnce()
      )
      expect(modelCatalog.isListing(fingerprint)).toBe(true)
      expect(modelCatalog.get(fingerprint)).toBeNull()
      const expire = createAgentModelCatalogSettingsExpiry(modelCatalog, {})
      expire(
        {
          codexManagedAccounts: [
            {
              id: 'same-account',
              email: 'reauthenticated@example.test',
              managedHomePath: '/codex/home',
              providerAccountId: 'new-principal',
              workspaceLabel: null,
              workspaceAccountId: null,
              createdAt: 1,
              updatedAt: 2,
              lastAuthenticatedAt: 2
            }
          ]
        },
        {}
      )
      if (outcome === 'resolve') {
        pending.resolve(listing('old-account-paid-id'))
      } else {
        pending.reject(new Error('old account listing rejected'))
      }
      await Promise.allSettled(discoveryWork.get(codex) ?? [])
      expect(modelCatalog.get(fingerprint)).toBeNull()
      expect(modelCatalog.hasActiveFailure(fingerprint)).toBe(false)
      expect(modelCatalog.failure(fingerprint)).toBeNull()
      expect(modelCatalog.isListing(fingerprint)).toBe(false)
      expect(
        (await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).current
      ).toMatchObject({ serviceTier: 'priority' })
      expect(codex.connections).toHaveLength(1)
    }
  )

  it('restores the saved model and tier over the resumed thread’s', async () => {
    const codex = fakeCodex({
      'model/list': () => ({
        data: [
          {
            model: 'synthetic-resume-model',
            supportedReasoningEfforts: [],
            serviceTiers: [{ id: 'synthetic-ultra-request-id', name: 'Ultrafast' }]
          }
        ],
        nextCursor: null
      })
    })
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'turn-tier')
    const modelCatalog = new AgentModelCatalogStore()
    const access = agentModelCatalogSessionAccess(
      modelCatalog,
      CODEX_STRUCTURED_AGENT,
      '/codex/home'
    )!
    const adapter = adapterFor(
      codex,
      {
        codexHome: '/codex/home',
        resumeThreadId: THREAD_ID
      },
      [],
      { modelCatalog }
    )
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-resume',
      options: { model: 'synthetic-resume-model', serviceTier: 'synthetic-ultra-request-id' }
    })

    expect(codex.connections[0].calls.some((call) => call.method === 'thread/resume')).toBe(true)
    expect(codexStartReport(adapter).reportedOptions).toEqual({
      model: 'synthetic-resume-model',
      serviceTier: 'synthetic-ultra-request-id'
    })
    await vi.waitFor(() =>
      expect(modelCatalog.get(access.fingerprint)?.models[0]?.id).toBe('synthetic-resume-model')
    )
    expect(await send(adapter, 'first')).toMatchObject({ state: 'admitted' })
    expect(
      codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params
    ).toMatchObject({ model: 'synthetic-resume-model', serviceTier: 'synthetic-ultra-request-id' })
  })
})

describe('Codex service tier across clients and rest', () => {
  it('applies an older client Fast toggle through the adapter as the Fast tier', async () => {
    const codex = fakeCodex({ 'model/list': () => listing() })
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'turn-fast')
    const modelCatalog = new AgentModelCatalogStore()
    const access = agentModelCatalogSessionAccess(
      modelCatalog,
      CODEX_STRUCTURED_AGENT,
      '/codex/home'
    )!
    modelCatalog.recordSuccess(
      access.fingerprint,
      'codex',
      {
        models: [
          {
            id: 'gpt-live',
            label: 'GPT Live',
            isDefault: true,
            efforts: [],
            serviceTiers: [{ value: 'priority', label: 'Fast' }]
          }
        ],
        origin: 'probe',
        complete: true
      },
      'discovery'
    )
    const adapter = adapterFor(codex, { codexHome: '/codex/home' }, [], { modelCatalog })
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-1'
    })

    await expect(
      adapter.setOption({ sessionId: 'session-1', key: 'fastMode', value: 'true', fence: 7 })
    ).resolves.toEqual({ serviceTier: 'priority' })
    await expect(
      adapter.setOption({ sessionId: 'session-1', key: 'approvalPolicy', value: 'never', fence: 7 })
    ).rejects.toThrow('no thread option named approvalPolicy')
    await send(adapter, 'first')
    const turn = codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params
    expect(turn).toMatchObject({ serviceTier: 'priority' })
    expect(turn).not.toHaveProperty('fastMode')
  })

  it('takes a tier and an older client Fast toggle at rest', () => {
    expect(CODEX_STRUCTURED_AGENT.restingOptions?.acceptsKey('serviceTier')).toBe(true)
    expect(CODEX_STRUCTURED_AGENT.restingOptions?.acceptsKey('fastMode')).toBe(true)
  })
})
