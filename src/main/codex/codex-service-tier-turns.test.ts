// Outgoing Codex speed requests: what a stored selection puts on the next `turn/start`, what a
// steer never carries, and when a send is refused before any write. Only the app-server
// connection is faked; options and the catalog store are the real ones.

import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { CodexAcquisitionWindow } from './codex-structured-acquisition-window'
import { CodexAppServerRequestError } from './codex-app-server-request-error'
import { CodexBackgroundTaskTracker } from './codex-background-task-tracker'
import { createCodexDispatchEchoes } from './codex-structured-dispatch-echo'
import { fetchCodexModelCatalogListing } from './codex-structured-model-catalog'
import { applyCodexStructuredSessionOption } from './codex-structured-session-options'
import type { CodexSession } from './codex-structured-session-state'
import { dispatchCodexTurn, startCodexTurn } from './codex-structured-turn-start'
import { createCodexTurnOpenWaits } from './codex-structured-turn-open-wait'

// Synthetic ids throughout: the provider catalog, not Orca, decides which request tiers exist.
const STANDARD = { id: 'default', name: 'Standard', description: 'Regular speed and usage' }
const FAST = { id: 'tier-fast-7f3', name: 'Fast', description: 'Faster responses, more usage' }
const ULTRAFAST = { id: 'tier-ultra-9c1', name: 'Ultrafast', description: 'Fastest, highest usage' }
const RETIRED_ID = 'tier-retired-3d2'
const MODEL_A = 'synthetic-model-a'
const MODEL_B = 'synthetic-model-b'
const THREAD_ID = 'thread-1'
const FINGERPRINT = 'codex-test-account'

type TierRow = { id: string; name: string; description: string }
type RecordedRequest = { method: string; params?: Record<string, unknown> }

function modelRow(id: string, tiers?: readonly TierRow[]): Record<string, unknown> {
  return {
    model: id,
    displayName: id.toUpperCase(),
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
    defaultReasoningEffort: 'high',
    isDefault: id === MODEL_A,
    ...(tiers ? { serviceTiers: tiers } : {})
  }
}

function message(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

/** The account catalog as the real listing parser and store hold it. */
async function listCatalog(
  store: AgentModelCatalogStore,
  rows: Record<string, unknown>[]
): Promise<void> {
  const request = vi.fn(async (method: string) =>
    method === 'model/list' ? { data: rows, nextCursor: null } : { config: {} }
  )
  const listing = await fetchCodexModelCatalogListing({ connection: { request } })
  store.recordSuccess(
    FINGERPRINT,
    'codex',
    {
      models: listing.models,
      fastModeTierByModel: listing.fastModeTierByModel,
      origin: 'live-session'
    },
    'discovery'
  )
}

function sessionFor(
  request: CodexSession['connection']['request'],
  options: Record<string, string>
): CodexSession {
  return {
    connection: {
      pid: 1,
      closed: false,
      request,
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => true
    },
    backgroundTasks: new CodexBackgroundTaskTracker(THREAD_ID),
    ended: false,
    fence: 1,
    acquisitionGeneration: 'generation-1',
    threadId: THREAD_ID,
    prompts: new CodexAcquisitionWindow().prompts,
    options: new Map(Object.entries(options)),
    reportedOptions: { model: MODEL_A, effort: 'high' },
    dispatchEchoes: createCodexDispatchEchoes(),
    turnOpenWaits: createCodexTurnOpenWaits(),
    activeTurnIds: new Set(),
    translator: null
  }
}

/** `catalog`: rows to list; undefined is an account never listed; null is a host with no store. */
async function turnRig(input: {
  options: Record<string, string>
  catalog?: Record<string, unknown>[] | null
  routes?: Partial<Record<string, () => unknown>>
}) {
  const requests: RecordedRequest[] = []
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    requests.push({ method, params })
    const route = input.routes?.[method]
    if (route) {
      return route()
    }
    if (method === 'turn/steer') {
      return { turnId: 'turn-1' }
    }
    if (method === 'turn/start') {
      return { turn: { id: `turn-${requests.length}` } }
    }
    throw new Error(`unexpected ${method}`)
  })
  const session = sessionFor(request, input.options)
  const store = new AgentModelCatalogStore()
  if (input.catalog !== null) {
    session.catalogAccess = { store, fingerprint: FINGERPRINT, accountHomePath: '/test-account' }
  }
  if (input.catalog) {
    await listCatalog(store, input.catalog)
  }
  return {
    session,
    requests,
    relist: (rows: Record<string, unknown>[]) => listCatalog(store, rows),
    send: (clientMessageId: string) =>
      startCodexTurn(session, { clientMessageId, body: message(clientMessageId) }),
    dispatch: (clientMessageId: string) =>
      dispatchCodexTurn(
        session,
        { sessionId: 'session-1', clientMessageId, body: message(clientMessageId) },
        undefined
      ),
    methods: () => requests.map(({ method }) => method),
    turnStarts: () => requests.filter(({ method }) => method === 'turn/start'),
    turnRequests: () => requests.filter(({ method }) => method.startsWith('turn/'))
  }
}

