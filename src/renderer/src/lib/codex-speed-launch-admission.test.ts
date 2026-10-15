// @vitest-environment happy-dom
// Codex speed admission at the launch boundary, against the real launch registry, launch storage and
// composer draft store. Only the host (runtime RPC, capability probe, tab inventory) is faked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import type * as LaunchIntentModule from '@/lib/launch-structured-agent-session'
import type * as DraftCacheModule from '@/components/native-chat/native-chat-draft-cache'
import type * as DraftStoreModule from '@/components/native-chat/native-chat-composer-draft-store'
import type * as LaunchModule from './structured-agent-session-launch'
import type * as OptionsModule from './structured-agent-session-launch-options'
import type * as PublicationModule from './structured-agent-session-launch-publication'
import type * as RegistryModule from './structured-agent-session-launch-registry'

type CallParams = {
  envelope?: { expectedRuntimeFence?: number | null }
  key?: string
  value?: string
}

type Support = 'unknown' | 'supported' | 'unsupported'
type StructuredAgentSessionLaunchIntent = LaunchIntentModule.StructuredAgentSessionLaunchIntent

const mocks = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params: CallParams) => Promise<unknown>>(),
  createIntent: vi.fn(),
  restoreIntent: vi.fn(),
  retryIntent: vi.fn(),
  launch: vi.fn(),
  refresh: vi.fn(),
  speedSupport: vi.fn<(target: unknown) => Promise<'unknown' | 'supported' | 'unsupported'>>()
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn() } }))

// Only intent building and the create call are faked; the rest, including the real create used by the
// "create seed" cases through `vi.importActual`, is the shipped module.
vi.mock('@/lib/launch-structured-agent-session', async () => {
  const actual = await vi.importActual<typeof LaunchIntentModule>(
    '@/lib/launch-structured-agent-session'
  )
  return {
    ...actual,
    createStructuredAgentSessionLaunchIntent: mocks.createIntent,
    retryStructuredAgentSessionLaunchIntent: mocks.retryIntent,
    restoreStructuredAgentSessionLaunchIntent: mocks.restoreIntent,
    abandonStructuredAgentSessionLaunchIntent: vi.fn(),
    launchStructuredAgentSession: mocks.launch
  }
})

vi.mock('@/runtime/local-structured-session-tabs-sync', () => ({
  refreshLocalStructuredSessionTabs: mocks.refresh
}))

// A paired host's inventory is read over RPC; here both hosts answer from the same fake.
vi.mock('@/runtime/structured-session-tab-inventory', () => ({
  readStructuredSessionTabInventory: () => mocks.refresh()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  readStructuredAgentSessionCodexSpeedSupport: mocks.speedSupport
}))

// A send to a paired server first checks that server's compatibility over the desktop bridge, which
// this suite has none of; the real check fails the send before its request, as it does in the sibling
// launch suites that mock it the same way.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ensureRuntimeEnvironmentCompatible: vi.fn(async () => undefined)
}))

vi.mock('@/runtime/structured-agent-session-owner', () => ({
  resolveStructuredAgentSessionOwner: vi.fn(),
  structuredAgentSessionFocusOwner: vi.fn(),
  structuredAgentSessionTargetForHost: vi.fn()
}))

vi.mock('@/runtime/web-session-focus-intent', () => ({
  clearWebSessionFocusIntentIfMatches: vi.fn(),
  recordWebSessionFocusIntent: vi.fn(),
  resolveWebSessionVisibleTabId: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      unifiedTabsByWorktree: {},
      seedNativeChatLaunchDraft: vi.fn(),
      clearNativeChatLaunchDraft: vi.fn()
    }),
    subscribe: () => () => {}
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/lib/agent-catalog', () => ({
  getAgentLabel: () => 'Codex',
  getAgentCatalog: () => [{ id: 'codex', label: 'Codex' }]
}))

import {
  StructuredAgentSessionSpeedHostUnknownError,
  StructuredAgentSessionSpeedHostUnsupportedError
} from '@/lib/structured-agent-session-launch-errors'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from '@/components/native-chat/native-chat-draft-cache'
import {
  nativeChatComposerDraftWritesSettled,
  structuredAgentSessionDraftScopeKey
} from '@/components/native-chat/native-chat-composer-draft-store'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '@/components/native-chat/native-chat-composer-draft-storage'
import {
  cancelStructuredAgentLaunch,
  getStructuredAgentSessionLaunchLifecycle,
  startStructuredAgentLaunch
} from './structured-agent-session-launch'
import {
  getStructuredAgentSessionLaunchSelection,
  holdStructuredAgentSessionLaunchOption,
  recheckStructuredAgentSessionLaunchSpeed,
  type StructuredLaunchOptionOutcome,
  type StructuredLaunchSelection
} from './structured-agent-session-launch-options'
import { StructuredAgentSessionLaunchCancelledError } from './structured-agent-session-launch-recovery'
import { resetStructuredAgentLaunchPersistenceForTests } from './structured-agent-session-launch-persistence'
import {
  discardStructuredLaunchPrompts,
  hasStagedStructuredLaunchPrompt
} from './structured-agent-session-launch-prompt'
import { resetStructuredAgentSessionSendsForTests } from '@/components/native-chat/structured-agent-session-message-sender'
import {
  getStructuredAgentSessionLaunchSpeedBlock,
  resetStructuredAgentLaunchRegistryForTests
} from './structured-agent-session-launch-registry'

