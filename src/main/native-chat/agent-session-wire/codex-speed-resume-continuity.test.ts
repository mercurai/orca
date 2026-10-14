// Released-lease resume over the real Codex adapter, the production record store and real journals.
// A saved speed choice and a blocked requested one survive a process restart on the same provider
// thread and account, and a conversation keeps the account that launched it while the global
// selection moves. Each attach reopens the store from disk and reconciles a pid-absent owner, as a
// restarted host does; nothing here talks to a real provider.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { CODEX_STRUCTURED_AGENT } from '../../codex/codex-structured-agent-definition'
import { createCodexStructuredLaunchResolver } from '../../codex/codex-structured-launch-resolution'
import { refusedCodexServiceTier } from '../../codex/codex-structured-speed-intent'
import type { CodexStructuredSessionAdapter } from '../../codex/codex-structured-session-adapter'
import {
  THREAD_ID,
  USER_MESSAGE,
  adapterFor,
  answerWithOpenedTurn,
  fakeCodex
} from '../../codex/codex-structured-session-adapter-fixture'
import type { CodexStructuredSessionAdapterDeps } from '../../codex/codex-structured-session-state'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabase,
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { agentModelCatalogSessionAccess } from '../agent-model-catalog/agent-model-catalog-fingerprint'
import { AgentModelCatalogStore } from '../agent-model-catalog/agent-model-catalog-store'
import { claudeAndCodexAgents } from './structured-agent-session-adapter-router-test-support'
import {
  attachFingerprintFields,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'
import { performAttach } from './structured-agent-session-attach-flow'
import { openTestAttachConversation } from './structured-agent-session-attach-test-conversation'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { performSetOption, type AgentSessionTurnContext } from './structured-agent-session-turns'

const NOW = 1_800_000_000_000
const SESSION = 'session-speed-continuity'
const CREATE_OPERATION = `${NOW}-${'1'.padStart(32, '0')}`
const RESUME_OPERATION = `${NOW}-${'2'.padStart(32, '0')}`
const PINNED_HOME = '/accounts/pinned/.codex'
const GLOBAL_HOME = '/accounts/global-now/.codex'
// The model the fake provider's thread reports, so a catalog row names the session's own model.
const MODEL = 'gpt-live'
// Synthetic ids: each account's catalog decides which tiers exist.
const STANDARD = { value: 'default', label: 'Standard' }
const FAST = { value: 'Tier.Fast-77a', label: 'Fast' }
const ULTRA = { value: 'Tier.Ultra-9c1', label: 'Ultrafast' }
const GLOBAL_FAST = { value: 'Tier.Fast-global-3d', label: 'Fast' }
const ACKNOWLEDGED: Readonly<Record<string, string>> = { model: MODEL, serviceTier: FAST.value }
// What a `turn/start` may name: a provider-private record of a refusal is never among them.
const TURN_START_FIELDS = [
  'threadId',
  'clientUserMessageId',
  'input',
  'model',
  'effort',
  'approvalsReviewer',
  'personality',
  'serviceTier'
]

type Tier = { value: string; label: string }
type DepsFor = (store: AgentSessionRecordStore) => Partial<CodexStructuredSessionAdapterDeps>
type Child = {
  adapter: CodexStructuredSessionAdapter
  codex: ReturnType<typeof fakeCodex>
}

const roots: string[] = []
const journals: AgentSessionJournal[] = []
const adapters: CodexStructuredSessionAdapter[] = []

// Children first, then the journals they write to, then the shared databases under both.
afterEach(async () => {
  await Promise.allSettled(adapters.splice(0).map((adapter) => adapter.closeAll()))
  await Promise.allSettled(journals.splice(0).map((journal) => journal.close()))
  closeTestJournalHostDatabases()
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function advertise(store: AgentModelCatalogStore, home: string, tiers: readonly Tier[]): void {
  const access = agentModelCatalogSessionAccess(store, CODEX_STRUCTURED_AGENT, home)!
  const fast = tiers.find((tier) => tier.label === 'Fast')
  store.recordSuccess(
    access.fingerprint,
    'codex',
    {
      models: [
        { id: MODEL, label: 'GPT Live', isDefault: true, efforts: [], serviceTiers: [...tiers] }
      ],
      fastModeTierByModel: new Map<string, string>(fast ? [[MODEL, fast.value]] : []),
      origin: 'live-session'
    },
    'discovery'
  )
}

function attachParams(
  operationId: string,
  expectedRuntimeFence: number | null,
  options?: Readonly<Record<string, string>>
): AgentSessionAttachParams {
  const params: AgentSessionAttachParams = {
    envelope: {
      sessionId: SESSION,
      clientOperationId: operationId,
      expectedRuntimeFence,
      payloadFingerprint: ''
    },
    location: {
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    provider: 'codex',
    agent: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: PINNED_HOME },
    runtimeKind: 'native',
    ...(options ? { options } : {}),
    providerHandle: { kind: 'codex', threadId: THREAD_ID }
  }
  return {
    ...params,
    envelope: {
      ...params.envelope,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.attach',
        sessionId: SESSION,
        fields: attachFingerprintFields(params)
      })
    }
  }
}

async function attach(input: {
  root: string
  store: AgentSessionRecordStore
  adapter: CodexStructuredSessionAdapter
  operationId: string
  expectedFence: number | null
  spawnToken: string
  options?: Readonly<Record<string, string>>
  now: number
}): Promise<AgentSessionJournal> {
  let journal: AgentSessionJournal | undefined
  const attached = await performAttach({
    agents: claudeAndCodexAgents(input.adapter),
    logger: createStructuredAgentSessionLogger(),
    store: input.store,
    adapter: input.adapter,
    openConversation: openTestAttachConversation(openTestJournalHostDatabase(input.root)),
    authority: {
      spawnToken: input.spawnToken,
      claimKeyId: 'key-1',
      handoffOperationId: input.operationId,
      probe: { outcome: 'reservation-unused' }
    },
    callerKey: 'client-1',
    optionRevision: () => 0,
    params: attachParams(input.operationId, input.expectedFence, input.options),
    now: () => input.now,
    onAttached: (attached) => {
      journal = attached.journal
    }
  })
  expect(attached).toMatchObject({ ok: true })
  journals.push(journal!)
  return journal!
}

/** One provider child over a fake app-server, with the host's catalog store beside it. */
function openChild(input: {
  modelCatalog: AgentModelCatalogStore
  store: AgentSessionRecordStore
  resumeThreadId: string | null
  depsFor?: DepsFor
}): Child {
  const codex = fakeCodex()
  codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'turn-1')
  const adapter = adapterFor(
    codex,
    { codexHome: PINNED_HOME, resumeThreadId: input.resumeThreadId },
    [],
    { modelCatalog: input.modelCatalog, ...input.depsFor?.(input.store) }
  )
  adapters.push(adapter)
  return { adapter, codex }
}

