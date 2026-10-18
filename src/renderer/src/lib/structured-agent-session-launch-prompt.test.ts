// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.call,
  ensureRuntimeEnvironmentCompatible: vi.fn(async () => undefined)
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  // Sends reach the runtime RPC through this wrapper, as in the app.
  callStructuredAgentSession: (target: unknown, method: string, params?: unknown) =>
    mocks.call(target, method, params)
}))

import {
  resetStructuredAgentSessionSendsForTests,
  sendStructuredAgentSessionMessage,
  settleStructuredAgentSessionSendsFromJournal
} from '@/components/native-chat/structured-agent-session-message-sender'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache,
  writeNativeChatDraftCache
} from '@/components/native-chat/native-chat-draft-cache'
import {
  hydrateNativeChatComposerDrafts,
  nativeChatComposerDraftWritesSettled,
  structuredAgentSessionDraftScopeKey
} from '@/components/native-chat/native-chat-composer-draft-store'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '@/components/native-chat/native-chat-composer-draft-storage'
import * as LaunchPrompt from './structured-agent-session-launch-prompt'
import {
  getStructuredAgentSessionPendingSends,
  subscribeToStructuredAgentSessionPendingSends
} from '@/components/native-chat/structured-agent-session-pending-sends'
import {
  discardStructuredLaunchPrompts,
  hasStagedStructuredLaunchPrompt,
  settleStructuredAgentLaunchPrompt,
  stageStructuredLaunchPrompt,
  takeBackLegacyStructuredLaunchPrompts
} from './structured-agent-session-launch-prompt'
import {
  deleteStructuredAgentLaunchRecord,
  readStructuredAgentLaunchRecord,
  resetStructuredAgentLaunchPersistenceForTests,
  writeStructuredAgentLaunchRecord,
  type StructuredAgentLaunchPersistedRecord
} from './structured-agent-session-launch-persistence'
import { validRecord } from './structured-agent-session-launch-record'
import { structuredAgentSessionCreateParams } from '../../../shared/structured-agent-session-create'

const SESSION = 'session-1'
const target = { kind: 'local' } as const

function accepted(clientMessageId: string) {
  return {
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'epoch-1', sequence: 1 },
    value: {
      clientMessageId,
      submission: {
        clientMessageId,
        fence: 1,
        payloadFingerprint: 'fingerprint',
        dispatchState: 'accepted',
        providerItemId: null,
        reason: null,
        submittedAt: 1,
        resolvedAt: null
      }
    }
  }
}

function sends(): unknown[][] {
  return mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.send')
}

function pendingTexts(): string[] {
  return getStructuredAgentSessionPendingSends(SESSION).map(
    (entry) =>
      `${entry.body.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')}:${entry.phase}`
  )
}

function draft(): string {
  return readNativeChatDraftCache(structuredAgentSessionDraftScopeKey(SESSION))
}

function faultableLocalStorage(): Storage {
  const backing = localStorage
  // Happy DOM's Storage proxy cannot delete an instance method spy during restoration.
  const boundary: Storage = {
    get length() { return backing.length },
    clear: () => backing.clear(),
    key: (index) => backing.key(index),
    getItem: (key) => backing.getItem(key),
    setItem: (key, value) => backing.setItem(key, value),
    removeItem: (key) => backing.removeItem(key)
  }
  vi.stubGlobal('localStorage', boundary)
  return boundary
}

describe('settleStructuredAgentLaunchPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    resetStructuredAgentSessionSendsForTests()
    clearNativeChatDraftCacheForTests()
    discardStructuredLaunchPrompts(SESSION)
    mocks.call.mockImplementation(async (_target, _method, params) =>
      accepted(params.envelope.clientOperationId)
    )
  })

  it('sends the prompt once after the launch publishes, under its receipt fence', async () => {
    const stagedPrompt = stageStructuredLaunchPrompt(SESSION, 'review this')
    const onPromptDelivered = vi.fn()

    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.resolve({ sessionId: SESSION, fence: 7 }),
        target,
        options: { prompt: 'review this', onPromptDelivered },
        stagedPrompt
      })
    ).resolves.toEqual({ delivered: true, failureNotified: false })

    expect(onPromptDelivered).toHaveBeenCalledOnce()
    // The receipt's fence is known, so no history read precedes the send.
    expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual(['agentSession.send'])
    expect(sends()[0]?.[2]).toMatchObject({
      envelope: { sessionId: SESSION, expectedRuntimeFence: 7 },
      body: { blocks: [{ type: 'text', text: 'review this' }] }
    })
    expect(hasStagedStructuredLaunchPrompt(SESSION)).toBe(false)
  })

  it('shares one send between every caller waiting on the same staged prompt', async () => {
    const stagedPrompt = stageStructuredLaunchPrompt(SESSION, 'review this')
    const launchResult = Promise.resolve({ sessionId: SESSION, fence: 1 })
    const settle = () =>
      settleStructuredAgentLaunchPrompt({
        launchResult,
        target,
        options: { prompt: 'review this' },
        stagedPrompt
      })

    const results = await Promise.all([settle(), settle()])

    expect(results).toEqual([
      { delivered: true, failureNotified: false },
      { delivered: true, failureNotified: false }
    ])
    expect(sends()).toHaveLength(1)
  })

  it("puts the prompt in the chat's composer when the launch fails, and rethrows", async () => {
    const stagedPrompt = stageStructuredLaunchPrompt(SESSION, 'review this')
    const failure = new Error('create refused')

    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.reject(failure),
        target,
        options: { prompt: 'review this' },
        stagedPrompt
      })
    ).rejects.toBe(failure)

    expect(draft()).toBe('review this')
    expect(sends()).toHaveLength(0)
    expect(hasStagedStructuredLaunchPrompt(SESSION)).toBe(false)
  })

  it('neither sends nor gives back a prompt whose launch was cancelled', async () => {
    const stagedPrompt = stageStructuredLaunchPrompt(SESSION, 'review this')
    discardStructuredLaunchPrompts(SESSION)

    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.resolve({ sessionId: SESSION, fence: 1 }),
        target,
        options: { prompt: 'review this' },
        stagedPrompt
      })
    ).resolves.toEqual({ delivered: false, failureNotified: true })
    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.reject(new Error('cancelled')),
        target,
        options: { prompt: 'review this' },
        stagedPrompt
      })
    ).rejects.toThrow('cancelled')

    expect(sends()).toHaveLength(0)
    expect(draft()).toBe('')
  })

  it('gives a Stop before the chat is published its prompt back, and never sends it', async () => {
    const stagedPrompt = stageStructuredLaunchPrompt(SESSION, 'review this')
    let publish: (receipt: { sessionId: string; fence: number }) => void = () => {}
    const settled = settleStructuredAgentLaunchPrompt({
      launchResult: new Promise((resolve) => {
        publish = resolve
      }),
      target,
      options: { prompt: 'review this' },
      stagedPrompt
    })
    expect(pendingTexts()).toEqual(['review this:sending'])

    takeBackLegacyStructuredLaunchPrompts(SESSION)
    publish({ sessionId: SESSION, fence: 1 })

    await expect(settled).resolves.toEqual({ delivered: false, failureNotified: true })
    expect(draft()).toBe('review this')
    expect(pendingTexts()).toEqual([])
    expect(sends()).toHaveLength(0)
    expect(hasStagedStructuredLaunchPrompt(SESSION)).toBe(false)
  })

  it('reports a prompt the host refused as not delivered, with its text back in the composer', async () => {
    const stagedPrompt = stageStructuredLaunchPrompt(SESSION, 'review this')
    const onPromptDelivered = vi.fn()
    mocks.call.mockResolvedValue({
      ok: false,
      refusal: { code: 'agent_session_checkpoint_stale', message: 'stale' }
    })

    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.resolve({ sessionId: SESSION, fence: 1 }),
        target,
        options: { prompt: 'review this', onPromptDelivered },
        stagedPrompt
      })
    ).resolves.toEqual({ delivered: false, failureNotified: false, inComposer: true })

    expect(onPromptDelivered).not.toHaveBeenCalled()
    expect(draft()).toBe('review this')
  })

  // The launch prompt is the chat's first message: drawn as sending from the click, nothing typed
  // while the chat starts goes out ahead of it, and it goes out once the chat exists.
  it('holds the chat for its prompt from the click, then sends that prompt first, once', async () => {
    const stagedPrompt = stageStructuredLaunchPrompt(SESSION, 'review this')
    expect(pendingTexts()).toEqual(['review this:sending'])
    expect(
      sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'typed meanwhile' })
    ).toBeNull()
    expect(sends()).toHaveLength(0)

    let receive = (_receipt: { sessionId: string; fence: number }): void => {}
    const settled = settleStructuredAgentLaunchPrompt({
      launchResult: new Promise((resolve) => (receive = resolve)),
      target,
      options: { prompt: 'review this' },
      stagedPrompt
    })
    receive({ sessionId: SESSION, fence: 1 })
    await expect(settled).resolves.toEqual({ delivered: true, failureNotified: false })
    expect(sends()).toHaveLength(1)
    expect(JSON.stringify(sends()[0])).toContain('review this')
    expect(
      sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text: 'typed after' })
    ).not.toBeNull()
  })

  it('gives the chat back its send slot when the launch is cancelled, sending nothing', () => {
    stageStructuredLaunchPrompt(SESSION, 'review this')
    discardStructuredLaunchPrompts(SESSION)
    expect(pendingTexts()).toEqual([])
    expect(sends()).toHaveLength(0)
  })

  // Once sent, the prompt's entry is the sender's: what it keeps after settling stays.
  it('leaves in the chat a launch prompt the host recorded and a Stop then withdrew', async () => {
    const stagedPrompt = stageStructuredLaunchPrompt(SESSION, 'review this')
    mocks.call.mockImplementation(async (_target, _method, params) => {
      const answer = accepted(params.envelope.clientOperationId)
      answer.value.submission.dispatchState = 'pending'
      return answer
    })
    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.resolve({ sessionId: SESSION, fence: 1 }),
        target,
        options: { prompt: 'review this' },
        stagedPrompt
      })
    ).resolves.toEqual({ delivered: true, failureNotified: false })
    const promptId: string = mocks.call.mock.calls.find(
      ([, method]) => method === 'agentSession.send'
    )?.[2].envelope.clientOperationId

    settleStructuredAgentSessionSendsFromJournal(
      SESSION,
      [
        {
          clientMessageId: promptId,
          fence: 1,
          payloadFingerprint: 'fingerprint',
          dispatchState: 'rejected',
          providerItemId: null,
          reason: null,
          rejection: { kind: 'cancelled' },
          submittedAt: 1,
          resolvedAt: 2
        }
      ],
      []
    )
    // The host's row draws it, with its stop row; the composer is left alone.
    expect(draft()).toBe('')
    expect(pendingTexts()).toEqual([])
  })

  it("keeps an open chat drawing its launch prompt until the prompt's row arrives", async () => {
    const stop = subscribeToStructuredAgentSessionPendingSends(SESSION, () => {})
    const stagedPrompt = stageStructuredLaunchPrompt(SESSION, 'review this')
    await expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.resolve({ sessionId: SESSION, fence: 1 }),
        target,
        options: { prompt: 'review this' },
        stagedPrompt
      })
    ).resolves.toEqual({ delivered: true, failureNotified: false })
    expect(pendingTexts()).toEqual(['review this:recorded'])
    stop()
  })

  it('reports nothing for a draft, which the composer adopts instead', () => {
    expect(
      settleStructuredAgentLaunchPrompt({
        launchResult: Promise.resolve({ sessionId: SESSION, fence: 1 }),
        target,
        options: { prompt: 'review this', promptDelivery: 'draft' },
        stagedPrompt: null
      })
    ).toBeUndefined()
  })

  describe('held legacy prompt recovery', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(1_760_000_000_000)
    })
    afterEach(() => {
      discardStructuredLaunchPrompts(SESSION)
      resetStructuredAgentSessionSendsForTests()
      clearNativeChatDraftCacheForTests()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
      vi.useRealTimers()
    })

    // Optional lookup keeps the pre-implementation RED an assertion failure, not a missing-export error.
    const capture = () => {
      const implementation = 'captureStructuredLaunchPromptDrafts' in LaunchPrompt
        ? LaunchPrompt.captureStructuredLaunchPromptDrafts : undefined
      return typeof implementation === 'function' ? implementation(SESSION) : undefined
    }
    const recover = (drafts: readonly { clientMessageId: string; text: string }[]) => {
      const implementation = 'recoverStructuredLaunchPromptDrafts' in LaunchPrompt
        ? LaunchPrompt.recoverStructuredLaunchPromptDrafts : undefined
      return typeof implementation === 'function' ? implementation(SESSION, drafts) : undefined
    }

    it('captures only legacy text still owned by the launch', () => {
      const eligible = stageStructuredLaunchPrompt(SESSION, 'held legacy text')
      const pending = getStructuredAgentSessionPendingSends(SESSION)[0]
      stageStructuredLaunchPrompt(SESSION, 'text retained by notes', { callerKeepsText: true })
      const createOwned = stageStructuredLaunchPrompt(SESSION, 'frozen create-owned text')
      createOwned.createOwned = true

      expect(pending).toBeDefined()
      expect(capture()).toEqual([{ clientMessageId: pending?.clientMessageId, text: eligible.text }])
      expect(draft()).toBe('')
      expect(sends()).toEqual([])
    })

    it('recovers held text durably after an existing draft without automatically sending it', async () => {
      const storage = createMemoryNativeChatComposerDraftStorage()
      setNativeChatComposerDraftStorageForTests(storage)
      await hydrateNativeChatComposerDrafts()
      writeNativeChatDraftCache(structuredAgentSessionDraftScopeKey(SESSION), 'typed meanwhile')
      const held = [{ clientMessageId: 'legacy-before-reload', text: 'held legacy text' }]
      const original = structuredClone(held)

      expect(await recover(held)).toBe(true)
      await nativeChatComposerDraftWritesSettled()

      expect(draft()).toContain('typed meanwhile')
      expect(draft()).toContain('held legacy text')
      expect(draft().indexOf('typed meanwhile')).toBeLessThan(draft().indexOf('held legacy text'))
      expect(storage.drafts.get(structuredAgentSessionDraftScopeKey(SESSION))?.text).toBe(draft())
      expect(await recover(held)).toBe(true)
      expect(draft().split('held legacy text')).toHaveLength(2)
      expect(held).toEqual(original)
      expect(getStructuredAgentSessionPendingSends(SESSION)).toEqual([])
      expect(sends()).toEqual([])
    })

    it('refuses to consume recovery text when both draft storage and its journal refuse writes', async () => {
      const localStorageBoundary = faultableLocalStorage()
      const storage = createMemoryNativeChatComposerDraftStorage()
      setNativeChatComposerDraftStorageForTests(storage)
      await hydrateNativeChatComposerDrafts()
      storage.refuseWrites = true
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.spyOn(localStorageBoundary, 'setItem').mockImplementation(() => {
        throw new DOMException('Synthetic journal storage refusal', 'QuotaExceededError')
      })
      const held = [{ clientMessageId: 'retain-after-quota', text: 'recoverable held text' }]
      const original = structuredClone(held)

      expect(await recover(held)).toBe(false)
      await nativeChatComposerDraftWritesSettled()

      expect(held).toEqual(original)
      expect(storage.drafts.size).toBe(0)
      expect(getStructuredAgentSessionPendingSends(SESSION)).toEqual([])
      expect(sends()).toEqual([])
    })

    it('keeps the source when the draft backend refuses recovery despite journal availability', async () => {
      const storage = createMemoryNativeChatComposerDraftStorage()
      setNativeChatComposerDraftStorageForTests(storage)
      await hydrateNativeChatComposerDrafts()
      storage.refuseWrites = true
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const held = [{ clientMessageId: 'backend-refused-reservation', text: 'backend must confirm this' }]
      const original = structuredClone(held)

      expect(await recover(held)).toBe(false)
      await nativeChatComposerDraftWritesSettled()

      expect(held).toEqual(original)
      expect(storage.drafts.size).toBe(0)
      expect(getStructuredAgentSessionPendingSends(SESSION)).toEqual([])
      expect(sends()).toEqual([])
    })

    it('restores multiple held prompts as separate paragraphs', async () => {
      const storage = createMemoryNativeChatComposerDraftStorage()
      setNativeChatComposerDraftStorageForTests(storage)
      await hydrateNativeChatComposerDrafts()

      expect(await recover([
        { clientMessageId: 'first-held-reservation', text: 'first held prompt' },
        { clientMessageId: 'second-held-reservation', text: 'second held prompt' }
      ])).toBe(true)
      await nativeChatComposerDraftWritesSettled()

      expect(draft()).toBe(`first held prompt

second held prompt`)
      expect(storage.drafts.get(structuredAgentSessionDraftScopeKey(SESSION))?.text).toBe(draft())
      expect(sends()).toEqual([])
    })

    it('does not duplicate recovered text after source clearing fails and the user types before replay', async () => {
      const localStorageBoundary = faultableLocalStorage()
      const sourceKey = 'orca:structuredAgentLaunches:v1'
      const storage = createMemoryNativeChatComposerDraftStorage()
      setNativeChatComposerDraftStorageForTests(storage)
      await hydrateNativeChatComposerDrafts()
      const heldPromptDrafts = [{ clientMessageId: 'stable-legacy-reservation', text: 'recovered opening text' }]
      const request = structuredAgentSessionCreateParams({
        sessionId: SESSION, worktree: 'id:original-worktree', agent: 'codex',
        randomUuid: () => '00000000-0000-4000-8000-000000000004', now: 1_760_000_000_000
      })
      const source: StructuredAgentLaunchPersistedRecord = {
        sessionId: SESSION, executionHostId: 'local', agent: 'codex', lifecycle: 'visibility-unknown',
        clientOperationId: request.envelope.clientOperationId,
        payloadFingerprint: request.envelope.payloadFingerprint,
        expectedRuntimeFence: request.envelope.expectedRuntimeFence,
        createMessageSupport: false, heldPromptDrafts
      }
      expect(validRecord(source)).toBe(true)
      resetStructuredAgentLaunchPersistenceForTests()
      writeStructuredAgentLaunchRecord(source)
      const persistedSource = localStorageBoundary.getItem(sourceKey)
      expect(JSON.parse(persistedSource ?? 'null')).toEqual([source])
      resetStructuredAgentLaunchPersistenceForTests()
      expect(readStructuredAgentLaunchRecord(SESSION)).toEqual(source)
      expect(await recover(heldPromptDrafts)).toBe(true)
      await nativeChatComposerDraftWritesSettled()
      expect(localStorageBoundary.getItem(sourceKey)).toBe(persistedSource)
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const removeItem = localStorageBoundary.removeItem.bind(localStorageBoundary)
      const refuseSourceClear = vi.spyOn(localStorageBoundary, 'removeItem').mockImplementation((key) => {
        if (key === sourceKey) {
          throw new DOMException('Synthetic source-clear refusal', 'QuotaExceededError')
        }
        removeItem(key)
      })
      deleteStructuredAgentLaunchRecord(SESSION)
      expect(refuseSourceClear).toHaveBeenCalledWith(sourceKey)
      expect(warning).toHaveBeenCalledWith('[structured-agent-launch] could not persist launch state')
      expect(readStructuredAgentLaunchRecord(SESSION)).toBeUndefined()
      expect(localStorageBoundary.getItem(sourceKey)).toBe(persistedSource)
      resetStructuredAgentLaunchPersistenceForTests()
      const staleSource = readStructuredAgentLaunchRecord(SESSION)
      expect(staleSource?.heldPromptDrafts).toEqual(heldPromptDrafts)
      refuseSourceClear.mockRestore()

      // A fresh renderer must deduplicate by recovery identity, even after later draft edits.
      vi.resetModules()
      const reloadedStorage = await import('@/components/native-chat/native-chat-composer-draft-storage')
      reloadedStorage.setNativeChatComposerDraftStorageForTests(storage)
      const reloadedStore = await import('@/components/native-chat/native-chat-composer-draft-store')
      const reloadedCache = await import('@/components/native-chat/native-chat-draft-cache')
      const reloadedPrompt = await import('./structured-agent-session-launch-prompt')
      try {
        await reloadedStore.hydrateNativeChatComposerDrafts()
        const scope = structuredAgentSessionDraftScopeKey(SESSION)
        const edited = `${reloadedCache.readNativeChatDraftCache(scope)}\n\ntext typed after recovery`
        reloadedCache.writeNativeChatDraftCache(scope, edited)
        reloadedStore.flushNativeChatComposerDrafts()
        await reloadedStore.nativeChatComposerDraftWritesSettled()

        const implementation = 'recoverStructuredLaunchPromptDrafts' in reloadedPrompt
          ? reloadedPrompt.recoverStructuredLaunchPromptDrafts : undefined
        expect(typeof implementation === 'function'
          ? await implementation(SESSION, staleSource?.heldPromptDrafts ?? [])
          : undefined).toBe(true)
        await reloadedStore.nativeChatComposerDraftWritesSettled()

        expect(reloadedCache.readNativeChatDraftCache(scope)).toBe(edited)
        expect(reloadedCache.readNativeChatDraftCache(scope).split('recovered opening text')).toHaveLength(2)
        expect(storage.drafts.get(scope)?.text).toBe(edited)
        expect(sends()).toEqual([])
      } finally {
        reloadedStore.clearNativeChatComposerDraftsForTests()
        resetStructuredAgentLaunchPersistenceForTests()
      }
    })
  })
})