const allTiers = [STANDARD, FAST, ULTRAFAST]
const unrelatedOptions = { model: MODEL_A, effort: 'high', personality: 'friendly' }

describe('an advertised custom Ultrafast tier', () => {
  it('reaches the exact next turn/start on the same thread, leaving other options alone', async () => {
    const rig = await turnRig({
      options: unrelatedOptions,
      catalog: [modelRow(MODEL_A, allTiers)]
    })

    await expect(
      applyCodexStructuredSessionOption(rig.session, 'serviceTier', ULTRAFAST.id)
    ).resolves.toMatchObject({ serviceTier: ULTRAFAST.id })
    expect(await rig.send('first')).toMatchObject({ via: 'start' })
    expect(await rig.send('second')).toMatchObject({ via: 'start' })

    const starts = rig.turnStarts().map(({ params }) => params)
    expect(starts).toHaveLength(2)
    for (const params of starts) {
      expect(params).toMatchObject({ threadId: THREAD_ID, ...unrelatedOptions })
      expect(params).toMatchObject({ serviceTier: ULTRAFAST.id })
      expect(params).not.toHaveProperty('fastMode')
    }
    expect(rig.methods().filter((method) => method.startsWith('thread/'))).toEqual([])
    expect(rig.session.threadId).toBe(THREAD_ID)
    expect(rig.session.ended).toBe(false)
    expect(rig.session.reportedOptions).toEqual({ model: MODEL_A, effort: 'high' })
    expect(Object.fromEntries(rig.session.options)).toEqual({
      ...unrelatedOptions,
      serviceTier: ULTRAFAST.id
    })
  })
})

describe('canonical serviceTier against a stale fastMode', () => {
  it.each([
    ['custom Ultrafast over fastMode=true', ULTRAFAST.id, 'true'],
    ['custom Ultrafast over fastMode=false', ULTRAFAST.id, 'false'],
    ['Standard over fastMode=true', STANDARD.id, 'true'],
    ['advertised Fast over fastMode=false', FAST.id, 'false']
  ])('sends %s', async (_name, serviceTier, fastMode) => {
    const rig = await turnRig({
      options: { ...unrelatedOptions, serviceTier, fastMode },
      catalog: [modelRow(MODEL_A, allTiers)]
    })

    await rig.send('first')

    const [start] = rig.turnStarts()
    expect(start?.params).toMatchObject({ serviceTier })
    expect(start?.params).not.toHaveProperty('fastMode')
  })
})

