import { describe, expect, it, vi } from 'vitest'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { CodexAppServerRequestError } from './codex-app-server-connection'
import { startCodexTurn } from './codex-structured-turn-start'
import {
  acquireReadyCodexForTest,
  THREAD_ID,
  USER_MESSAGE,
  adapterFor,
  fakeCodex,
  identityFor,
  type Route
} from './codex-structured-session-adapter-fixture'

const MODEL = 'synthetic-speed-state-model'
const FIRST = 'synthetic-first-exact-tier'
const SECOND = 'synthetic-second-exact-tier'
const IDENTITY = { sessionId: 'session-1', fence: 7 }

async function setup(
  options: Record<string, string> = { serviceTier: FIRST },
  reported = false,
  listModels?: Route,
  primeCatalog = true
) {
  const codex = fakeCodex({
    'model/list':
      listModels ??
      (() => ({
        data: [
          {
            model: MODEL,
            supportedReasoningEfforts: [],
            serviceTiers: [
              { id: FIRST, name: 'Synthetic first' },
              { id: SECOND, name: 'Synthetic second' }
            ]
          }
        ],
        nextCursor: null
      })),
    'thread/start': () => ({
      thread: { id: THREAD_ID },
      model: MODEL,
      ...(reported ? { serviceTier: FIRST } : {})
    })
  })
  const modelCatalog = new AgentModelCatalogStore({ now: () => 1_000 })
  const adapter = adapterFor(codex, { codexHome: '/synthetic/speed-state' }, [], {
    modelCatalog
  })
  const acquire = () =>
    acquireReadyCodexForTest(adapter, {
      ...IDENTITY,
      identity: identityFor(IDENTITY.sessionId),
      spawnToken: 'speed-state-spawn',
      options: { model: MODEL, ...options }
    })
  await acquire()
  if (primeCatalog) {
    await vi.waitFor(() => expect(modelCatalog.hasEntryForAgent('codex')).toBe(true))
    await adapter.readOptions(IDENTITY)
  }
  return {
    adapter,
    codex,
    acquire,
    read: () => adapter.readOptions(IDENTITY),
    send: (clientMessageId: string) =>
      adapter.dispatch({ ...IDENTITY, clientMessageId, body: USER_MESSAGE }),
    close: () => adapter.closeSession(IDENTITY.sessionId)
  }
}

function pendingStart(codex: ReturnType<typeof fakeCodex>) {
  const reply = Promise.withResolvers<unknown>()
  codex.routes['turn/start'] = () => reply.promise
  return reply
}

async function waitForStarts(codex: ReturnType<typeof fakeCodex>, count = 1) {
  await vi.waitFor(() =>
    expect(codex.connections[0].calls.filter((call) => call.method === 'turn/start')).toHaveLength(
      count
    )
  )
}