function fenceOf(store: AgentSessionRecordStore): number {
  return store.getRecord(SESSION)?.lease.runtimeFence ?? 0
}

async function createConversation(input: {
  tiers: readonly Tier[]
  options: Readonly<Record<string, string>>
  depsFor?: DepsFor
  modelCatalog?: AgentModelCatalogStore
}) {
  const root = await mkdtemp(join(tmpdir(), 'orca-codex-speed-continuity-'))
  roots.push(root)
  const modelCatalog = input.modelCatalog ?? new AgentModelCatalogStore()
  advertise(modelCatalog, PINNED_HOME, input.tiers)
  const store = await openTestAgentSessionRecordStore(root)
  const child = openChild({ modelCatalog, store, resumeThreadId: null, depsFor: input.depsFor })
  const journal = await attach({
    root,
    store,
    adapter: child.adapter,
    operationId: CREATE_OPERATION,
    expectedFence: null,
    spawnToken: 'spawn-a',
    options: input.options,
    now: NOW
  })
  return { root, store, modelCatalog, depsFor: input.depsFor, journal, fence: fenceOf(store), ...child }
}

/** The host process is gone: its journal and database close without a lease release, a new store
 *  reads the disk, releases the dead owner, and a new child resumes the proved thread under the
 *  released lease's next fence. */