describe('a speed selection and a running turn', () => {
  it('keeps a selection that predates the send off turn/steer', async () => {
    const rig = await turnRig({
      options: { ...unrelatedOptions, serviceTier: ULTRAFAST.id },
      catalog: [modelRow(MODEL_A, allTiers)]
    })
    rig.session.activeTurnIds?.add('turn-1')

    expect(await rig.send('during')).toMatchObject({ via: 'steer', turnId: 'turn-1' })

    expect(rig.turnRequests()).toEqual([
      {
        method: 'turn/steer',
        params: {
          threadId: THREAD_ID,
          expectedTurnId: 'turn-1',
          clientUserMessageId: 'during',
          input: [{ type: 'text', text: 'during' }]
        }
      }
    ])
  })

  it('applies a selection changed mid-turn to the next turn/start only', async () => {
    const rig = await turnRig({
      options: unrelatedOptions,
      catalog: [modelRow(MODEL_A, allTiers)]
    })
    rig.session.activeTurnIds?.add('turn-1')

    await applyCodexStructuredSessionOption(rig.session, 'serviceTier', ULTRAFAST.id)
    expect(await rig.send('during')).toMatchObject({ via: 'steer' })
    rig.session.activeTurnIds?.clear()
    expect(await rig.send('after')).toMatchObject({ via: 'start' })

    expect(rig.methods()).toEqual(['turn/steer', 'turn/start'])
    const [steer, start] = rig.turnRequests()
    expect(steer?.params).not.toHaveProperty('serviceTier')
    expect(steer?.params).not.toHaveProperty('fastMode')
    expect(start?.params).toMatchObject({ threadId: THREAD_ID, serviceTier: ULTRAFAST.id })
  })

  it.each([
    ['retired by a refresh during the turn', ULTRAFAST.id],
    ['never advertised', RETIRED_ID]
  ])(
    'steers past a tier that is %s, then refuses the next turn/start and keeps the intent',
    async (_name, serviceTier) => {
      const rig = await turnRig({
        options: { ...unrelatedOptions, serviceTier },
        catalog: [modelRow(MODEL_A, allTiers)]
      })
      rig.session.activeTurnIds?.add('turn-1')
      await rig.relist([modelRow(MODEL_A, [STANDARD, FAST])])

      await expect(rig.dispatch('during')).resolves.toEqual({ state: 'admitted' })

      expect(rig.turnRequests()).toEqual([
        {
          method: 'turn/steer',
          params: {
            threadId: THREAD_ID,
            expectedTurnId: 'turn-1',
            clientUserMessageId: 'during',
            input: [{ type: 'text', text: 'during' }]
          }
        }
      ])

      rig.session.activeTurnIds?.clear()
      rig.session.dispatchEchoes.endTurn(THREAD_ID, 'turn-1', { status: 'completed' })
      await expect(rig.dispatch('after')).resolves.toMatchObject({
        state: 'rejected',
        reason: expect.any(String)
      })

      // Still only the steer: no turn/start, so no silent Standard.
      expect(rig.methods()).toEqual(['turn/steer'])
      expect(Object.fromEntries(rig.session.options)).toEqual({ ...unrelatedOptions, serviceTier })
    }
  )
})

type CatalogCase = [
  name: string,
  selected: Record<string, string>,
  catalog: Record<string, unknown>[] | null | undefined
]

const protocolStandardCases: CatalogCase[] = [
  ['a host with no catalog store', { serviceTier: 'default' }, null],
  ['an account never listed', { serviceTier: 'default' }, undefined],
  ['a model with unknown tier metadata', { serviceTier: 'default' }, [modelRow(MODEL_A)]],
  ['a migrated fastMode=false', { fastMode: 'false' }, undefined]
]

const unvouchedTierCases: CatalogCase[] = [
  ['retired from the model', { serviceTier: RETIRED_ID }, [modelRow(MODEL_A, [STANDARD, FAST])]],
  [
    'absent from a model whose list is explicitly Standard-only',
    { serviceTier: ULTRAFAST.id },
    [modelRow(MODEL_A, [])]
  ],
  [
    'a custom id on a model with unknown tier metadata',
    { serviceTier: ULTRAFAST.id },
    [modelRow(MODEL_A)]
  ],
  ['a custom id before the account was ever listed', { serviceTier: ULTRAFAST.id }, undefined],
  ['unresolved legacy Fast intent', { fastMode: 'true' }, [modelRow(MODEL_A)]]
]

describe('protocol Standard', () => {
  it.each(protocolStandardCases)('is admitted for %s', async (_name, selected, catalog) => {
    const rig = await turnRig({ options: { ...unrelatedOptions, ...selected }, catalog })

    await expect(rig.dispatch('first')).resolves.toEqual({ state: 'admitted' })

    expect(rig.turnStarts().map(({ params }) => params)).toEqual([
      expect.objectContaining({ threadId: THREAD_ID, serviceTier: 'default' })
    ])
  })
})

