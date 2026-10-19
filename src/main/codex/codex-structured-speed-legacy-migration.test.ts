import { describe, expect, it } from 'vitest'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { nativeSessionOptionsFromReport } from '../native-chat/agent-session-wire/structured-agent-session-option-restoration'
import { restoredCodexSessionOptions } from './codex-structured-session-options'
import {
  USER_MESSAGE,
  adapterFor,
  answerWithOpenedTurn,
  fakeCodex,
  identityFor
} from './codex-structured-session-adapter-fixture'

const MODEL = 'synthetic-legacy-model'
const FAST_ID = 'synthetic-fast-request-id'
const identity = { sessionId: 'legacy-speed-session', fence: 7 }
const listing = {
  data: [{
    model: MODEL,
    supportedReasoningEfforts: [],
    serviceTiers: [{ id: FAST_ID, name: 'Fast' }]
  }],
  nextCursor: null
}

function adapterWithCatalog(codex: ReturnType<typeof fakeCodex>) {
  return adapterFor(codex, { codexHome: '/synthetic/legacy-account' }, [], {
    modelCatalog: new AgentModelCatalogStore({ now: () => 1_700_000_000_000 })
  })
}

describe('saved Codex Fast migration', () => {
  it('retains unresolved true through generic native persistence and another restore', () => {
    const restored = restoredCodexSessionOptions({ model: MODEL, fastMode: 'true' })
    expect(Object.fromEntries(restored)).toEqual({ model: MODEL, fastMode: 'true' })

    const persisted = nativeSessionOptionsFromReport({
      priorOptions: Object.fromEntries(restored),
      reported: { model: MODEL, fastMode: true },
      restoreSkipped: []
    })

    expect(persisted).toEqual({ model: MODEL, fastMode: 'true' })
    expect(Object.fromEntries(restoredCodexSessionOptions(persisted))).toEqual(persisted)
  })

  it.each(['default', FAST_ID, 'synthetic-ultra-request-id'])(
    'keeps canonical %s ahead of a saved legacy true',
    (serviceTier) => {
      expect(Object.fromEntries(restoredCodexSessionOptions({
        model: MODEL, serviceTier, fastMode: 'true'
      }))).toEqual({ model: MODEL, serviceTier })
    }
  )

  it('sends the advertised exact Fast ID on the next turn without a legacy wire parameter', async () => {
    const codex = fakeCodex({ 'model/list': () => listing })
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'migrated-fast-turn')
    const adapter = adapterWithCatalog(codex)
    try {
      await adapter.acquire({
        identity: identityFor(identity.sessionId),
        fence: identity.fence,
        spawnToken: 'legacy-fast-spawn',
        options: { model: MODEL, fastMode: 'true' }
      })
      await adapter.readOptions(identity)

      const outcome = await adapter.dispatch({
        ...identity, clientMessageId: 'migrated-fast-message', body: USER_MESSAGE
      })

      expect(outcome).toMatchObject({ state: 'admitted' })
      const starts = codex.connections[0].calls.filter((call) => call.method === 'turn/start')
      expect(starts).toHaveLength(1)
      expect(starts[0].params).toMatchObject({ model: MODEL, serviceTier: FAST_ID })
      expect(starts[0].params).not.toHaveProperty('fastMode')
      const report = await adapter.readOptions(identity)
      const persisted = nativeSessionOptionsFromReport({
        reported: report.current,
        priorOptions: { model: MODEL, fastMode: 'true' },
        restoreSkipped: []
      })
      expect(persisted).toMatchObject({ model: MODEL, serviceTier: FAST_ID })
      expect(persisted).not.toHaveProperty('fastMode')
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
      await adapter.acquire({
        identity: identityFor(identity.sessionId),
        fence: identity.fence,
        spawnToken: 'pending-legacy-fast-spawn',
        options: { model: MODEL, fastMode: 'true' }
      })
      const outcome = await adapter.dispatch({
        ...identity, clientMessageId: 'pending-fast-message', body: USER_MESSAGE
      })

      expect(outcome).toMatchObject({
        state: 'rejected',
        reason: expect.stringMatching(/Standard|refresh/i),
        rejection: { neverReachedAgent: true }
      })
      expect(codex.connections[0].calls.filter((call) => call.method === 'turn/start')).toEqual([])
      const saved = adapter.readAcquisitionOptions(identity)
      expect(saved).toMatchObject({ model: MODEL, fastMode: 'true' })
      expect(saved).not.toHaveProperty('serviceTier')
    } finally {
      pending.resolve(listing)
      await adapter.closeAll()
    }
  })
})
