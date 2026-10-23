import { adapterWithIndependentCatalog as adapterFor } from './codex-structured-independent-catalog.test-fixture'
import { describe, expect, it } from 'vitest'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { restoredCodexSessionOptions } from './codex-structured-session-options'
import {
  acquireReadyCodexForTest,
  USER_MESSAGE,
  answerWithOpenedTurn,
  fakeCodex,
  identityFor
} from './codex-structured-session-adapter-fixture'

const MODEL = 'synthetic-legacy-model'
const FAST_ID = 'synthetic-fast-request-id'
const identity = { sessionId: 'legacy-speed-session', fence: 7 }
const listing = {
  data: [
    {
      model: MODEL,
      supportedReasoningEfforts: [],
      serviceTiers: [{ id: FAST_ID, name: 'Fast' }]
    }
  ],
  nextCursor: null
}

function adapterWithCatalog(codex: ReturnType<typeof fakeCodex>) {
  return adapterFor(codex, { codexHome: '/synthetic/legacy-account' }, [], {
    modelCatalog: new AgentModelCatalogStore({ now: () => 1_700_000_000_000 })
  })
}

describe('saved Codex Fast migration', () => {
  it('reports unresolved Fast intent without replacing the saved preference on startup', async () => {
    const pending = Promise.withResolvers<unknown>()
    const codex = fakeCodex({ 'model/list': () => pending.promise })
    const adapter = adapterWithCatalog(codex)
    const saved = { model: MODEL, fastMode: 'true' }
    try {
      await acquireReadyCodexForTest(adapter, {
        identity: identityFor(identity.sessionId),
        fence: identity.fence,
        spawnToken: 'legacy-fast-report',
        options: saved
      })
      expect((await adapter.readOptions(identity)).current).toMatchObject({
        model: MODEL,
        fastMode: true
      })
      expect(Object.fromEntries(restoredCodexSessionOptions(saved))).toEqual(saved)
    } finally {
      pending.resolve(listing)
      await adapter.closeAll()
    }
  })

  it.each(['default', FAST_ID, 'synthetic-ultra-request-id'])(
    'keeps canonical %s ahead of a saved legacy true',
    (serviceTier) => {
      expect(
        Object.fromEntries(
          restoredCodexSessionOptions({
            model: MODEL,
            serviceTier,
            fastMode: 'true'
          })
        )
      ).toEqual({ model: MODEL, serviceTier })
    }
  )

  it('sends the advertised exact Fast ID on the next turn without a legacy wire parameter', async () => {
    const codex = fakeCodex({ 'model/list': () => listing })
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'migrated-fast-turn')
    const adapter = adapterWithCatalog(codex)
    try {
      await acquireReadyCodexForTest(adapter, {
        identity: identityFor(identity.sessionId),
        fence: identity.fence,
        spawnToken: 'legacy-fast-spawn',
        options: { model: MODEL, fastMode: 'true' }
      })
      await adapter.readOptions(identity)

      const outcome = await adapter.dispatch({
        ...identity,
        clientMessageId: 'migrated-fast-message',
        body: USER_MESSAGE
      })

      expect(outcome).toMatchObject({ state: 'admitted' })
      const starts = codex.connections[0].calls.filter((call) => call.method === 'turn/start')
      expect(starts).toHaveLength(1)
      expect(starts[0].params).toMatchObject({ model: MODEL, serviceTier: FAST_ID })
      expect(starts[0].params).not.toHaveProperty('fastMode')
      const report = await adapter.readOptions(identity)
      expect(report.current).toMatchObject({ model: MODEL, serviceTier: FAST_ID })
      const persisted = { model: MODEL, serviceTier: FAST_ID }
      expect(Object.fromEntries(restoredCodexSessionOptions(persisted))).toEqual(persisted)
    } finally {
      await adapter.closeAll()
    }
  })

  it('blocks a new turn while discovery is pending and preserves the saved Fast intent', async () => {
    const pending = Promise.withResolvers<unknown>()
    const codex = fakeCodex({ 'model/list': () => pending.promise })
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'must-not-start')
    const adapter = adapterWithCatalog(codex)
    try {
      await acquireReadyCodexForTest(adapter, {
        identity: identityFor(identity.sessionId),
        fence: identity.fence,
        spawnToken: 'pending-legacy-fast-spawn',
        options: { model: MODEL, fastMode: 'true' }
      })
      const outcome = await adapter.dispatch({
        ...identity,
        clientMessageId: 'pending-fast-message',
        body: USER_MESSAGE
      })

      expect(outcome).toMatchObject({
        state: 'rejected',
        reason: expect.stringMatching(/Standard|refresh/i),
        rejection: { neverReachedAgent: true }
      })
      expect(codex.connections[0].calls.filter((call) => call.method === 'turn/start')).toEqual([])
      const saved = (await adapter.readOptions(identity)).current
      expect(saved).toMatchObject({ model: MODEL, fastMode: true })
      expect(saved).not.toHaveProperty('serviceTier')
    } finally {
      pending.resolve(listing)
      await adapter.closeAll()
    }
  })
})