async function resumeAfterRestart(host: {
  root: string
  modelCatalog: AgentModelCatalogStore
  depsFor?: DepsFor
  journal: AgentSessionJournal
}) {
  const closing = journals.indexOf(host.journal)
  if (closing >= 0) {
    journals.splice(closing, 1)
  }
  await host.journal.close()
  closeTestJournalHostDatabase(host.root)
  const store = await openTestAgentSessionRecordStore(host.root)
  // The dead host's owner is still on disk until the restart probe proves the pid gone.
  expect(store.getRecord(SESSION)?.lease.unreconciled).toBe(true)
  await store.reconcileOnRestart({
    probe: async () => ({ outcome: 'pid-absent' }),
    now: NOW + 1
  })
  const released = store.getRecord(SESSION)?.lease
  expect(released).toMatchObject({ claimStatus: 'released', unreconciled: false })
  const child = openChild({
    modelCatalog: host.modelCatalog,
    store,
    resumeThreadId: THREAD_ID,
    depsFor: host.depsFor
  })
  const journal = await attach({
    root: host.root,
    store,
    adapter: child.adapter,
    operationId: RESUME_OPERATION,
    expectedFence: fenceOf(store),
    spawnToken: 'spawn-b',
    now: NOW + 1
  })
  expect(fenceOf(store)).toBeGreaterThan(released?.runtimeFence ?? Number.POSITIVE_INFINITY)
  return { ...host, store, journal, fence: fenceOf(store), ...child }
}

async function persistedRecord(root: string) {
  return (await openTestAgentSessionRecordStore(root)).getRecord(SESSION)
}

function pickTier(
  conversation: {
    adapter: CodexStructuredSessionAdapter
    journal: AgentSessionJournal
    store: AgentSessionRecordStore
    fence: number
  },
  value: string
) {
  const { adapter, journal, store, fence } = conversation
  const ctx: AgentSessionTurnContext = {
    logger: createStructuredAgentSessionLogger(),
    sessionId: SESSION,
    journal,
    fence,
    adapter,
    agents: claudeAndCodexAgents(adapter),
    agent: 'codex',
    // The record's options as they stand at each action, as a mutation's own context reads them.
    get persistedOptions() {
      return store.getRecord(SESSION)?.options ?? {}
    },
    persistOptions: async (options) => {
      await store.replaceSessionOptions({ sessionId: SESSION, fence, options, now: NOW + 2 })
    },
    resolvedBy: 'client-1',
    publish: vi.fn(),
    now: () => NOW + 2
  }
  return performSetOption(ctx, { key: 'serviceTier', value })
}

function dispatchNext(child: Child, fence: number) {
  return child.adapter.dispatch({
    sessionId: SESSION,
    clientMessageId: 'message-1',
    body: USER_MESSAGE,
    fence
  })
}

function turnStarts(child: Child) {
  return child.codex.connections
    .flatMap((connection) => connection.calls)
    .filter((call) => call.method === 'turn/start')
}

function expectOnlyPublicTurnFields(params: Record<string, unknown> | undefined): void {
  expect(TURN_START_FIELDS).toEqual(expect.arrayContaining(Object.keys(params ?? {})))
}

describe('a saved supported tier across a released-lease resume', () => {
  it('stays on the same provider thread and account, and rides the next request', async () => {
    const created = await createConversation({
      tiers: [STANDARD, FAST, ULTRA],
      options: ACKNOWLEDGED
    })
    const before = created.store.getRecord(SESSION)
    expect(before?.options).toMatchObject({ serviceTier: FAST.value })

    const resumed = await resumeAfterRestart(created)

    const after = await persistedRecord(created.root)
    expect(after?.options).toMatchObject({ model: MODEL, serviceTier: FAST.value })
    expect(after?.accountHome).toEqual(before?.accountHome)
    expect(agentSessionProviderHandleChainHead(after?.providerHandleChain ?? [])?.handle).toEqual(
      codexProviderHandle(THREAD_ID)
    )
    const calls = resumed.codex.connections[0].calls
    expect(calls.map((call) => call.method)).not.toContain('thread/start')
    expect(calls.find((call) => call.method === 'thread/resume')?.params).toMatchObject({
      threadId: THREAD_ID
    })

    await dispatchNext(resumed, resumed.fence)

    const [start] = turnStarts(resumed)
    expect(start?.params).toMatchObject({ threadId: THREAD_ID, serviceTier: FAST.value })
    expectOnlyPublicTurnFields(start?.params)
  })
})

