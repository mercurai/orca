// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/structured-agent-session-client', () => ({ callStructuredAgentSession: rpc }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))
vi.mock('@/store', () => ({ useAppStore: {
  getState: () => ({ settings: {}, unifiedTabsByWorktree: {} }),
  subscribe: () => () => {}
} }))

import { markStructuredAgentSessionLaunchPublished } from './structured-agent-session-launch-publication'
import { restorePersistedStructuredLaunchState } from './structured-agent-session-launch-reload'
import {
  readStructuredAgentLaunchRecord,
  resetStructuredAgentLaunchPersistenceForTests,
  writeStructuredAgentLaunchRecord,
  type StructuredAgentLaunchPersistedRecord
} from './structured-agent-session-launch-persistence'
import {
  getStructuredLaunchStateBySessionId,
  resetStructuredAgentLaunchRegistryForTests
} from './structured-agent-session-launch-registry'
import { clearNativeChatDraftCacheForTests } from '@/components/native-chat/native-chat-draft-cache'
import {
  hydrateNativeChatComposerDrafts,
  nativeChatComposerDraftWritesSettled
} from '@/components/native-chat/native-chat-composer-draft-store'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '@/components/native-chat/native-chat-composer-draft-storage'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionHistoryPage } from '../../../shared/agent-session-wire'
import { resetStructuredAgentSessionReadOwnersForTests } from '@/components/native-chat/structured-agent-session-read-owner'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_760_000_000_000)
  vi.clearAllMocks()
  localStorage.clear()
  resetStructuredAgentLaunchRegistryForTests()
  resetStructuredAgentLaunchPersistenceForTests()
  clearNativeChatDraftCacheForTests()
})
afterEach(() => {
  resetStructuredAgentLaunchRegistryForTests()
  resetStructuredAgentLaunchPersistenceForTests()
  clearNativeChatDraftCacheForTests()
  resetStructuredAgentSessionReadOwnersForTests()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('publication arriving before launch restoration', () => {
  it('keeps held intent and its frozen identity when draft recovery cannot become durable', async () => {
    const worktreeId = 'wt-publication-before-restore'
    const sessionId = 'codex-publication-before-restore'
    const original: StructuredAgentLaunchPersistedRecord = {
      sessionId,
      executionHostId: 'runtime:original-host',
      agent: 'codex',
      lifecycle: 'visibility-unknown',
      clientOperationId: 'original-create-operation',
      payloadFingerprint: 'original-create-fingerprint',
      expectedRuntimeFence: null,
      options: { model: 'model-original', fastMode: 'false' },
      createCanonicalOptions: { model: 'model-original', serviceTier: 'default' },
      createSpeedAuthority: {
        expectedEnvironmentPairingRevision: 7,
        expectedEnvironmentRuntimeId: 'original-runtime'
      },
      createMessageSupport: false,
      heldOptions: { model: 'model-held', serviceTier: 'tier-held-exact-id' },
      heldPromptDrafts: [{ clientMessageId: 'original-reservation', text: 'unsent held text' }]
    }
    writeStructuredAgentLaunchRecord(original)
    const storage = createMemoryNativeChatComposerDraftStorage()
    setNativeChatComposerDraftStorageForTests(storage)
    await hydrateNativeChatComposerDrafts()
    storage.refuseWrites = true
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const setItem = localStorage.setItem.bind(localStorage)
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'orca:nativeChatComposerDraftJournal:v1') {
        throw new DOMException('Synthetic recovery journal refusal', 'QuotaExceededError')
      }
      setItem(key, value)
    })
    expect(getStructuredLaunchStateBySessionId(sessionId)).toBeUndefined()

    markStructuredAgentSessionLaunchPublished(worktreeId, sessionId, original.executionHostId)

    expect(readStructuredAgentLaunchRecord(sessionId)).toMatchObject(original)
    const restored = getStructuredLaunchStateBySessionId(sessionId) ??
      restorePersistedStructuredLaunchState(worktreeId, sessionId)
    await nativeChatComposerDraftWritesSettled()
    expect(restored?.selection.held).toEqual(original.heldOptions)
    expect(restored?.heldPromptDrafts).toEqual(original.heldPromptDrafts)
    expect(restored?.visibilityUnknown).toBe(true)
    expect(restored?.promptDelivery).toBe('draft')
    expect(restored?.intent.params.envelope).toEqual({
      sessionId,
      clientOperationId: original.clientOperationId,
      payloadFingerprint: original.payloadFingerprint,
      expectedRuntimeFence: original.expectedRuntimeFence
    })
    expect(restored?.intent.createSpeedAuthority).toEqual(original.createSpeedAuthority)
    expect(readStructuredAgentLaunchRecord(sessionId)).toMatchObject(original)
    expect(rpc).not.toHaveBeenCalled()
  })

  it.each([true, false])('confirms a modern publication read-only with held speed when opening receipt present=%s', async (hasReceipt) => {
    const worktreeId = 'wt-modern-publication-held'
    const sessionId = 'codex-modern-publication-held'
    const original: StructuredAgentLaunchPersistedRecord = {
      sessionId, executionHostId: 'runtime:original-host', agent: 'codex', lifecycle: 'visibility-unknown',
      clientOperationId: 'lost-reply-create-operation', payloadFingerprint: 'lost-reply-create-fingerprint',
      expectedRuntimeFence: null, createMessageSupport: true,
      options: { model: 'model-original', serviceTier: 'default' },
      createCanonicalOptions: { model: 'model-original', serviceTier: 'default' },
      createSpeedAuthority: {
        expectedEnvironmentPairingRevision: 7, expectedEnvironmentRuntimeId: 'original-runtime'
      },
      firstMessage: {
        clientMessageId: 'immutable-opening-message',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'immutable opening text' }] }
      },
      heldOptions: { serviceTier: 'next-turn-exact-held-tier' }
    }
    const opening: AgentJournalSubmission = {
      clientMessageId: 'immutable-opening-message', fence: 7, payloadFingerprint: 'opening-fingerprint',
      dispatchState: 'accepted', handoverRecorded: true, providerItemId: null, reason: null,
      submittedAt: 1_760_000_000_000, resolvedAt: 1_760_000_000_000
    }
    const cursor = { epoch: 'modern-publication-epoch', sequence: hasReceipt ? 1 : 0 }
    const page: AgentSessionHistoryPage = {
      sessionId, epoch: cursor.epoch, fence: 7, direction: 'tail', items: [], removedItemIds: [],
      submissions: hasReceipt ? [opening] : [],
      window: { oldest: null, newest: null, nextCursor: cursor }, liveCursor: cursor,
      hasOlder: false, hasNewer: false, latestTurn: null
    }
    rpc.mockImplementation(async (_target, method) => {
      if (method === 'session.tabs.listAll') {
        return { snapshots: [{ worktree: worktreeId, tabs: [{ type: 'agent-session', sessionId }] }] }
      }
      if (method === 'agentSession.history') return { ok: true, page }
      throw new Error(`Publication must not issue a mutation: ${method}`)
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeStructuredAgentLaunchRecord(original)
    expect(getStructuredLaunchStateBySessionId(sessionId)).toBeUndefined()

    markStructuredAgentSessionLaunchPublished(worktreeId, sessionId, original.executionHostId)
    await vi.waitFor(() => expect(rpc.mock.calls.filter(([, method]) =>
      method === 'agentSession.history')).toHaveLength(1))
    const state = getStructuredLaunchStateBySessionId(sessionId)
    expect(state).toBeDefined()
    if (!state) throw new Error('Expected restored modern publication state')
    const outcome = await state.promise.then(() => 'confirmed', () => 'missing-receipt')

    expect(outcome).toBe(hasReceipt ? 'confirmed' : 'missing-receipt')
    expect(rpc.mock.calls.map(([, method]) => method)).toEqual([
      'session.tabs.listAll', 'agentSession.history'
    ])
    expect(state.selection.held).toEqual(original.heldOptions)
    expect(state.intent.params.firstMessage).toEqual(original.firstMessage)
    expect(readStructuredAgentLaunchRecord(sessionId)).toMatchObject(original)
  })
})