describe('Codex requested speed and acknowledged host settings', () => {
  it('reports loading before an initial deferred catalog finishes', async () => {
    const gate = Promise.withResolvers<unknown>()
    const fixture = await setup({ serviceTier: FIRST }, false, () => gate.promise, false)
    let observed: unknown
    const reading = fixture.read().then(
      (result) => {
        observed = result
      },
      (error: unknown) => {
        observed = error
      }
    )
    try {
      await vi.waitFor(() =>
        expect(observed).toMatchObject({
          speed: {
            requested: { tierId: FIRST },
            support: 'loading',
            processing: { status: 'unknown' }
          }
        })
      )
    } finally {
      gate.resolve({ data: [], nextCursor: null })
      await reading
      await fixture.close()
    }
  })

  it('reports unknown after initial catalog failure instead of throwing from options', async () => {
    const fixture = await setup(
      { serviceTier: FIRST },
      false,
      () => {
        throw new Error('Synthetic initial catalog rejection')
      },
      false
    )
    try {
      const access = fixture.adapter['sessions'].get(IDENTITY.sessionId)?.catalogAccess
      if (!access) {
        throw new Error('Expected synthetic session catalog access')
      }
      await vi.waitFor(() => expect(access.store.hasActiveFailure(access.fingerprint)).toBe(true))
      await expect(fixture.read()).resolves.toMatchObject({
        speed: {
          requested: { tierId: FIRST },
          support: 'unknown',
          processing: { status: 'unknown' }
        }
      })
    } finally {
      await fixture.close()
    }
  })

  it.each([false, true])(
    'clears earlier applied settings for a newer omitted-tier success (reverse acknowledgements: %s)',
    async (reverse) => {
      const fixture = await setup()
      const first = Promise.withResolvers<unknown>()
      const second = Promise.withResolvers<unknown>()
      let started = 0
      fixture.codex.routes['turn/start'] = () => (++started === 1 ? first.promise : second.promise)
      const session = fixture.adapter['sessions'].get(IDENTITY.sessionId)
      if (!session) {
        throw new Error('Expected acquired synthetic Codex session')
      }
      try {
        const older = startCodexTurn(session, {
          clientMessageId: 'explicit-older',
          body: USER_MESSAGE
        })
        await waitForStarts(fixture.codex)
        if (!reverse) {
          first.resolve({ turn: { id: 'explicit-older-turn' } })
          await older
          expect(await fixture.read()).toMatchObject({
            speed: {
              applied: { tierId: FIRST, turnId: 'explicit-older-turn' }
            }
          })
        }
        session.options.delete('serviceTier')
        const newer = startCodexTurn(session, {
          clientMessageId: 'omitted-newer',
          body: USER_MESSAGE
        })
        await waitForStarts(fixture.codex, 2)
        const starts = fixture.codex.connections[0].calls.filter(
          (call) => call.method === 'turn/start'
        )
        expect(starts[0]?.params).toHaveProperty('serviceTier', FIRST)
        expect(starts[1]?.params).not.toHaveProperty('serviceTier')
        second.resolve({ turn: { id: 'omitted-newer-turn' } })
        await newer
        if (reverse) {
          first.resolve({ turn: { id: 'explicit-older-turn' } })
          await older
        }
        const result = await fixture.read()
        expect(result).toMatchObject({ speed: { processing: { status: 'unknown' } } })
        expect(result).not.toHaveProperty('speed.applied')
      } finally {
        first.resolve({})
        second.resolve({})
        await fixture.close()
      }
    }
  )

  it('shows requested speed before any turn without claiming applied or processing speed', async () => {
    const fixture = await setup()
    try {
      const result = await fixture.read()
      expect(result).toMatchObject({
        speed: {
          requested: { tierId: FIRST },
          support: 'available',
          processing: { status: 'unknown' }
        }
      })
      expect(result).not.toHaveProperty('speed.applied')
    } finally {
      await fixture.close()
    }
  })

  it('records the exact acknowledged request snapshot despite a later picker change', async () => {
    const fixture = await setup()
    const reply = pendingStart(fixture.codex)
    try {
      const dispatch = fixture.send('snapshot-start')
      await waitForStarts(fixture.codex)
      expect(
        fixture.codex.connections[0].calls.find((call) => call.method === 'turn/start')?.params
      ).toMatchObject({ serviceTier: FIRST })
      await fixture.adapter.setOption({ ...IDENTITY, key: 'serviceTier', value: SECOND })
      reply.resolve({ turn: { id: 'snapshot-turn' } })
      expect(await dispatch).toMatchObject({ state: 'admitted' })
      expect(await fixture.read()).toMatchObject({
        speed: {
          requested: { tierId: SECOND },
          applied: { tierId: FIRST, turnId: 'snapshot-turn' },
          processing: { status: 'unknown' }
        }
      })
    } finally {
      reply.resolve({})
      await fixture.close()
    }
  })

  it('does not claim applied speed for a rejected turn start', async () => {
    const fixture = await setup()
    fixture.codex.routes['turn/start'] = () => {
      throw new CodexAppServerRequestError('turn/start', -32602, 'Synthetic tier rejection')
    }
    try {
      expect(await fixture.send('rejected-start')).toMatchObject({ state: 'rejected' })
      const result = await fixture.read()
      expect(result).toMatchObject({
        speed: {
          requested: { tierId: FIRST },
          processing: { status: 'unknown' }
        }
      })
      expect(result).not.toHaveProperty('speed.applied')
    } finally {
      await fixture.close()
    }
  })

  it('does not manufacture applied speed from omitted overrides or a thread config echo', async () => {
    const fixture = await setup({}, true)
    fixture.codex.routes['turn/start'] = () => ({ turn: { id: 'inherited-turn' } })
    try {
      expect(await fixture.send('omitted-tier')).toMatchObject({ state: 'admitted' })
      const start = fixture.codex.connections[0].calls.find((call) => call.method === 'turn/start')
      expect(start?.params).not.toHaveProperty('serviceTier')
      const result = await fixture.read()
      expect(result).toMatchObject({ speed: { processing: { status: 'unknown' } } })
      expect(result).not.toHaveProperty('speed.applied')
    } finally {
      await fixture.close()
    }
  })

  it('clears ephemeral applied facts when a session is acquired again', async () => {
    const fixture = await setup()
    fixture.codex.routes['turn/start'] = () => ({ turn: { id: 'old-acquisition-turn' } })
    try {
      await fixture.send('old-acquisition')
      expect(await fixture.read()).toMatchObject({
        speed: {
          applied: { tierId: FIRST, turnId: 'old-acquisition-turn' }
        }
      })
      await fixture.close()
      await fixture.acquire()
      const result = await fixture.read()
      expect(result).toMatchObject({
        speed: {
          requested: { tierId: FIRST },
          processing: { status: 'unknown' }
        }
      })
      expect(result).not.toHaveProperty('speed.applied')
    } finally {
      await fixture.close()
    }
  })

  it('keeps the newer successful request when acknowledgements arrive in reverse order', async () => {
    const fixture = await setup()
    const first = Promise.withResolvers<unknown>()
    const second = Promise.withResolvers<unknown>()
    let started = 0
    const route: Route = () => (++started === 1 ? first.promise : second.promise)
    fixture.codex.routes['turn/start'] = route
    const session = fixture.adapter['sessions'].get(IDENTITY.sessionId)
    if (!session) {
      throw new Error('Expected acquired synthetic Codex session')
    }
    try {
      const older = startCodexTurn(session, { clientMessageId: 'older-start', body: USER_MESSAGE })
      await waitForStarts(fixture.codex)
      await fixture.adapter.setOption({ ...IDENTITY, key: 'serviceTier', value: SECOND })
      const newer = startCodexTurn(session, { clientMessageId: 'newer-start', body: USER_MESSAGE })
      await waitForStarts(fixture.codex, 2)
      expect(
        fixture.codex.connections[0].calls
          .filter((call) => call.method === 'turn/start')
          .map((call) => call.params?.serviceTier)
      ).toEqual([FIRST, SECOND])
      second.resolve({ turn: { id: 'newer-turn' } })
      await newer
      first.resolve({ turn: { id: 'older-turn' } })
      await older
      expect(await fixture.read()).toMatchObject({
        speed: {
          requested: { tierId: SECOND },
          applied: { tierId: SECOND, turnId: 'newer-turn' },
          processing: { status: 'unknown' }
        }
      })
    } finally {
      first.resolve({})
      second.resolve({})
      await fixture.close()
    }
  })
})