describe('a refused requested tier across restart, report and refresh', () => {
  /** The refusal comes from the adapter's real unsupported-tier path; the catalog then refreshes to
   *  list the refused id while the host is down, and a new process resumes the conversation. */
  async function restartedWithRefusedUltra() {
    const created = await createConversation({ tiers: [STANDARD, FAST], options: ACKNOWLEDGED })
    const refused = await pickTier(created, ULTRA.value)
    expect(refused).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'optionRejected' } }
    })
    const recorded = (await persistedRecord(created.root))?.options
    expect(recorded).toMatchObject(ACKNOWLEDGED)
    expect(Object.values(recorded ?? {})).toContain(ULTRA.value)
    advertise(created.modelCatalog, PINNED_HOME, [STANDARD, FAST, ULTRA])
    return resumeAfterRestart(created)
  }

  it('keeps the accepted tier canonical and the refused request on the record and the report', async () => {
    const resumed = await restartedWithRefusedUltra()

    const options = (await persistedRecord(resumed.root))?.options
    expect(options).toMatchObject(ACKNOWLEDGED)
    expect(Object.values(options ?? {})).toContain(ULTRA.value)
    const report = await resumed.adapter.readOptions({ sessionId: SESSION, fence: resumed.fence })
    expect(report.current.serviceTier).toBe(FAST.value)
    // The refresh now lists the id, which never lifts a block the person has not replaced.
    expect(report.speed?.selection).toMatchObject({ tierId: ULTRA.value })
    expect(report.speed?.selection.state).not.toBe('ready')
  })

  it('refuses the next dispatch before any write, at the refused tier and at every other', async () => {
    const resumed = await restartedWithRefusedUltra()

    const outcome = await dispatchNext(resumed, resumed.fence)

    expect(outcome.state).toBe('rejected')
    expect(turnStarts(resumed)).toEqual([])
  })

  it('lets only an explicit accepted replacement send, with no private field on the request', async () => {
    const resumed = await restartedWithRefusedUltra()

    const replaced = await pickTier(resumed, ULTRA.value)

    expect(replaced).toMatchObject({ ok: true })
    const options = (await persistedRecord(resumed.root))?.options ?? {}
    expect(Object.entries(options).filter(([, value]) => value === ULTRA.value)).toEqual([
      ['serviceTier', ULTRA.value]
    ])
    await dispatchNext(resumed, resumed.fence)
    const [start] = turnStarts(resumed)
    expect(start?.params).toMatchObject({ serviceTier: ULTRA.value })
    expectOnlyPublicTurnFields(start?.params)
  })
})

describe('a saved option the adapter does not recognise, across speed writes and restart', () => {
  const UNRELATED = { unrelatedSavedOption: 'keep-this' }
  const SAVED = { ...ACKNOWLEDGED, ...UNRELATED }

  async function createWithUnrelated(tiers: readonly Tier[]) {
    const created = await createConversation({ tiers, options: SAVED })
    // The host's own acquisition read keeps what the child never held.
    expect(created.store.getRecord(SESSION)?.options).toMatchObject(SAVED)
    return created
  }

  function expectNoRefusalRecord(options: Readonly<Record<string, string>> | undefined): void {
    expect(refusedCodexServiceTier(options ?? {})).toBeUndefined()
    expect(options ?? {}).not.toHaveProperty('fastMode')
  }

  it('survives an accepted canonical speed write and the restart after it', async () => {
    const created = await createWithUnrelated([STANDARD, FAST, ULTRA])

    const picked = await pickTier(created, ULTRA.value)

    expect(picked).toMatchObject({ ok: true })
    const written = (await persistedRecord(created.root))?.options
    expect(written).toMatchObject({ model: MODEL, serviceTier: ULTRA.value, ...UNRELATED })
    expectNoRefusalRecord(written)
    const resumed = await resumeAfterRestart(created)
    const restored = (await persistedRecord(resumed.root))?.options
    expect(restored).toMatchObject({ model: MODEL, serviceTier: ULTRA.value, ...UNRELATED })
    await dispatchNext(resumed, resumed.fence)
    const [start] = turnStarts(resumed)
    expect(start?.params).toMatchObject({ serviceTier: ULTRA.value })
    expect(start?.params).not.toHaveProperty('unrelatedSavedOption')
    expectOnlyPublicTurnFields(start?.params)
  })

  it('survives a refused custom tier and an explicit replacement on the resumed child', async () => {
    const created = await createWithUnrelated([STANDARD, FAST])
    const refused = await pickTier(created, ULTRA.value)
    expect(refused).toMatchObject({ ok: false, refusal: { details: { reason: 'optionRejected' } } })
    const blocked = (await persistedRecord(created.root))?.options
    expect(blocked).toMatchObject(SAVED)
    expect(refusedCodexServiceTier(blocked ?? {})).toBe(ULTRA.value)
    advertise(created.modelCatalog, PINNED_HOME, [STANDARD, FAST, ULTRA])
    const resumed = await resumeAfterRestart(created)
    const restored = (await persistedRecord(resumed.root))?.options
    expect(restored).toMatchObject(SAVED)
    expect(refusedCodexServiceTier(restored ?? {})).toBe(ULTRA.value)

    const replaced = await pickTier(resumed, STANDARD.value)

    expect(replaced).toMatchObject({ ok: true })
    const options = (await persistedRecord(resumed.root))?.options
    expect(options).toMatchObject({ model: MODEL, serviceTier: STANDARD.value, ...UNRELATED })
    expectNoRefusalRecord(options)
    expect(Object.values(options ?? {})).not.toContain(ULTRA.value)
    await dispatchNext(resumed, resumed.fence)
    const [start] = turnStarts(resumed)
    expect(start?.params).toMatchObject({ serviceTier: STANDARD.value })
    expect(start?.params).not.toHaveProperty('unrelatedSavedOption')
    expect(Object.values(start?.params ?? {})).not.toContain(ULTRA.value)
    expectOnlyPublicTurnFields(start?.params)
  })
})