const WORKTREE_ID = 'wt-1'
const SESSION_ID = 'session-1'
const LAUNCH_STORAGE_KEY = 'orca:structuredAgentLaunches:v1'
const FIRST_TURN = 'first turn'
const SEED = { model: 'gpt-seeded' }
const DELIVERED = { delivered: true, failureNotified: false }
const SERVER_TARGET = { kind: 'environment', environmentId: 'server-1' } as const
// What the host said when it refused: no launch record or later request may carry it.
const HOST_DIAGNOSTIC = 'Service tier ultrafast is unavailable for account acct-private'

const PUBLISHED: RuntimeMobileSessionTabsResult = {
  worktree: WORKTREE_ID,
  publicationEpoch: 'epoch-1',
  snapshotVersion: 1,
  activeGroupId: null,
  activeTabId: null,
  activeTabType: null,
  tabs: [
    {
      type: 'agent-session',
      id: 'tab-1',
      title: 'Codex',
      sessionId: SESSION_ID,
      agent: 'codex',
      isActive: true
    }
  ]
}

function launchIntent(
  seedOptions?: Record<string, string>,
  host: 'local' | 'runtime:server-1' = 'local'
): StructuredAgentSessionLaunchIntent {
  return {
    worktreeId: WORKTREE_ID,
    executionHostId: host,
    target: host === 'local' ? { kind: 'local' } : SERVER_TARGET,
    sessionId: SESSION_ID,
    agent: 'codex',
    params: {
      envelope: {
        sessionId: SESSION_ID,
        clientOperationId: 'operation-1',
        expectedRuntimeFence: null,
        payloadFingerprint: 'fingerprint-1'
      },
      worktree: `id:${WORKTREE_ID}`,
      agent: 'codex'
    },
    ...(seedOptions ? { seedOptions } : {})
  }
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => (resolve = settle))
  return { promise, resolve }
}

async function settle(ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve()
  }
}

/** The pick's outcome if it has settled, else 'pending'. */
function peek<T>(promise: Promise<T>): Promise<T | 'pending'> {
  return Promise.race([promise, Promise.resolve('pending' as const)])
}

function optionAccepted(key: string, value: string, options: Record<string, string>) {
  return { ok: true, value: { key, value, options } }
}

function write(key: string, value: string, fence = 7) {
  return { method: 'agentSession.setOption', fence, key, value }
}

function mutations(): { method: string; fence?: unknown; key?: unknown; value?: unknown }[] {
  return mocks.call.mock.calls
    .filter(([, method]) => method === 'agentSession.setOption' || method === 'agentSession.send')
    .map(([, method, params]) =>
      method === 'agentSession.setOption'
        ? {
            method,
            fence: params.envelope?.expectedRuntimeFence,
            key: params.key,
            value: params.value
          }
        : { method }
    )
}

function sentTurns() {
  return mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.send')
}

function createCalls() {
  return mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.create')
}

function lifecycle() {
  return getStructuredAgentSessionLaunchLifecycle(WORKTREE_ID, SESSION_ID)
}

function hold(id: string, value: string): Promise<StructuredLaunchOptionOutcome> {
  const pick = holdStructuredAgentSessionLaunchOption(SESSION_ID, id, value)
  if (!pick) {
    throw new Error('the launch is not holding picks')
  }
  return pick
}

function startLaunch(requestId: string) {
  return startStructuredAgentLaunch(WORKTREE_ID, 'codex', { requestId, prompt: FIRST_TURN })
}

function heldPicks() {
  return getStructuredAgentSessionLaunchSelection(SESSION_ID)?.held
}

/** The speed the launch would run or apply: a held pick over the seed. */
function requestedTier(selection: StructuredLaunchSelection | null): string | undefined {
  return { ...selection?.seed, ...selection?.held }.serviceTier
}

function trackLaunch(launch: ReturnType<typeof startStructuredAgentLaunch>) {
  const seen: { launch?: 'resolved' | 'rejected'; error?: unknown } = {}
  void launch.launchResult.then(
    () => {
      seen.launch = 'resolved'
    },
    (error: unknown) => {
      seen.launch = 'rejected'
      seen.error = error
    }
  )
  return seen
}

let hostSupport: Support
let historyFence: number | null
let setOptionReplies: Deferred<unknown>[]
let draftStorage: ReturnType<typeof createMemoryNativeChatComposerDraftStorage>
const reloadedStores: (typeof DraftStoreModule)[] = []
const releaseReloadedModules: (() => void)[] = []

