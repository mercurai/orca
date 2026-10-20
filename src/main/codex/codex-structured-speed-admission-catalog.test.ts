import { describe, expect, it } from 'vitest'
import {
  AGENT_MODEL_CATALOG_FRESH_MS,
  AgentModelCatalogStore
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { agentModelCatalogFingerprint } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import {
  acquireReadyCodexForTest,
  THREAD_ID,
  USER_MESSAGE,
  adapterFor,
  answerWithOpenedTurn,
  fakeCodex,
  identityFor
} from './codex-structured-session-adapter-fixture'

const MODEL = 'synthetic-catalog-model'
const TIER = 'synthetic-priority-exact-request-id'
const ACCOUNT = '/synthetic/catalog-account'
const IDENTITY = { sessionId: 'session-1', fence: 7 }

function fingerprint(accountHomePath: string): string {
  return agentModelCatalogFingerprint({
    agent: 'codex',
    accountHomeVariable: 'CODEX_HOME',
    accountHomePath,
    wslDistro: null
  })
}

function recordListing(store: AgentModelCatalogStore, accountHomePath = ACCOUNT): void {
  store.recordSuccess(
    fingerprint(accountHomePath),
    'codex',
    {
      models: [
        {
          id: MODEL,
          label: 'Synthetic model',
          isDefault: false,
          efforts: [],
          serviceTiers: [{ value: TIER, label: 'Synthetic speed' }]
        }
      ],
      origin: 'live-session'
    },
    'live'
  )
}

async function setup(store: AgentModelCatalogStore, serviceTier = TIER, account = ACCOUNT) {
  const pending = Promise.withResolvers<unknown>()
  const codex = fakeCodex({ 'model/list': () => pending.promise })
  codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'catalog-turn')
  const adapter = adapterFor(codex, { codexHome: account }, [], { modelCatalog: store })
  await acquireReadyCodexForTest(adapter, {
    ...IDENTITY,
    identity: identityFor(IDENTITY.sessionId),
    spawnToken: 'catalog-admission-spawn',
    options: { model: MODEL, serviceTier }
  })
  return {
    adapter,
    codex,
    send: (clientMessageId: string) =>
      adapter.dispatch({ ...IDENTITY, clientMessageId, body: USER_MESSAGE }),
    starts: () => codex.connections[0].calls.filter((call) => call.method === 'turn/start'),
    cleanup: async () => {
      await adapter.closeSession(IDENTITY.sessionId)
      pending.resolve({ data: [], nextCursor: null })
    }
  }
}

describe('Codex speed admission uses the execution account catalog', () => {
  it('accepts an exact advertised request ID from a fresh session-only listing', async () => {
    const store = new AgentModelCatalogStore({ now: () => 1_000 })
    const fixture = await setup(store)
    try {
      recordListing(store)
      expect(store.get(fingerprint(ACCOUNT))?.discovered).toBeNull()
      expect(await fixture.send('fresh-session-tier')).toMatchObject({ state: 'admitted' })
      expect(fixture.starts()).toHaveLength(1)
      expect(fixture.starts()[0]?.params).toMatchObject({ model: MODEL, serviceTier: TIER })
    } finally {
      await fixture.cleanup()
    }
  })

  it('retains a stale selection and sends its exact ID only after applicable refresh', async () => {
    let now = 1_000
    const store = new AgentModelCatalogStore({ now: () => now })
    const fixture = await setup(store)
    try {
      recordListing(store)
      now += AGENT_MODEL_CATALOG_FRESH_MS
      expect(await fixture.send('stale-tier')).toMatchObject({
        state: 'rejected',
        rejection: { neverReachedAgent: true }
      })
      expect(fixture.starts()).toEqual([])
      expect((await fixture.adapter.readOptions(IDENTITY)).current).toMatchObject({ serviceTier: TIER })
      recordListing(store)
      expect(await fixture.send('refreshed-tier')).toMatchObject({ state: 'admitted' })
      expect(fixture.starts()).toHaveLength(1)
      expect(fixture.starts()[0]?.params).toMatchObject({ serviceTier: TIER })
    } finally {
      await fixture.cleanup()
    }
  })

  it('does not borrow another account listing to authorize the same model and tier', async () => {
    const store = new AgentModelCatalogStore({ now: () => 1_000 })
    recordListing(store, '/synthetic/account-a')
    const fixture = await setup(store, TIER, '/synthetic/account-b')
    try {
      expect(await fixture.send('wrong-account-tier')).toMatchObject({
        state: 'rejected',
        rejection: { neverReachedAgent: true }
      })
      expect(fixture.starts()).toEqual([])
      expect((await fixture.adapter.readOptions(IDENTITY)).current).toMatchObject({ serviceTier: TIER })
    } finally {
      await fixture.cleanup()
    }
  })

  it('steers a running Standard turn while the requested next speed remains unverified', async () => {
    const fixture = await setup(new AgentModelCatalogStore({ now: () => 1_000 }), 'default')
    fixture.codex.routes['turn/steer'] = () => ({ turn: { id: 'catalog-turn' } })
    try {
      expect(await fixture.send('standard-start')).toMatchObject({ state: 'admitted' })
      await fixture.adapter.setOption({ ...IDENTITY, key: 'serviceTier', value: TIER })
      expect(await fixture.send('running-follow-up')).toMatchObject({ state: 'admitted' })
      const steers = fixture.codex.connections[0].calls.filter(
        (call) => call.method === 'turn/steer'
      )
      expect(steers).toHaveLength(1)
      expect(steers[0]?.params).not.toHaveProperty('serviceTier')
      fixture.codex.connections[0].handlers.onNotification?.('turn/completed', {
        threadId: THREAD_ID,
        turn: { id: 'catalog-turn', status: 'completed' }
      })
      expect(await fixture.send('unverified-new-turn')).toMatchObject({
        state: 'rejected',
        rejection: { neverReachedAgent: true }
      })
      expect(fixture.starts()).toHaveLength(1)
      expect(fixture.starts()[0]?.params).toMatchObject({ serviceTier: 'default' })
      expect((await fixture.adapter.readOptions(IDENTITY)).current).toMatchObject({ serviceTier: TIER })
    } finally {
      await fixture.cleanup()
    }
  })
})