describe('a conversation pinned to the account that launched it', () => {
  it('resolves the launch and the catalog from its own record while the global account moves', async () => {
    const launches: {
      identity: AgentSessionJournalIdentity
      codexHome: string | null
      resumeThreadId: string | null
    }[] = []
    const depsFor: DepsFor = (store) => {
      const resolve = createCodexStructuredLaunchResolver({
        store,
        resolveLaunchArgs: () => [],
        resolveWorkspacePath: async () => '/work/repo',
        resolveCommand: () => 'codex',
        resolveRollout: async () => null,
        // The global selection has moved on; its environment names the other account.
        resolveEnvironment: async () => ({ CODEX_HOME: GLOBAL_HOME })
      })
      return {
        resolveLaunch: async (input) => {
          const launch = await resolve(input)
          launches.push({
            identity: input.identity,
            codexHome: launch.codexHome,
            resumeThreadId: launch.resumeThreadId
          })
          return launch
        }
      }
    }
    const modelCatalog = new AgentModelCatalogStore()
    advertise(modelCatalog, GLOBAL_HOME, [STANDARD, GLOBAL_FAST])
    const created = await createConversation({
      tiers: [STANDARD, FAST],
      options: ACKNOWLEDGED,
      depsFor,
      modelCatalog
    })

    const resumed = await resumeAfterRestart(created)
    await dispatchNext(resumed, resumed.fence)

    const record = await persistedRecord(created.root)
    expect(record?.accountHome).toEqual({ variable: 'CODEX_HOME', path: PINNED_HOME })
    // One launch per acquisition, the create and the resume; every one reads the pinned account.
    expect(launches.length).toBeGreaterThanOrEqual(2)
    expect(launches.every((launch) => launch.codexHome === PINNED_HOME)).toBe(true)
    expect(launches.at(-1)).toMatchObject({
      resumeThreadId: THREAD_ID,
      identity: {
        sessionId: SESSION,
        agent: 'codex',
        providerHandle: codexProviderHandle(THREAD_ID)
      }
    })
    expect(resumed.codex.connections[0].launch.env?.CODEX_HOME).toBe(PINNED_HOME)
    // The pinned account's catalog vouches for its own Fast id; the global account's never does.
    const [start] = turnStarts(resumed)
    expect(start?.params).toMatchObject({ threadId: THREAD_ID, serviceTier: FAST.value })
    expect(start?.params?.serviceTier).not.toBe(GLOBAL_FAST.value)
  })
})

describe('two hosts holding a conversation under one id and account path', () => {
  it('keep their durable options and catalog facts apart', async () => {
    const hostA = await createConversation({ tiers: [STANDARD, FAST, ULTRA], options: ACKNOWLEDGED })
    const hostB = await createConversation({ tiers: [STANDARD, FAST], options: ACKNOWLEDGED })

    const pickedOnA = await pickTier(hostA, ULTRA.value)

    expect(pickedOnA).toMatchObject({ ok: true })
    expect((await persistedRecord(hostA.root))?.options).toMatchObject({ serviceTier: ULTRA.value })
    expect((await persistedRecord(hostB.root))?.options).toMatchObject({ serviceTier: FAST.value })
    // B's own account catalog never advertised it, so A's acceptance cannot vouch for B.
    expect(await pickTier(hostB, ULTRA.value)).toMatchObject({ ok: false })
    await dispatchNext(hostB, hostB.fence)
    for (const call of turnStarts(hostB)) {
      expect(call.params?.serviceTier).not.toBe(ULTRA.value)
    }
  })
})
