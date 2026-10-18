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
})
