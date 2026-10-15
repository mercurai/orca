// @vitest-environment happy-dom
// Codex speed at the launch boundary, for the three review findings of the final L review: the
// accepted speed and created chat surviving a reload before the last capability look, a recheck that
// arrives while a "supported" answer is in flight, and the staged first turn mirrored in the composer
// being given back twice. Real launch registry, launch storage, composer draft store and message
// sender; only the host (runtime RPC, capability probe, tab inventory) is faked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import type * as LaunchIntentModule from '@/lib/launch-structured-agent-session'
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

vi.mock('@/runtime/structured-session-tab-inventory', () => ({
  readStructuredSessionTabInventory: () => mocks.refresh()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  readStructuredAgentSessionCodexSpeedSupport: mocks.speedSupport
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
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache,
  writeNativeChatDraftCache
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
  reserveStructuredAgentSessionSend,
  resetStructuredAgentSessionSendsForTests,
  stopStructuredAgentSessionSends
} from '@/components/native-chat/structured-agent-session-message-sender'
import {
  getStructuredAgentSessionPendingSends,
  getStructuredAgentSessionSendNotice
} from '@/components/native-chat/structured-agent-session-pending-sends'
import { structuredAgentSessionStopControl } from '@/components/native-chat/structured-agent-session-stop-control'
import {
  cancelStructuredAgentLaunch,
  getStructuredAgentSessionLaunchLifecycle,
  startStructuredAgentLaunch
} from './structured-agent-session-launch'
import {
  holdStructuredAgentSessionLaunchOption,
  recheckStructuredAgentSessionLaunchSpeed,
  type StructuredLaunchOptionOutcome,
  type StructuredLaunchSelection
} from './structured-agent-session-launch-options'
import { StructuredAgentSessionLaunchCancelledError } from './structured-agent-session-launch-recovery'
import { resetStructuredAgentLaunchPersistenceForTests } from './structured-agent-session-launch-persistence'
import {
  discardStructuredLaunchPrompts,
  hasStagedStructuredLaunchPrompt,
  takeBackStructuredLaunchPrompts
} from './structured-agent-session-launch-prompt'
import {
  getPersistedStructuredAgentLaunchRecord,
  getStructuredAgentSessionLaunchSpeedBlock,
  resetStructuredAgentLaunchRegistryForTests
} from './structured-agent-session-launch-registry'

const WORKTREE_ID = 'wt-1'
const SESSION_ID = 'session-1'
const LAUNCH_STORAGE_KEY = 'orca:structuredAgentLaunches:v1'
const FIRST_TURN = 'first turn'
const TYPED_DRAFT = `${FIRST_TURN}, and a correction`
const EARLIER_MESSAGE = 'an earlier message still being sent'
const SEED = { model: 'gpt-seeded' }
const SEEDED_FAST = { ...SEED, serviceTier: 'fast' }
const REPLACED_DEFAULTS = { ...SEED, serviceTier: 'turbo' }
const DELIVERED = { delivered: true, failureNotified: false }
const BLOCKED_FAST = { tierId: 'fast', reason: 'host-update-needed' }
const IN_COMPOSER = { delivered: false, failureNotified: false, inComposer: true } as const

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

function launchIntent(seedOptions: Record<string, string>): StructuredAgentSessionLaunchIntent {
  return {
    worktreeId: WORKTREE_ID,
    executionHostId: 'local',
    target: { kind: 'local' },
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
    seedOptions
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

/** Every request that reached the host, in order. */
function requestedMethods(): string[] {
  return mocks.call.mock.calls.map(([, method]) => method)
}

function sentTurns() {
  return mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.send')
}

function lifecycle() {
  return getStructuredAgentSessionLaunchLifecycle(WORKTREE_ID, SESSION_ID)
}

function speedBlock() {
  return getStructuredAgentSessionLaunchSpeedBlock(WORKTREE_ID, SESSION_ID)
}

function composer(): string {
  return readNativeChatDraftCache(structuredAgentSessionDraftScopeKey(SESSION_ID))
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
let setOptionReplies: Deferred<unknown>[]
let sendAnswer: () => Promise<unknown>
let draftStorage: ReturnType<typeof createMemoryNativeChatComposerDraftStorage>
/** The next capability answers, in the order they are asked; none left answers from `hostSupport`. */
const probeQueue: Deferred<Support>[] = []
const everyProbe: Deferred<Support>[] = []
const reloadedStores: (typeof DraftStoreModule)[] = []
const releaseReloadedModules: (() => void)[] = []

/** A capability answer held until the test resolves it; it answers nothing until queued. */
function newProbe(): Deferred<Support> {
  const probe = deferred<Support>()
  everyProbe.push(probe)
  return probe
}

/** A held answer taken by the next probe the launch makes. */
function queueProbe(): Deferred<Support> {
  const probe = newProbe()
  probeQueue.push(probe)
  return probe
}

function setOptionReply(index: number): Deferred<unknown> {
  const reply = setOptionReplies[index]
  if (!reply) {
    throw new Error(`no setOption request ${index} was made`)
  }
  return reply
}

type Renderer = {
  launch: typeof LaunchModule
  options: typeof OptionsModule
  publication: typeof PublicationModule
  registry: typeof RegistryModule
}

/** A fresh renderer: module memory is gone; local storage and the drafts' storage are not. The
 *  settings are read again, so `settingsSeed` is what they say now. */
async function reloadRenderer(settingsSeed: Record<string, string>): Promise<Renderer> {
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
  const senders = await import('@/components/native-chat/structured-agent-session-message-sender')
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
    publication: await import('./structured-agent-session-launch-publication'),
    registry
  }
}

describe('Codex speed at the launch boundary: review regressions', () => {
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
    setOptionReplies = []
    probeQueue.length = 0
    everyProbe.length = 0
    sendAnswer = () =>
      Promise.resolve({ ok: true, value: { submission: { dispatchState: 'accepted' } } })
    mocks.createIntent.mockReturnValue(launchIntent(SEED))
    mocks.restoreIntent.mockReturnValue(launchIntent(SEED))
    mocks.speedSupport.mockImplementation(async () => {
      const next = probeQueue.shift()
      return next ? next.promise : hostSupport
    })
    mocks.refresh.mockResolvedValue([PUBLISHED])
    mocks.call.mockImplementation((_target, method) => {
      if (method === 'agentSession.setOption') {
        const reply = deferred<unknown>()
        setOptionReplies.push(reply)
        return reply.promise
      }
      if (method === 'agentSession.send') {
        return sendAnswer()
      }
      if (method === 'agentSession.history') {
        return Promise.resolve({ ok: true, page: { fence: 7 } })
      }
      return new Promise(() => {})
    })
  })

  afterEach(async () => {
    // A launch still waiting on a probe ends parked, never publishing into the next test.
    for (const probe of everyProbe) {
      probe.resolve('unsupported')
    }
    await settle()
    for (const release of releaseReloadedModules.splice(0)) {
      release()
    }
    discardStructuredLaunchPrompts(SESSION_ID)
    resetStructuredAgentSessionSendsForTests()
    for (const store of reloadedStores.splice(0)) {
      store.clearNativeChatComposerDraftsForTests()
    }
  })

  describe('an accepted speed and its chat, reloaded before the last capability look', () => {
    it.each([
      ['a speed picked and accepted during the launch', 'picked'],
      ['a speed the create was seeded with', 'seeded']
    ] as const)(
      'recovers the same chat on %s, and settles it only once admitted',
      async (_name, how) => {
        mocks.launch.mockResolvedValue({ sessionId: SESSION_ID, fence: 7 })
        const finalProbe = newProbe()
        if (how === 'seeded') {
          mocks.createIntent.mockReturnValue(launchIntent(SEEDED_FAST))
          probeQueue.push(finalProbe)
          startLaunch('request-reload')
        } else {
          // The look before the write affirms the pick; the held one is the last look after its acceptance.
          startLaunch('request-reload')
          const pick = hold('serviceTier', 'fast')
          await settle()
          expect(mutations()).toEqual([write('serviceTier', 'fast')])
          probeQueue.push(finalProbe)
          setOptionReply(0).resolve(
            optionAccepted('serviceTier', 'fast', { ...SEED, serviceTier: 'fast' })
          )
          await expect(pick).resolves.toMatchObject({ kind: 'accepted' })
        }
        await settle()

        // The last look is in flight: the chat and the speed it runs must already be durable.
        expect(lifecycle()).toBe('pending')
        expect(sentTurns()).toHaveLength(0)
        expect(getPersistedStructuredAgentLaunchRecord(SESSION_ID)?.speed).toMatchObject({
          fence: 7,
          accepted: { serviceTier: 'fast' }
        })

        const renderer = await reloadRenderer(REPLACED_DEFAULTS)
        const { publication, registry } = renderer
        // Showing in the host's inventory does not admit a speed that was never confirmed after the reload.
        publication.markStructuredAgentSessionLaunchesPublished(
          'local',
          publication.publishedStructuredSessions([PUBLISHED])
        )
        expect(registry.getStructuredAgentSessionLaunchLifecycle(WORKTREE_ID, SESSION_ID)).toBe(
          'visibility-unknown'
        )
        expect(localStorage.getItem(LAUNCH_STORAGE_KEY)).not.toBeNull()

        hostSupport = 'unsupported'
        expect(renderer.launch.retryStructuredAgentSessionLaunch(WORKTREE_ID, SESSION_ID)).toBe(
          true
        )
        await settle(100)

        // The saved speed, not the settings now saved, is the one the host must affirm.
        expect(registry.getStructuredAgentSessionLaunchSpeedBlock(WORKTREE_ID, SESSION_ID)).toEqual(
          BLOCKED_FAST
        )
        expect(
          requestedTier(renderer.options.getStructuredAgentSessionLaunchSelection(SESSION_ID))
        ).toBe('fast')
        expect(mocks.launch).toHaveBeenCalledTimes(1)
        expect(mocks.createIntent).toHaveBeenCalledTimes(1)
        expect(sentTurns()).toHaveLength(0)

        hostSupport = 'supported'
        expect(renderer.options.recheckStructuredAgentSessionLaunchSpeed(SESSION_ID)).toBe(true)
        await settle(100)

        expect(
          registry.getStructuredAgentSessionLaunchLifecycle(WORKTREE_ID, SESSION_ID)
        ).toBeNull()
        expect(
          registry.getStructuredAgentSessionLaunchSpeedBlock(WORKTREE_ID, SESSION_ID)
        ).toBeNull()
        expect(localStorage.getItem(LAUNCH_STORAGE_KEY)).toBeNull()
        expect(mocks.launch).toHaveBeenCalledTimes(1)
        expect(mocks.createIntent).toHaveBeenCalledTimes(1)
        // Only the tier that was accepted was ever requested of the host, and it was not written again.
        expect(mutations()).toEqual(how === 'picked' ? [write('serviceTier', 'fast')] : [])
      },
      60_000
    )
  })

  describe('a recheck that arrives while a "supported" answer is in flight', () => {
    it('asks the host again before writing a held pick, and writes nothing past a "no"', async () => {
      mocks.launch.mockResolvedValue({ sessionId: SESSION_ID, fence: 7 })
      const stale = queueProbe()
      const fresh = queueProbe()
      const launch = startLaunch('request-recheck-1')
      const pick = hold('serviceTier', 'ultrafast')
      await settle()
      expect(mocks.speedSupport).toHaveBeenCalledTimes(1)

      expect(recheckStructuredAgentSessionLaunchSpeed(SESSION_ID)).toBe(true)
      stale.resolve('supported')
      await settle()

      // The answer in flight predates the recheck: the host is asked once more, and nothing is written.
      expect(mocks.speedSupport).toHaveBeenCalledTimes(2)
      expect(mutations()).toEqual([])
      expect(sentTurns()).toHaveLength(0)

      fresh.resolve('unsupported')
      await settle()
      expect(mutations()).toEqual([])
      expect(speedBlock()).toEqual({ tierId: 'ultrafast', reason: 'host-update-needed' })
      expect(sentTurns()).toHaveLength(0)

      hostSupport = 'supported'
      expect(recheckStructuredAgentSessionLaunchSpeed(SESSION_ID)).toBe(true)
      await settle()
      expect(mutations()).toEqual([write('serviceTier', 'ultrafast')])
      const accepted = { ...SEED, serviceTier: 'ultrafast' }
      setOptionReply(0).resolve(optionAccepted('serviceTier', 'ultrafast', accepted))
      await expect(pick).resolves.toEqual({ kind: 'accepted', options: accepted })
      await expect(launch.promptDeliveryResult).resolves.toEqual(DELIVERED)
      expect(mutations()).toEqual([
        write('serviceTier', 'ultrafast'),
        { method: 'agentSession.send' }
      ])
    })

    it('writes the held pick once, after a fresh "yes" to the recheck', async () => {
      mocks.launch.mockResolvedValue({ sessionId: SESSION_ID, fence: 7 })
      const stale = queueProbe()
      const fresh = queueProbe()
      const launch = startLaunch('request-recheck-2')
      const pick = hold('serviceTier', 'ultrafast')
      await settle()
      expect(recheckStructuredAgentSessionLaunchSpeed(SESSION_ID)).toBe(true)
      stale.resolve('supported')
      await settle()
      expect(mutations()).toEqual([])

      fresh.resolve('supported')
      await settle()
      expect(mocks.speedSupport).toHaveBeenCalledTimes(2)
      expect(mutations()).toEqual([write('serviceTier', 'ultrafast')])
      const accepted = { ...SEED, serviceTier: 'ultrafast' }
      setOptionReply(0).resolve(optionAccepted('serviceTier', 'ultrafast', accepted))
      await expect(pick).resolves.toEqual({ kind: 'accepted', options: accepted })
      await expect(launch.promptDeliveryResult).resolves.toEqual(DELIVERED)
      expect(sentTurns()).toHaveLength(1)
    })

    it('does not close picks or publish on the stale answer at the last look', async () => {
      mocks.createIntent.mockReturnValue(launchIntent(SEEDED_FAST))
      mocks.launch.mockResolvedValue({ sessionId: SESSION_ID, fence: 7 })
      const stale = queueProbe()
      const fresh = queueProbe()
      const launch = startLaunch('request-recheck-3')
      const seen = trackLaunch(launch)
      await settle()
      expect(recheckStructuredAgentSessionLaunchSpeed(SESSION_ID)).toBe(true)
      stale.resolve('supported')
      await settle()

      expect(mocks.speedSupport).toHaveBeenCalledTimes(2)
      expect(seen.launch).toBeUndefined()
      expect(sentTurns()).toHaveLength(0)

      fresh.resolve('unsupported')
      await settle()
      expect(speedBlock()).toEqual(BLOCKED_FAST)
      expect(seen.launch).toBeUndefined()
      expect(requestedMethods()).toEqual([])

      hostSupport = 'supported'
      expect(recheckStructuredAgentSessionLaunchSpeed(SESSION_ID)).toBe(true)
      await expect(launch.promptDeliveryResult).resolves.toEqual(DELIVERED)
      expect(seen.launch).toBe('resolved')
      expect(sentTurns()).toHaveLength(1)
    })

    it('ends a launch cancelled after the recheck without a write, a turn or another look', async () => {
      mocks.launch.mockResolvedValue({ sessionId: SESSION_ID, fence: 7 })
      const stale = queueProbe()
      queueProbe()
      const launch = startLaunch('request-recheck-4')
      const seen = trackLaunch(launch)
      void hold('serviceTier', 'ultrafast')
      await settle()
      expect(recheckStructuredAgentSessionLaunchSpeed(SESSION_ID)).toBe(true)

      cancelStructuredAgentLaunch(WORKTREE_ID, SESSION_ID)
      stale.resolve('supported')
      await settle()

      expect(seen.launch).toBe('rejected')
      expect(seen.error).toBeInstanceOf(StructuredAgentSessionLaunchCancelledError)
      expect(mocks.speedSupport).toHaveBeenCalledTimes(1)
      expect(requestedMethods()).toEqual([])
    })
  })

  describe('the first turn mirrored in the composer while its launch is parked on its speed', () => {
    const DRAFTS = [
      ['with nothing typed meanwhile', false, FIRST_TURN],
      ['with text typed after the copy meanwhile', true, TYPED_DRAFT]
    ] as const

    /** Parks a launch on a host that cannot take its seeded speed, so the turn is mirrored in the
     *  composer, then types after the copy as a person would. `earlierSend` leaves the chat's one
     *  send slot taken, so the launch's own turn cannot reserve it. */
    async function parkLaunch(typed: boolean, earlierSend = false) {
      mocks.createIntent.mockReturnValue(launchIntent(SEEDED_FAST))
      mocks.launch.mockResolvedValue({ sessionId: SESSION_ID, fence: 7 })
      hostSupport = 'unsupported'
      if (earlierSend) {
        reserveStructuredAgentSessionSend({ sessionId: SESSION_ID, text: EARLIER_MESSAGE })
      }
      const launch = startLaunch('request-parked')
      await settle()
      expect(speedBlock()).toEqual(BLOCKED_FAST)
      expect(composer()).toBe(FIRST_TURN)
      expect(requestedMethods()).toEqual([])
      if (typed) {
        writeNativeChatDraftCache(structuredAgentSessionDraftScopeKey(SESSION_ID), TYPED_DRAFT)
      }
      return launch
    }

    async function resumeOnSupportingHost(): Promise<void> {
      hostSupport = 'supported'
      expect(recheckStructuredAgentSessionLaunchSpeed(SESSION_ID)).toBe(true)
      await settle()
    }

    function unpublishedStop() {
      return structuredAgentSessionStopControl({
        published: false,
        host: { stopsConversation: true, stop: async () => null },
        transportState: { turnId: null, isWorking: false },
        sends: {
          sending: getStructuredAgentSessionPendingSends(SESSION_ID).some(
            (entry) => entry.phase === 'sending'
          ),
          stopSends: () => stopStructuredAgentSessionSends(SESSION_ID),
          takeBackLaunchText: () => takeBackStructuredLaunchPrompts(SESSION_ID)
        }
      })
    }

    /** The turn came back once, as the composer's own text, with the shared sender's words on the
     *  chat's line: one request, no second try, nothing left pending. */
    async function expectGivenBack(expected: string, says: string): Promise<void> {
      expect(getStructuredAgentSessionSendNotice(SESSION_ID) ?? '').toContain(says)
      await settle(100)
      expect(composer()).toBe(expected)
      expect(requestedMethods()).toEqual(['agentSession.send'])
      expect(hasStagedStructuredLaunchPrompt(SESSION_ID)).toBe(false)
      expect(getStructuredAgentSessionPendingSends(SESSION_ID)).toEqual([])
    }

    it.each(DRAFTS)(
      'a Stop gives the turn back once, %s, and the start publishes without sending it',
      async (_name, typed, expected) => {
        const launch = await parkLaunch(typed)
        const control = unpublishedStop()

        expect(control.canStop).toBe(true)
        await control.stop()

        expect(composer()).toBe(expected)
        expect(hasStagedStructuredLaunchPrompt(SESSION_ID)).toBe(false)
        await expect(launch.promptDeliveryResult).resolves.toEqual({
          delivered: false,
          failureNotified: true
        })

        await resumeOnSupportingHost()
        expect(lifecycle()).toBeNull()
        expect(composer()).toBe(expected)
        expect(requestedMethods()).toEqual([])
      }
    )

    it.each(DRAFTS)(
      'a cancelled launch leaves the mirrored turn as it is, %s, and sends nothing',
      async (_name, typed, expected) => {
        const launch = await parkLaunch(typed)

        cancelStructuredAgentLaunch(WORKTREE_ID, SESSION_ID)
        await settle()

        await expect(launch.promptDeliveryResult).resolves.toEqual({
          delivered: false,
          failureNotified: true
        })
        expect(composer()).toBe(expected)
        expect(hasStagedStructuredLaunchPrompt(SESSION_ID)).toBe(false)
        expect(requestedMethods()).toEqual([])
      }
    )

    it.each(DRAFTS)(
      'a host that refuses the resumed first send gives the turn back once, %s',
      async (_name, typed, expected) => {
        sendAnswer = () =>
          Promise.resolve({
            ok: false,
            refusal: { code: 'agent_session_operation_invalid', message: 'The turn was refused' }
          })
        const launch = await parkLaunch(typed)

        await resumeOnSupportingHost()

        await expect(launch.promptDeliveryResult).resolves.toEqual(IN_COMPOSER)
        await expectGivenBack(expected, 'Your message was not sent.')
      }
    )

    it.each(DRAFTS)(
      'a resumed first send nobody can confirm gives the turn back once, %s',
      async (_name, typed, expected) => {
        sendAnswer = () => Promise.reject(new Error('connection lost'))
        const launch = await parkLaunch(typed)

        await resumeOnSupportingHost()

        await expect(launch.promptDeliveryResult).resolves.toEqual({
          ...IN_COMPOSER,
          unconfirmed: true
        })
        await expectGivenBack(expected, "Orca couldn't confirm your message reached the agent")
      }
    )

    it.each(DRAFTS)(
      'a first send that finds the chat busy gives the turn back once, %s, and sends nothing',
      async (_name, typed, expected) => {
        const launch = await parkLaunch(typed, true)

        await resumeOnSupportingHost()

        await expect(launch.promptDeliveryResult).resolves.toEqual({ ...IN_COMPOSER, busy: true })
        expect(composer()).toBe(expected)
        expect(requestedMethods()).toEqual([])
        expect(hasStagedStructuredLaunchPrompt(SESSION_ID)).toBe(false)
      }
    )
  })

  describe('an accepted Fast-off pick whose acknowledgement carries a tier', () => {
    /** The pick is written on a host that would refuse any tier, so a tier the launch still runs
     *  afterwards shows as a last look that parks it. */
    async function acceptFastOff(acknowledged: Record<string, string>) {
      mocks.launch.mockResolvedValue({ sessionId: SESSION_ID, fence: 7 })
      hostSupport = 'unsupported'
      const launch = startLaunch('request-fast-off')
      const pick = hold('fastMode', 'false')
      await settle()
      expect(mutations()).toEqual([write('fastMode', 'false')])
      setOptionReply(0).resolve(optionAccepted('fastMode', 'false', acknowledged))
      await expect(pick).resolves.toMatchObject({ kind: 'accepted' })
      await settle()
      return launch
    }

    it('drops the saved tier an older host echoes beside the toggle, and delivers the turn', async () => {
      const launch = await acceptFastOff({ ...SEED, serviceTier: 'ultrafast', fastMode: 'false' })

      await expect(launch.promptDeliveryResult).resolves.toEqual(DELIVERED)
      expect(speedBlock()).toBeNull()
      expect(mocks.speedSupport).not.toHaveBeenCalled()
      expect(sentTurns()).toHaveLength(1)
    })

    it('keeps the exact tier an updated host answers for the toggle alone', async () => {
      await acceptFastOff({ ...SEED, serviceTier: 'standard-lane' })

      expect(speedBlock()).toEqual({ tierId: 'standard-lane', reason: 'host-update-needed' })
      expect(sentTurns()).toHaveLength(0)
    })
  })
})