describe('Codex speed admission while a chat launches', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset()
    }
    localStorage.clear()
    // The clear drops the storage override, so the memory storage goes in after it.
    clearNativeChatDraftCacheForTests()
    draftStorage = createMemoryNativeChatComposerDraftStorage()
    setNativeChatComposerDraftStorageForTests(draftStorage)
    resetStructuredAgentLaunchPersistenceForTests()
    resetStructuredAgentLaunchRegistryForTests()
    hostSupport = 'supported'
    historyFence = 7
    setOptionReplies = []
    mocks.createIntent.mockReturnValue(launchIntent(SEED))
    mocks.restoreIntent.mockReturnValue(launchIntent(SEED))
    mocks.speedSupport.mockImplementation(async () => hostSupport)
    mocks.refresh.mockResolvedValue([PUBLISHED])
    mocks.call.mockImplementation((_target, method) => {
      if (method === 'agentSession.setOption') {
        const reply = deferred<unknown>()
        setOptionReplies.push(reply)
        return reply.promise
      }
      if (method === 'agentSession.send') {
        return Promise.resolve({ ok: true, value: { submission: { dispatchState: 'accepted' } } })
      }
      if (method === 'agentSession.history') {
        return historyFence === null
          ? Promise.reject(new Error('history unavailable'))
          : Promise.resolve({ ok: true, page: { fence: historyFence } })
      }
      return new Promise(() => {})
    })
  })

  afterEach(() => {
    // A parked launch keeps staged text and a reserved send slot: release both in every module graph.
    for (const release of releaseReloadedModules.splice(0)) {
      release()
    }
    discardStructuredLaunchPrompts(SESSION_ID)
    resetStructuredAgentSessionSendsForTests()
    for (const store of reloadedStores.splice(0)) {
      store.clearNativeChatComposerDraftsForTests()
    }
  })

  describe('the last capability look before the launch publishes', () => {
    const SEEDED_FAST = { ...SEED, serviceTier: 'fast' }

    it('applies a speed picked meanwhile before the first turn goes, and settles once', async () => {
      mocks.createIntent.mockReturnValue(launchIntent(SEEDED_FAST))
      mocks.launch.mockResolvedValue({ sessionId: SESSION_ID, fence: 7 })
      const probe = deferred<Support>()
      mocks.speedSupport.mockReturnValueOnce(probe.promise)
      const launch = startLaunch('request-1')
      const seen = trackLaunch(launch)
      await settle()
      expect(mocks.speedSupport).toHaveBeenCalled()

      // Held while the final probe is in flight: the receipt must not be returned past it.
      const pick = hold('serviceTier', 'ultrafast')
      probe.resolve('supported')
      await settle()

      expect(mutations()).toEqual([write('serviceTier', 'ultrafast')])
      expect(sentTurns()).toHaveLength(0)
      expect(seen.launch).toBeUndefined()

      const accepted = { ...SEED, serviceTier: 'ultrafast' }
      setOptionReplies[0]!.resolve(optionAccepted('serviceTier', 'ultrafast', accepted))
      await expect(pick).resolves.toEqual({ kind: 'accepted', options: accepted })
      await expect(launch.promptDeliveryResult).resolves.toEqual(DELIVERED)

      expect(mutations()).toEqual([
        write('serviceTier', 'ultrafast'),
        { method: 'agentSession.send' }
      ])
      expect(sentTurns()).toHaveLength(1)
      expect(seen.launch).toBe('resolved')
    })

    it.each([
      ['without a speed picked meanwhile', false],
      ['with a speed picked meanwhile', true]
    ])(
      'ends a launch cancelled during the probe, %s, with no write and no turn',
      async (_name, picked) => {
        mocks.createIntent.mockReturnValue(launchIntent(SEEDED_FAST))
        mocks.launch.mockResolvedValue({ sessionId: SESSION_ID, fence: 7 })
        const probe = deferred<Support>()
        mocks.speedSupport.mockReturnValueOnce(probe.promise)
        const launch = startLaunch('request-2')
        const seen = trackLaunch(launch)
        await settle()
        if (picked) {
          void hold('serviceTier', 'ultrafast')
        }

        cancelStructuredAgentLaunch(WORKTREE_ID, SESSION_ID)
        probe.resolve('supported')
        await settle()

        expect(seen.launch).toBe('rejected')
        expect(seen.error).toBeInstanceOf(StructuredAgentSessionLaunchCancelledError)
        expect(mutations()).toEqual([])
      }
    )

    it('blocks a speed picked meanwhile when the final probe says the host cannot take it', async () => {
      mocks.createIntent.mockReturnValue(launchIntent(SEEDED_FAST))
      mocks.launch.mockResolvedValue({ sessionId: SESSION_ID, fence: 7 })
      const probe = deferred<Support>()
      mocks.speedSupport.mockReturnValueOnce(probe.promise)
      const launch = startLaunch('request-1b')
      await settle()
      const pick = hold('serviceTier', 'ultrafast')
      probe.resolve('unsupported')
      await settle()

      // The newest word on speed is the one blocked: nothing is written or sent past a host that cannot.
      expect(mutations()).toEqual([])
      expect(getStructuredAgentSessionLaunchSpeedBlock(WORKTREE_ID, SESSION_ID)).toEqual({
        tierId: 'ultrafast',
        reason: 'host-update-needed'
      })

      hostSupport = 'supported'
      expect(recheckStructuredAgentSessionLaunchSpeed(SESSION_ID)).toBe(true)
      await settle()
      expect(mutations()).toEqual([write('serviceTier', 'ultrafast')])
      const accepted = { ...SEED, serviceTier: 'ultrafast' }
      setOptionReplies[0]!.resolve(optionAccepted('serviceTier', 'ultrafast', accepted))
      await expect(pick).resolves.toEqual({ kind: 'accepted', options: accepted })
      await launch.promptDeliveryResult
      expect(sentTurns()).toHaveLength(1)
    })

    it('asks the host again before a speed picked over one still being written, and sends after it', async () => {
      mocks.launch.mockResolvedValue({ sessionId: SESSION_ID, fence: 7 })
      const launch = startLaunch('request-1c')
      const first = hold('serviceTier', 'fast')
      await settle()
      expect(mutations()).toEqual([write('serviceTier', 'fast')])

      const second = hold('serviceTier', 'ultrafast')
      expect(await peek(first)).toEqual({ kind: 'superseded' })
      // The host stops affirming service tiers while the first write is still in flight.
      hostSupport = 'unsupported'
      const firstAccepted = { ...SEED, serviceTier: 'fast' }
      setOptionReplies[0]!.resolve(optionAccepted('serviceTier', 'fast', firstAccepted))
      await settle()

      expect(mutations()).toEqual([write('serviceTier', 'fast')])
      expect(getStructuredAgentSessionLaunchSpeedBlock(WORKTREE_ID, SESSION_ID)).toEqual({
        tierId: 'ultrafast',
        reason: 'host-update-needed'
      })
      expect(sentTurns()).toHaveLength(0)

      hostSupport = 'supported'
      expect(recheckStructuredAgentSessionLaunchSpeed(SESSION_ID)).toBe(true)
      await settle()
      expect(mutations()).toEqual([write('serviceTier', 'fast'), write('serviceTier', 'ultrafast')])
      const accepted = { ...SEED, serviceTier: 'ultrafast' }
      setOptionReplies[1]!.resolve(optionAccepted('serviceTier', 'ultrafast', accepted))
      await expect(second).resolves.toEqual({ kind: 'accepted', options: accepted })
      await launch.promptDeliveryResult
      expect(sentTurns()).toHaveLength(1)
    })
  })

  describe('every canonical service tier needs a host that affirms them', () => {
    it.each([
      ['default', 'unknown', 'host-unreachable'],
      ['default', 'unsupported', 'host-update-needed'],
      ['turbo', 'unknown', 'host-unreachable'],
      ['turbo', 'unsupported', 'host-update-needed']
    ] as const)(
      'parks a %s seed on a host that is %s, with the turn unsent',
      async (tier, support, reason) => {
        mocks.createIntent.mockReturnValue(launchIntent({ ...SEED, serviceTier: tier }))
        mocks.launch.mockResolvedValue({ sessionId: SESSION_ID, fence: 7 })
        hostSupport = support
        startLaunch('request-3')
        await settle()

        expect(getStructuredAgentSessionLaunchSpeedBlock(WORKTREE_ID, SESSION_ID)).toEqual({
          tierId: tier,
          reason
        })
        expect(lifecycle()).toBe('pending')
        expect(sentTurns()).toHaveLength(0)
      }
    )

    // Standard and a custom speed, held on this machine and on a paired server, neither of which
    // may be asked to write one before it affirms service tiers.
    it.each([
      ['default', 'unknown', 'host-unreachable', 'local'],
      ['turbo', 'unsupported', 'host-update-needed', 'local'],
      ['default', 'unsupported', 'host-update-needed', 'runtime:server-1'],
      ['turbo', 'unknown', 'host-unreachable', 'runtime:server-1']
    ] as const)(
      'writes a held %s pick to a host that is %s only once it affirms it (%s, %s)',
      async (tier, support, reason, host) => {
        const target = host === 'local' ? { kind: 'local' } : SERVER_TARGET
        mocks.createIntent.mockReturnValue(launchIntent(SEED, host))
        mocks.launch.mockResolvedValue({ sessionId: SESSION_ID, fence: 7 })
        hostSupport = support
        const launch = startLaunch('request-4')
        const pick = hold('serviceTier', tier)
        await settle()

        expect(mocks.speedSupport).toHaveBeenCalledWith(target)
        expect(mutations()).toEqual([])
        expect(getStructuredAgentSessionLaunchSpeedBlock(WORKTREE_ID, SESSION_ID)).toEqual({
          tierId: tier,
          reason
        })
        expect(sentTurns()).toHaveLength(0)

        hostSupport = 'supported'
        expect(recheckStructuredAgentSessionLaunchSpeed(SESSION_ID)).toBe(true)
        await settle()
        expect(mutations()).toEqual([write('serviceTier', tier)])
        const writeCall = mocks.call.mock.calls.find(
          ([, method]) => method === 'agentSession.setOption'
        )
        expect(writeCall?.[0]).toEqual(target)
        const accepted = { ...SEED, serviceTier: tier }
        setOptionReplies[0]!.resolve(optionAccepted('serviceTier', tier, accepted))
        await expect(pick).resolves.toEqual({ kind: 'accepted', options: accepted })
        await expect(launch.promptDeliveryResult).resolves.toEqual(DELIVERED)
        expect(sentTurns()).toHaveLength(1)
      }
    )

    it('still writes the legacy Fast toggle to a host that cannot take service tiers, unasked', async () => {
      mocks.launch.mockResolvedValue({ sessionId: SESSION_ID, fence: 7 })
      hostSupport = 'unsupported'
      const launch = startLaunch('request-5')
      const pick = hold('fastMode', 'true')
      await settle()

      expect(mutations()).toEqual([write('fastMode', 'true')])
      const accepted = { ...SEED, fastMode: 'true' }
      setOptionReplies[0]!.resolve(optionAccepted('fastMode', 'true', accepted))
      await expect(pick).resolves.toEqual({ kind: 'accepted', options: accepted })
      await expect(launch.promptDeliveryResult).resolves.toEqual(DELIVERED)
      expect(mocks.speedSupport).not.toHaveBeenCalled()
    })
  })

  describe('the create seed on the host that will run the chat', () => {
    const HOSTS = [
      ['this machine', 'local'],
      ['a paired server', 'runtime:server-1']
    ] as const
    const REFUSALS = [
      ['unsupported', 'host-update-needed', StructuredAgentSessionSpeedHostUnsupportedError],
      ['unknown', 'host-unreachable', StructuredAgentSessionSpeedHostUnknownError]
    ] as const

    /** A host that admits the chat and, as a paired server does, reports the seed create will use. */
    function stageHost(hostSeed?: Record<string, string>): void {
      mocks.call.mockImplementation(async (_target, method) =>
        method === 'agentSession.createSupport'
          ? { supported: true, ...(hostSeed ? { seedOptions: hostSeed } : {}) }
          : { ok: true, replayed: false, value: { sessionId: SESSION_ID, fence: 1 } }
      )
    }

    async function createOn(host: 'local' | 'runtime:server-1', seed: Record<string, string>) {
      stageHost(host === 'local' ? undefined : seed)
      const actual = await vi.importActual<typeof LaunchIntentModule>(
        '@/lib/launch-structured-agent-session'
      )
      const intent = launchIntent(seed, host)
      return { intent, outcome: actual.launchStructuredAgentSession(intent) }
    }

    for (const [hostName, host] of HOSTS) {
      for (const tier of ['default', 'turbo']) {
        for (const [support, reason, RefusalError] of REFUSALS) {
          it(`refuses a ${tier} seed on ${hostName} that is ${support}, before any create`, async () => {
            hostSupport = support
            const { intent, outcome } = await createOn(host, {
              model: 'gpt-5.5',
              serviceTier: tier
            })
            const error = await outcome.catch((caught: unknown) => caught)

            expect(error).toBeInstanceOf(RefusalError)
            expect(error).toMatchObject({ block: { tierId: tier, reason } })
            expect(mocks.speedSupport).toHaveBeenCalledWith(intent.target)
            expect(createCalls()).toHaveLength(0)
            expect(mutations()).toEqual([])
          })
        }
      }

      it(`creates with a Standard seed on ${hostName} that affirms service tiers, after asking it`, async () => {
        const { intent, outcome } = await createOn(host, {
          model: 'gpt-5.5',
          serviceTier: 'default'
        })

        await expect(outcome).resolves.toMatchObject({ sessionId: SESSION_ID })
        expect(mocks.speedSupport).toHaveBeenCalledWith(intent.target)
        expect(createCalls()).toHaveLength(1)
      })

      it.each(['true', 'false'])(
        `creates with legacy fastMode=%s on ${hostName} that cannot take service tiers, unasked`,
        async (fastMode) => {
          hostSupport = 'unsupported'
          const { outcome } = await createOn(host, { model: 'gpt-5.5', fastMode })

          await expect(outcome).resolves.toMatchObject({ sessionId: SESSION_ID })
          expect(mocks.speedSupport).not.toHaveBeenCalled()
          expect(createCalls()).toHaveLength(1)
        }
      )
    }
  })

  describe('legacy Fast and canonical speed picks held together', () => {
    async function launchHoldingPicks() {
      const created = deferred<{ sessionId: string; fence: number }>()
      mocks.launch.mockReturnValue(created.promise)
      const launch = startLaunch('request-6')
      return { launch, created }
    }

    it('lets an explicit fastMode=false replace a refused canonical tier and deliver the turn', async () => {
      mocks.launch.mockResolvedValue({ sessionId: SESSION_ID, fence: 7 })
      const launch = startLaunch('request-7')
      const tierPick = hold('serviceTier', 'ultrafast')
      const refused = expect(tierPick).resolves.toMatchObject({ kind: 'refused' })
      await settle()
      setOptionReplies[0]!.resolve({
        ok: false,
        refusal: {
          code: 'agent_session_operation_invalid',
          message: 'Service tier ultrafast is unavailable'
        }
      })
      await refused
      await settle()
      expect(getStructuredAgentSessionLaunchSpeedBlock(WORKTREE_ID, SESSION_ID)).toMatchObject({
        tierId: 'ultrafast',
        reason: 'refused'
      })
      expect(sentTurns()).toHaveLength(0)

      const legacyPick = hold('fastMode', 'false')
      // The person's newest word on speed is the only one held: the refused tier does not outlive it.
      expect(heldPicks()).toEqual({ fastMode: 'false' })
      await settle()

      expect(mutations()).toEqual([write('serviceTier', 'ultrafast'), write('fastMode', 'false')])
      const accepted = { ...SEED, fastMode: 'false' }
      setOptionReplies[1]!.resolve(optionAccepted('fastMode', 'false', accepted))
      await expect(legacyPick).resolves.toEqual({ kind: 'accepted', options: accepted })
      await expect(launch.promptDeliveryResult).resolves.toEqual(DELIVERED)

      const sends = sentTurns()
      expect(sends).toHaveLength(1)
      expect(sends[0]?.[2]).toMatchObject({
        envelope: { sessionId: SESSION_ID, expectedRuntimeFence: 7 },
        body: { blocks: [{ type: 'text', text: FIRST_TURN }] }
      })
      expect(getStructuredAgentSessionLaunchSpeedBlock(WORKTREE_ID, SESSION_ID)).toBeNull()
      expect(lifecycle()).toBeNull()
      expect(hasStagedStructuredLaunchPrompt(SESSION_ID)).toBe(false)
      // No second copy of the text is left in the composer to be sent again.
      expect(readNativeChatDraftCache(structuredAgentSessionDraftScopeKey(SESSION_ID))).toBe('')
      expect(mocks.launch).toHaveBeenCalledTimes(1)
      expect(mocks.createIntent).toHaveBeenCalledTimes(1)
    })

    it.each([
      ['a canonical tier then fastMode', ['serviceTier', 'ultrafast'], ['fastMode', 'false']],
      ['fastMode then a canonical tier', ['fastMode', 'true'], ['serviceTier', 'ultrafast']]
    ] as const)('keeps only the later of %s, and sends only it', async (_name, first, second) => {
      const { launch, created } = await launchHoldingPicks()
      const earlier = hold(first[0], first[1])
      const later = hold(second[0], second[1])

      expect(heldPicks()).toEqual({ [second[0]]: second[1] })
      expect(await peek(earlier)).toEqual({ kind: 'superseded' })

      created.resolve({ sessionId: SESSION_ID, fence: 7 })
      await settle()
      expect(mutations()).toEqual([write(second[0], second[1])])
      const accepted = { ...SEED, [second[0]]: second[1] }
      setOptionReplies[0]!.resolve(optionAccepted(second[0], second[1], accepted))
      await expect(later).resolves.toEqual({ kind: 'accepted', options: accepted })
      await launch.promptDeliveryResult

      expect(mutations().map((mutation) => mutation.key)).toEqual([second[0], undefined])
    })

    it('keeps a held legacy Fast pick through a model pick while dropping other held picks', async () => {
      const { launch, created } = await launchHoldingPicks()
      const fast = hold('fastMode', 'true')
      const effort = hold('effort', 'high')
      const model = hold('model', 'gpt-picked')

      expect(heldPicks()).toEqual({ model: 'gpt-picked', fastMode: 'true' })
      expect(await peek(effort)).toEqual({ kind: 'superseded' })
      expect(await peek(fast)).toBe('pending')

      created.resolve({ sessionId: SESSION_ID, fence: 7 })
      await settle()
      expect(mutations()).toEqual([write('model', 'gpt-picked')])
      setOptionReplies[0]!.resolve(optionAccepted('model', 'gpt-picked', { model: 'gpt-picked' }))
      await expect(model).resolves.toEqual({ kind: 'accepted', options: { model: 'gpt-picked' } })
      await settle()
      expect(mutations()).toEqual([write('model', 'gpt-picked'), write('fastMode', 'true')])
      const accepted = { model: 'gpt-picked', fastMode: 'true' }
      setOptionReplies[1]!.resolve(optionAccepted('fastMode', 'true', accepted))
      await expect(fast).resolves.toEqual({ kind: 'accepted', options: accepted })
      await launch.promptDeliveryResult
    })
  })

  describe('a launch blocked after its picked speed was accepted, then the page reloads', () => {
    type Renderer = {
      launch: typeof LaunchModule
      options: typeof OptionsModule
      drafts: typeof DraftCacheModule
      publication: typeof PublicationModule
      speedBlock: () => ReturnType<typeof RegistryModule.getStructuredAgentSessionLaunchSpeedBlock>
      lifecycle: () => ReturnType<typeof RegistryModule.getStructuredAgentSessionLaunchLifecycle>
    }

    /** The host takes `fast`, then stops affirming service tiers before the launch can publish. */
    async function blockLaunchAfterAcceptedSpeed(): Promise<void> {
      mocks.launch.mockResolvedValue({ sessionId: SESSION_ID, fence: 7 })
      startLaunch('request-8')
      const pick = hold('serviceTier', 'fast')
      await settle()
      expect(mutations()).toEqual([write('serviceTier', 'fast')])

      hostSupport = 'unsupported'
      const accepted = { ...SEED, serviceTier: 'fast' }
      setOptionReplies[0]!.resolve(optionAccepted('serviceTier', 'fast', accepted))
      await expect(pick).resolves.toMatchObject({ kind: 'accepted' })
      await settle()
      expect(getStructuredAgentSessionLaunchSpeedBlock(WORKTREE_ID, SESSION_ID)).toEqual({
        tierId: 'fast',
        reason: 'host-update-needed'
      })
      expect(sentTurns()).toHaveLength(0)
      await nativeChatComposerDraftWritesSettled()
    }

    /** A fresh renderer: module memory is gone; local storage and the drafts' storage are not. The
     *  settings are read again, so `settingsSeed` is what they say now. */
    async function reloadRenderer(settingsSeed: Record<string, string> = SEED): Promise<Renderer> {
      window.dispatchEvent(new Event('pagehide'))
      await nativeChatComposerDraftWritesSettled()
      vi.resetModules()
      mocks.restoreIntent.mockReturnValue(launchIntent(settingsSeed))
      const storage = await import('@/components/native-chat/native-chat-composer-draft-storage')
      storage.setNativeChatComposerDraftStorageForTests(draftStorage)
      const store = await import('@/components/native-chat/native-chat-composer-draft-store')
      reloadedStores.push(store)
      await store.hydrateNativeChatComposerDrafts()
      const registry = await import('./structured-agent-session-launch-registry')
      const prompts = await import('./structured-agent-session-launch-prompt')
      const senders =
        await import('@/components/native-chat/structured-agent-session-message-sender')
      const persistence = await import('./structured-agent-session-launch-persistence')
      releaseReloadedModules.push(() => {
        prompts.discardStructuredLaunchPrompts(SESSION_ID)
        senders.resetStructuredAgentSessionSendsForTests()
        registry.resetStructuredAgentLaunchRegistryForTests()
        persistence.resetStructuredAgentLaunchPersistenceForTests()
      })
      return {
        launch: await import('./structured-agent-session-launch'),
        options: await import('./structured-agent-session-launch-options'),
        drafts: await import('@/components/native-chat/native-chat-draft-cache'),
        publication: await import('./structured-agent-session-launch-publication'),
        speedBlock: () =>
          registry.getStructuredAgentSessionLaunchSpeedBlock(WORKTREE_ID, SESSION_ID),
        lifecycle: () => registry.getStructuredAgentSessionLaunchLifecycle(WORKTREE_ID, SESSION_ID)
      }
    }

    it.each([
      ['no speed', SEED],
      ['Standard', { ...SEED, serviceTier: 'default' }],
      ['another custom speed', { ...SEED, serviceTier: 'turbo' }]
    ])(
      'keeps the accepted speed over settings now saved with %s, and publishes nothing',
      async (_name, settingsSeed) => {
        await blockLaunchAfterAcceptedSpeed()
        const renderer = await reloadRenderer(settingsSeed)
        const blocked = { tierId: 'fast', reason: 'host-update-needed' }

        expect(renderer.speedBlock()).toEqual(blocked)
        expect(renderer.launch.retryStructuredAgentSessionLaunch(WORKTREE_ID, SESSION_ID)).toBe(
          true
        )
        await settle(100)

        // The host still cannot affirm it: the previous seed must not stand in and publish.
        expect(renderer.speedBlock()).toEqual(blocked)
        expect(
          requestedTier(renderer.options.getStructuredAgentSessionLaunchSelection(SESSION_ID))
        ).toBe('fast')
        expect(renderer.lifecycle()).not.toBeNull()
        expect(sentTurns()).toHaveLength(0)

        hostSupport = 'supported'
        expect(renderer.options.recheckStructuredAgentSessionLaunchSpeed(SESSION_ID)).toBe(true)
        await settle(100)
        expect(renderer.lifecycle()).toBeNull()
        expect(mocks.launch).toHaveBeenCalledTimes(1)
        // Nothing but the accepted speed was ever requested of the host.
        expect(new Set(mutations().map((mutation) => mutation.value))).toEqual(new Set(['fast']))
        expect(sentTurns()).toHaveLength(0)
      },
      60_000
    )

    /** Retries the reloaded launch while the host's tab inventory and history cannot be read. */
    async function retryWithoutInventory(support: Support): Promise<Renderer> {
      await blockLaunchAfterAcceptedSpeed()
      const renderer = await reloadRenderer()
      mocks.refresh.mockRejectedValue(new Error('inventory unavailable'))
      historyFence = null
      hostSupport = support
      expect(renderer.launch.retryStructuredAgentSessionLaunch(WORKTREE_ID, SESSION_ID)).toBe(true)
      await settle(100)
      return renderer
    }

    // The saved receipt is the chat: with nothing readable it is neither created again nor left hanging.
    it('stays on its saved chat, still blocked, when the host cannot affirm the speed', async () => {
      const renderer = await retryWithoutInventory('unsupported')

      expect(renderer.speedBlock()).toEqual({ tierId: 'fast', reason: 'host-update-needed' })
      expect(renderer.lifecycle()).not.toBeNull()
      expect(mocks.launch).toHaveBeenCalledTimes(1)
      expect(sentTurns()).toHaveLength(0)
    }, 60_000)

    it('publishes on its saved chat, with no second create, when the host affirms the speed', async () => {
      const renderer = await retryWithoutInventory('supported')

      expect(renderer.lifecycle()).toBeNull()
      expect(renderer.speedBlock()).toBeNull()
      expect(mocks.launch).toHaveBeenCalledTimes(1)
      expect(mocks.createIntent).toHaveBeenCalledTimes(1)
      expect(mutations()).toEqual([write('serviceTier', 'fast')])
      expect(sentTurns()).toHaveLength(0)
    }, 60_000)

    it('applies a refused pick again to the same chat found by its inventory tab and history fence', async () => {
      mocks.launch.mockResolvedValue({ sessionId: SESSION_ID, fence: 7 })
      startLaunch('request-9')
      const refused = expect(hold('serviceTier', 'ultrafast')).resolves.toMatchObject({
        kind: 'refused'
      })
      await settle()
      setOptionReplies[0]!.resolve({
        ok: false,
        refusal: { code: 'agent_session_operation_invalid', message: HOST_DIAGNOSTIC }
      })
      await refused
      await settle()
      const renderer = await reloadRenderer()

      // What is saved names the speed and the chat, never the turn or what the host said.
      const stored = localStorage.getItem(LAUNCH_STORAGE_KEY) ?? ''
      expect(stored).toContain('ultrafast')
      expect(stored).not.toContain(FIRST_TURN)
      expect(stored).not.toContain(HOST_DIAGNOSTIC)
      expect(renderer.speedBlock()).toEqual({ tierId: 'ultrafast', reason: 'refused' })
      expect(renderer.lifecycle()).toBe('visibility-unknown')

      // Showing in the host's inventory does not settle a chat whose speed was refused.
      const { publication } = renderer
      publication.markStructuredAgentSessionLaunchesPublished(
        'local',
        publication.publishedStructuredSessions([PUBLISHED])
      )
      expect(renderer.lifecycle()).toBe('visibility-unknown')

      expect(renderer.launch.retryStructuredAgentSessionLaunch(WORKTREE_ID, SESSION_ID)).toBe(true)
      expect(
        requestedTier(renderer.options.getStructuredAgentSessionLaunchSelection(SESSION_ID))
      ).toBe('ultrafast')
      await settle(100)

      expect(mocks.launch).toHaveBeenCalledTimes(1)
      expect(mutations()).toEqual([
        write('serviceTier', 'ultrafast'),
        write('serviceTier', 'ultrafast')
      ])
      const accepted = { ...SEED, serviceTier: 'ultrafast' }
      setOptionReplies[1]!.resolve(optionAccepted('serviceTier', 'ultrafast', accepted))
      await settle(100)
      expect(renderer.lifecycle()).toBeNull()
      expect(localStorage.getItem(LAUNCH_STORAGE_KEY)).toBeNull()
      expect(JSON.stringify(mocks.call.mock.calls)).not.toContain(HOST_DIAGNOSTIC)
    }, 60_000)

    it('keeps the first turn in the composer across the reload and out of the launch record', async () => {
      await blockLaunchAfterAcceptedSpeed()
      const renderer = await reloadRenderer()
      const scope = structuredAgentSessionDraftScopeKey(SESSION_ID)

      expect(renderer.drafts.readNativeChatDraftCache(scope)).toBe(FIRST_TURN)
      const stored = localStorage.getItem(LAUNCH_STORAGE_KEY) ?? ''
      expect(stored).toContain('fast')
      expect(stored).not.toContain(FIRST_TURN)

      hostSupport = 'supported'
      expect(renderer.launch.retryStructuredAgentSessionLaunch(WORKTREE_ID, SESSION_ID)).toBe(true)
      await settle(100)

      // The composer owns the text now: the recovered launch publishes without sending it again.
      expect(renderer.lifecycle()).toBeNull()
      expect(sentTurns()).toHaveLength(0)
      expect(renderer.drafts.readNativeChatDraftCache(scope)).toBe(FIRST_TURN)
      expect(mocks.launch).toHaveBeenCalledTimes(1)
    }, 60_000)
  })
})
