// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn())
const authorizeSpeed = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: rpc,
  supportsStructuredAgentSessionCreateMessage: async () => true
}))
vi.mock('@/runtime/codex-speed-selection', () => ({
  prepareCodexSpeedWireOptions: authorizeSpeed,
  CodexSpeedSelectionError: class extends Error {}
}))
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
import { holdStructuredAgentSessionLaunchOption } from './structured-agent-session-launch-options'
import { retryStructuredAgentSessionLaunch } from './structured-agent-session-launch'
import { CreateIntentParams } from '../../../shared/rpc-contract/structured-agent-session-params'
import { structuredAgentSessionCreateParams } from '../../../shared/structured-agent-session-create'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_760_000_000_000)
  vi.clearAllMocks()
  authorizeSpeed.mockReset()
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

  it('does not replay a missing opening receipt after speed is selected during the history read', async () => {
    const worktreeId = 'wt-publication-history-race'
    const sessionId = 'codex-publication-history-race'
    const original: StructuredAgentLaunchPersistedRecord = {
      sessionId, executionHostId: 'runtime:original-host', agent: 'codex', lifecycle: 'visibility-unknown',
      clientOperationId: 'history-race-create-operation', payloadFingerprint: 'history-race-create-fingerprint',
      expectedRuntimeFence: null, createMessageSupport: true,
      options: { model: 'model-original', serviceTier: 'default' },
      createCanonicalOptions: { model: 'model-original', serviceTier: 'default' },
      createSpeedAuthority: {
        expectedEnvironmentPairingRevision: 7, expectedEnvironmentRuntimeId: 'original-runtime'
      },
      firstMessage: {
        clientMessageId: 'history-race-opening',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'immutable opening' }] }
      }
    }
    const cursor = { epoch: 'history-race-epoch', sequence: 0 }
    const page: AgentSessionHistoryPage = {
      sessionId, epoch: cursor.epoch, fence: 7, direction: 'tail', items: [], removedItemIds: [],
      submissions: [], window: { oldest: null, newest: null, nextCursor: cursor }, liveCursor: cursor,
      hasOlder: false, hasNewer: false, latestTurn: null
    }
    const historyStarted = Promise.withResolvers<void>()
    const historyReply = Promise.withResolvers<{ ok: true; page: AgentSessionHistoryPage }>()
    rpc.mockImplementation(async (_target, method) => {
      if (method === 'session.tabs.listAll') {
        return { snapshots: [{ worktree: worktreeId, tabs: [{ type: 'agent-session', sessionId }] }] }
      }
      if (method === 'agentSession.history') {
        historyStarted.resolve()
        return historyReply.promise
      }
      throw new Error(`Publication must remain read-only after a concurrent speed pick: ${method}`)
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeStructuredAgentLaunchRecord(original)

    markStructuredAgentSessionLaunchPublished(worktreeId, sessionId, original.executionHostId)
    await historyStarted.promise
    const state = getStructuredLaunchStateBySessionId(sessionId)
    if (!state) throw new Error('Expected restored launch awaiting publication history')
    expect(state.selection.held).toEqual({})
    const outcome = state.promise.then(() => 'confirmed', () => 'unconfirmed')
    const heldOptions = { serviceTier: 'history-race-exact-held-tier' }
    expect(holdStructuredAgentSessionLaunchOption(sessionId, 'serviceTier', heldOptions.serviceTier))
      .not.toBeNull()
    expect(readStructuredAgentLaunchRecord(sessionId)?.heldOptions).toEqual(heldOptions)
    historyReply.resolve({ ok: true, page })

    expect(await outcome).toBe('unconfirmed')
    expect(rpc.mock.calls.map(([, method]) => method)).toEqual([
      'session.tabs.listAll', 'agentSession.history'
    ])
    expect(state.visibilityUnknown).toBe(true)
    expect(state.selection.held).toEqual(heldOptions)
    expect(state.intent.params.firstMessage).toEqual(original.firstMessage)
    expect(state.intent.createSpeedAuthority).toEqual(original.createSpeedAuthority)
    expect(readStructuredAgentLaunchRecord(sessionId)).toMatchObject({ ...original, heldOptions })
  })

  it('observes a missing opening receipt without held picks and replays only on explicit Retry', async () => {
    const worktreeId = 'wt-publication-explicit-retry'
    const sessionId = 'codex_publication_explicit_retry'
    const request = structuredAgentSessionCreateParams({
      sessionId, worktree: `id:${worktreeId}`, agent: 'codex',
      options: { model: 'model-original', serviceTier: 'default' },
      firstMessage: {
        clientMessageId: 'explicit-retry-original-opening',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'original explicit opening' }] }
      },
      randomUuid: () => '00000000-0000-4000-8000-000000000003', now: 1_760_000_000_000
    })
    const original: StructuredAgentLaunchPersistedRecord = {
      sessionId, executionHostId: 'runtime:original-host', agent: 'codex', lifecycle: 'visibility-unknown',
      clientOperationId: request.envelope.clientOperationId,
      payloadFingerprint: request.envelope.payloadFingerprint,
      expectedRuntimeFence: request.envelope.expectedRuntimeFence, createMessageSupport: true,
      options: request.options, createCanonicalOptions: request.options,
      createSpeedAuthority: {
        expectedEnvironmentPairingRevision: 7, expectedEnvironmentRuntimeId: 'original-runtime'
      },
      firstMessage: request.firstMessage
    }
    const opening: AgentJournalSubmission = {
      clientMessageId: 'explicit-retry-original-opening', fence: 7, payloadFingerprint: 'b'.repeat(64),
      dispatchState: 'accepted', handoverRecorded: true, providerItemId: null, reason: null,
      submittedAt: 1_760_000_000_000, resolvedAt: 1_760_000_000_000
    }
    const cursor = { epoch: 'explicit-retry-epoch', sequence: 0 }
    const missingPage: AgentSessionHistoryPage = {
      sessionId, epoch: cursor.epoch, fence: 7, direction: 'tail', items: [], removedItemIds: [],
      submissions: [], window: { oldest: null, newest: null, nextCursor: cursor }, liveCursor: cursor,
      hasOlder: false, hasNewer: false, latestTurn: null
    }
    const historyStarted = Promise.withResolvers<void>()
    let explicitRetry = false
    rpc.mockImplementation(async (_target, method) => {
      if (method === 'session.tabs.listAll') {
        return { snapshots: [{ worktree: worktreeId, tabs: [{ type: 'agent-session', sessionId }] }] }
      }
      if (method === 'agentSession.history') {
        historyStarted.resolve()
        return { ok: true, page: missingPage }
      }
      if (explicitRetry && method === 'agentSession.createSupport') return { supported: true }
      if (explicitRetry && method === 'agentSession.create') {
        return { ok: true, value: {
          sessionId, fence: 7, firstMessage: opening,
          page: { ...missingPage, submissions: [opening] }
        } }
      }
      throw new Error(`Mutation requires an explicit Retry: ${method}`)
    })
    authorizeSpeed.mockImplementation(async (input: { options?: Readonly<Record<string, string>> }) => ({
      options: input.options, authority: original.createSpeedAuthority
    }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeStructuredAgentLaunchRecord(original)

    markStructuredAgentSessionLaunchPublished(worktreeId, sessionId, original.executionHostId)
    await historyStarted.promise
    const state = getStructuredLaunchStateBySessionId(sessionId)
    if (!state) throw new Error('Expected publication to retain the unconfirmed launch')
    await expect(state.promise).rejects.toBeInstanceOf(Error)
    expect(rpc.mock.calls.map(([, method]) => method)).toEqual([
      'session.tabs.listAll', 'agentSession.history'
    ])
    expect(authorizeSpeed).not.toHaveBeenCalled()
    expect(state.visibilityUnknown).toBe(true)
    expect(state.selection.held).toEqual({})
    expect(readStructuredAgentLaunchRecord(sessionId)).toMatchObject(original)
    expect(state.intent.params).toEqual(request)
    const frozenParams = structuredClone(request)

    explicitRetry = true
    expect(retryStructuredAgentSessionLaunch(worktreeId, sessionId)).toBe(true)
    await expect(state.promise).resolves.toMatchObject({ sessionId, fence: 7, firstMessage: opening })

    expect(rpc.mock.calls.map(([, method]) => method)).toEqual([
      'session.tabs.listAll', 'agentSession.history',
      'session.tabs.listAll', 'agentSession.history', 'agentSession.createSupport', 'agentSession.create'
    ])
    const creates = rpc.mock.calls.filter(([, method]) => method === 'agentSession.create')
    expect(creates).toHaveLength(1)
    expect(CreateIntentParams.parse(creates[0]?.[2])).toEqual(frozenParams)
    expect(creates[0]?.[3]).toEqual(original.createSpeedAuthority)
    expect(state.intent.params.envelope.clientOperationId).toBe(original.clientOperationId)
    expect(state.intent.params.firstMessage).toEqual(original.firstMessage)
  })
})