describe('a tier the catalog cannot vouch for', () => {
  it.each(unvouchedTierCases)(
    'is rejected before any turn request: %s',
    async (_name, selected, catalog) => {
      const options = { ...unrelatedOptions, ...selected }
      const rig = await turnRig({ options, catalog })

      await expect(rig.dispatch('first')).resolves.toMatchObject({
        state: 'rejected',
        reason: expect.any(String)
      })

      // No turn/start at all, so no silent Standard.
      expect(rig.turnRequests()).toEqual([])
      expect(Object.fromEntries(rig.session.options)).toEqual(options)
    }
  )
})

describe('a catalog or model change under a selected tier', () => {
  it('refuses once a refresh retires the tier, keeps the pick, and sends again when it returns', async () => {
    const rig = await turnRig({
      options: { ...unrelatedOptions, serviceTier: ULTRAFAST.id },
      catalog: [modelRow(MODEL_A, allTiers)]
    })
    await rig.send('before-refresh')

    await rig.relist([modelRow(MODEL_A, [STANDARD, FAST])])
    await expect(rig.dispatch('retried')).resolves.toMatchObject({ state: 'rejected' })

    expect(rig.turnStarts()).toHaveLength(1)
    expect(rig.session.options.get('serviceTier')).toBe(ULTRAFAST.id)

    await rig.relist([modelRow(MODEL_A, allTiers)])
    await expect(rig.dispatch('retried')).resolves.toEqual({ state: 'admitted' })

    expect(rig.turnStarts().map(({ params }) => params?.serviceTier)).toEqual([
      ULTRAFAST.id,
      ULTRAFAST.id
    ])
  })

  it('refuses on a model without the tier, keeps the pick, and sends on the model that has it', async () => {
    const rig = await turnRig({
      options: { ...unrelatedOptions, serviceTier: ULTRAFAST.id },
      catalog: [modelRow(MODEL_A, allTiers), modelRow(MODEL_B, [STANDARD, FAST])]
    })

    await expect(
      applyCodexStructuredSessionOption(rig.session, 'model', MODEL_B)
    ).resolves.toMatchObject({ model: MODEL_B, serviceTier: ULTRAFAST.id })
    await expect(rig.dispatch('on-b')).resolves.toMatchObject({ state: 'rejected' })
    expect(rig.turnRequests()).toEqual([])

    await applyCodexStructuredSessionOption(rig.session, 'model', MODEL_A)
    await expect(rig.dispatch('on-a')).resolves.toEqual({ state: 'admitted' })

    expect(rig.turnStarts().map(({ params }) => params)).toEqual([
      expect.objectContaining({ model: MODEL_A, serviceTier: ULTRAFAST.id })
    ])
  })
})

describe('a provider refusal of the requested tier', () => {
  it('never retries cheaper and keeps the requested tier for the next send', async () => {
    let starts = 0
    const rig = await turnRig({
      options: { ...unrelatedOptions, serviceTier: ULTRAFAST.id },
      catalog: [modelRow(MODEL_A, allTiers)],
      routes: {
        'turn/start': () => {
          starts += 1
          if (starts === 1) {
            throw new CodexAppServerRequestError(
              'turn/start',
              -32600,
              'codex app-server turn/start failed: tier not available for this account',
              'tier not available for this account'
            )
          }
          return { turn: { id: 'turn-2' } }
        }
      }
    })

    await expect(rig.dispatch('refused')).resolves.toMatchObject({
      state: 'rejected',
      rejection: {
        kind: 'providerRejected',
        detail: { text: 'tier not available for this account', audience: 'person' }
      }
    })

    expect(rig.turnStarts().map(({ params }) => params?.serviceTier)).toEqual([ULTRAFAST.id])
    expect(rig.session.options.get('serviceTier')).toBe(ULTRAFAST.id)

    await expect(rig.dispatch('next')).resolves.toEqual({ state: 'admitted' })

    expect(rig.turnStarts().map(({ params }) => params?.serviceTier)).toEqual([
      ULTRAFAST.id,
      ULTRAFAST.id
    ])
    expect(Object.fromEntries(rig.session.options)).toEqual({
      ...unrelatedOptions,
      serviceTier: ULTRAFAST.id
    })
  })
})
