import {
  adapterWithIndependentCatalog as adapterFor,
  discoveryRequests
} from './codex-structured-independent-catalog.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import {
  acquireReadyCodexForTest,
  USER_MESSAGE,
  answerWithOpenedTurn,
  fakeCodex,
  identityFor
} from './codex-structured-session-adapter-fixture'

describe('Codex next-turn speed admission', () => {
  it.each(['pending', 'failed'] as const)(
    'retains an explicit tier and refuses a new turn when catalog discovery is %s',
    async (discovery) => {
      const pending = Promise.withResolvers<unknown>()
      const codex = fakeCodex({
        'model/list': () => {
          if (discovery === 'failed') {
            throw new Error('Synthetic catalog failure')
          }
          return pending.promise
        }
      })
      codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'standard-turn')
      const adapter = adapterFor(codex, { codexHome: '/synthetic/account' }, [], {
        modelCatalog: new AgentModelCatalogStore()
      })
      const identity = { sessionId: 'session-1', fence: 7 }
      try {
        await acquireReadyCodexForTest(adapter, {
          fence: identity.fence,
          identity: identityFor(identity.sessionId),
          spawnToken: 'speed-admission-spawn',
          options: { model: 'synthetic-model', serviceTier: 'priority-exact-id' }
        })
        await vi.waitFor(() => expect(discoveryRequests.get(codex)).toHaveBeenCalledOnce())
        const outcome = await adapter.dispatch({
          ...identity,
          clientMessageId: 'unverified-speed',
          body: USER_MESSAGE
        })
        expect(outcome).toMatchObject({
          state: 'rejected',
          reason: expect.stringMatching(/Standard|refresh/i),
          rejection: { neverReachedAgent: true }
        })
        expect(codex.connections[0].calls.filter((call) => call.method === 'turn/start')).toEqual(
          []
        )
        expect((await adapter.readOptions(identity)).current).toMatchObject({
          serviceTier: 'priority-exact-id'
        })

        await adapter.setOption({ ...identity, key: 'serviceTier', value: 'default' })
        await adapter.dispatch({
          ...identity,
          clientMessageId: 'standard-speed',
          body: USER_MESSAGE
        })
        expect(
          codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params
        ).toMatchObject({ serviceTier: 'default' })
      } finally {
        pending.resolve({ data: [], nextCursor: null })
      }
    }
  )
})
