// @vitest-environment happy-dom
import type * as LaunchIntentModule from './launch-structured-agent-session'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import type { StructuredAgentSessionLaunchIntent } from '@/lib/launch-structured-agent-session'
import type * as RecoveryModule from '@/lib/structured-agent-session-launch-recovery'

const mocks = vi.hoisted(() => ({
  abandonIntent: vi.fn(),
  callStructuredAgentSession: vi.fn(),
  launch: vi.fn(),
  restoreIntent: vi.fn(),
  retryIntent: vi.fn(),
  seedDraft: vi.fn(),
  clearDraft: vi.fn(),
  refresh: vi.fn(),
  runtimeCall: vi.fn()
}))

vi.mock('@/lib/launch-structured-agent-session', () => {
  class StructuredAgentSessionCreateRefusalError extends Error {}
  return {
    abandonStructuredAgentSessionLaunchIntent: mocks.abandonIntent,
    createStructuredAgentSessionLaunchIntent: vi.fn(),
    launchStructuredAgentSession: mocks.launch,
    restoreStructuredAgentSessionLaunchIntent: mocks.restoreIntent,
    retryStructuredAgentSessionLaunchIntent: mocks.retryIntent,
    StructuredAgentSessionCreateRefusalError
  }
})

vi.mock('@/lib/structured-agent-session-launch-recovery', async () => {
  const actual = await vi.importActual<typeof RecoveryModule>(
    '@/lib/structured-agent-session-launch-recovery'
  )
  return { ...actual, launchAndReconcile: vi.fn(actual.launchAndReconcile) }
})

vi.mock('@/runtime/local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionTabs: mocks.refresh
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.callStructuredAgentSession
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.runtimeCall
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      seedNativeChatLaunchDraft: mocks.seedDraft,
      clearNativeChatLaunchDraft: mocks.clearDraft
    })
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/lib/agent-catalog', () => ({
  getAgentLabel: (agent: string) => (agent === 'codex' ? 'Codex' : 'Claude')
}))

import { retryStructuredAgentSessionLaunch } from './structured-agent-session-launch'
import {
  readStructuredAgentLaunchRecord,
  resetStructuredAgentLaunchPersistenceForTests
} from './structured-agent-session-launch-persistence'
import {
  getStructuredLaunchStateBySessionId,
  notifyStructuredLaunchListeners,
  resetStructuredAgentLaunchRegistryForTests,
  setStructuredLaunchState,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'
import { createStructuredLaunchCallerGroup } from './structured-agent-session-launch-callers'
import { restorePersistedStructuredLaunchState } from './structured-agent-session-launch-reload'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache,
  writeNativeChatDraftCache
} from '@/components/native-chat/native-chat-draft-cache'
import {
  flushNativeChatComposerDrafts,
  hydrateNativeChatComposerDrafts,
  nativeChatComposerDraftWritesSettled,
  structuredAgentSessionDraftScopeKey
} from '@/components/native-chat/native-chat-composer-draft-store'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '@/components/native-chat/native-chat-composer-draft-storage'
import { SetOptionParams } from '../../../shared/rpc-contract/structured-agent-session-params'

function launchIntent(worktreeId: string, sessionId: string): StructuredAgentSessionLaunchIntent {
  return {
    worktreeId,
    executionHostId: 'local',
    target: { kind: 'local' },
    sessionId,
    agent: 'codex',
    params: {
      envelope: {
        sessionId,
        clientOperationId: 'operation-reloaded',
        expectedRuntimeFence: null,
        payloadFingerprint: 'fingerprint-reloaded'
      },
      worktree: `id:${worktreeId}`,
      agent: 'codex'
    }
  }
}

function publishedSnapshot(worktreeId: string, sessionId: string): RuntimeMobileSessionTabsResult {
  return {
    worktree: worktreeId,
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
        sessionId,
        agent: 'codex',
        isActive: true
      }
    ]
  }
}

async function flushLaunchSettlement(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve()
  }
}

describe('structured agent launch reload recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    resetStructuredAgentLaunchPersistenceForTests()
    resetStructuredAgentLaunchRegistryForTests()
    mocks.callStructuredAgentSession.mockResolvedValue({ ok: true, page: { fence: 4 } })
    mocks.restoreIntent.mockImplementation(
      (args: {
        worktreeId: string
        sessionId: string
        agent: 'claude' | 'codex'
        clientOperationId: string
        payloadFingerprint: string
        expectedRuntimeFence: number | null
      }) => ({
        ...launchIntent(args.worktreeId, args.sessionId),
        agent: args.agent,
        params: {
          ...launchIntent(args.worktreeId, args.sessionId).params,
          agent: args.agent,
          envelope: {
            sessionId: args.sessionId,
            clientOperationId: args.clientOperationId,
            payloadFingerprint: args.payloadFingerprint,
            expectedRuntimeFence: args.expectedRuntimeFence
          }
        }
      })
    )
  })

  it('retries a reload-interrupted launch with the persisted operation identity', async () => {
    const worktreeId = 'wt-reload'
    const sessionId = 'codex-reload-session'
    localStorage.setItem(
      'orca:structuredAgentLaunches:v1',
      JSON.stringify([
        {
          sessionId,
          agent: 'codex',
          lifecycle: 'pending',
          clientOperationId: 'operation-reloaded',
          payloadFingerprint: 'fingerprint-reloaded',
          expectedRuntimeFence: null
        }
      ])
    )
    mocks.launch.mockResolvedValueOnce({ sessionId, fence: 4 })
    mocks.refresh
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([publishedSnapshot(worktreeId, sessionId)])

    expect(retryStructuredAgentSessionLaunch(worktreeId, sessionId)).toBe(true)
    await flushLaunchSettlement()

    expect(mocks.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        worktreeId,
        params: expect.objectContaining({
          envelope: expect.objectContaining({
            clientOperationId: 'operation-reloaded',
            payloadFingerprint: 'fingerprint-reloaded'
          })
        })
      }),
      expect.any(Function),
      true
    )
  })

  it('persists a held speed and its model separately from the immutable create request', () => {
    const intent = launchIntent('wt-held-speed', 'codex-held-speed')
    intent.createPrepared = true
    intent.createMessageSupport = false
    intent.params.options = { model: 'model-original', serviceTier: 'default' }
    intent.createCanonicalOptions = { ...intent.params.options }
    const frozenParams = structuredClone(intent.params)
    const state: StructuredLaunchState = {
      identity: 'codex:wt-held-speed',
      intent,
      promptDelivery: 'auto-submit',
      callers: createStructuredLaunchCallerGroup({ kind: 'retry' }),
      promise: Promise.resolve({ sessionId: intent.sessionId, fence: 4 }),
      visibilityUnknown: true,
      cancelled: false,
      selection: { seed: intent.params.options, held: {} }
    }
    setStructuredLaunchState(state)
    state.selection = {
      ...state.selection,
      held: { model: 'model-held', serviceTier: 'tier-ultra-exact-request-id' }
    }
    notifyStructuredLaunchListeners()
    resetStructuredAgentLaunchPersistenceForTests()

    const persisted = readStructuredAgentLaunchRecord(intent.sessionId)
    expect(persisted).toMatchObject({
      sessionId: intent.sessionId,
      lifecycle: 'visibility-unknown',
      clientOperationId: frozenParams.envelope.clientOperationId,
      payloadFingerprint: frozenParams.envelope.payloadFingerprint,
      options: frozenParams.options,
      createCanonicalOptions: frozenParams.options,
      heldOptions: state.selection.held
    })
    expect(intent.params).toEqual(frozenParams)
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(mocks.callStructuredAgentSession).not.toHaveBeenCalled()
  })

  it('restores held speed intent without retrying or rewriting the original create authority', () => {
    const worktreeId = 'wt-held-speed-reload'
    const sessionId = 'codex-held-speed-reload'
    const heldOptions = { model: 'model-held', serviceTier: 'tier-ultra-exact-request-id' }
    const original = {
      sessionId,
      executionHostId: 'runtime:server-1',
      agent: 'codex',
      lifecycle: 'pending',
      clientOperationId: 'create-before-held-speed',
      payloadFingerprint: 'original-fingerprint-before-held-speed',
      expectedRuntimeFence: null,
      options: { model: 'model-original', fastMode: 'false' },
      createCanonicalOptions: { model: 'model-original', serviceTier: 'default' },
      createMessageSupport: false,
      createSpeedAuthority: {
        expectedEnvironmentPairingRevision: 7,
        expectedEnvironmentRuntimeId: 'original-runtime'
      },
      heldOptions
    }
    localStorage.setItem('orca:structuredAgentLaunches:v1', JSON.stringify([original]))

    const restored = restorePersistedStructuredLaunchState(worktreeId, sessionId)

    expect(restored?.selection.held).toEqual(heldOptions)
    expect(restored?.visibilityUnknown).toBe(true)
    expect(restored?.promptDelivery).toBe('draft')
    expect(mocks.restoreIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId,
        sessionId,
        executionHostId: original.executionHostId,
        clientOperationId: original.clientOperationId,
        payloadFingerprint: original.payloadFingerprint,
        expectedRuntimeFence: original.expectedRuntimeFence,
        options: original.options,
        createCanonicalOptions: original.createCanonicalOptions,
        createSpeedAuthority: original.createSpeedAuthority
      })
    )
    expect(mocks.retryIntent).not.toHaveBeenCalled()
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(mocks.callStructuredAgentSession).not.toHaveBeenCalled()
  })

  it('retains failed draft recovery across Retry and recovers the same conversation after storage returns', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_760_000_000_000)
    clearNativeChatDraftCacheForTests()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const storage = createMemoryNativeChatComposerDraftStorage()
    setNativeChatComposerDraftStorageForTests(storage)
    await hydrateNativeChatComposerDrafts()
    const worktreeId = 'wt-blocked-draft-reload'
    const sessionId = 'codex-blocked-draft-reload'
    const scope = structuredAgentSessionDraftScopeKey(sessionId)
    writeNativeChatDraftCache(scope, 'existing composer text')
    flushNativeChatComposerDrafts()
    await nativeChatComposerDraftWritesSettled()
    const original = {
      sessionId,
      executionHostId: 'runtime:server-1',
      agent: 'codex',
      lifecycle: 'visibility-unknown',
      clientOperationId: 'original-create-with-draft',
      payloadFingerprint: 'original-create-with-draft-fingerprint',
      expectedRuntimeFence: null,
      options: { model: 'model-original', fastMode: 'false' },
      createCanonicalOptions: { model: 'model-original', serviceTier: 'default' },
      createMessageSupport: false,
      createSpeedAuthority: {
        expectedEnvironmentPairingRevision: 7,
        expectedEnvironmentRuntimeId: 'original-runtime'
      },
      heldOptions: { model: 'model-held', serviceTier: 'tier-held-exact-id' },
      heldPromptDrafts: [
        { clientMessageId: 'original-legacy-reservation', text: 'held unsent text' }
      ]
    }
    localStorage.setItem('orca:structuredAgentLaunches:v1', JSON.stringify([original]))
    const actual = await vi.importActual<typeof LaunchIntentModule>(
      './launch-structured-agent-session'
    )
    mocks.restoreIntent.mockImplementation(actual.restoreStructuredAgentSessionLaunchIntent)
    storage.refuseWrites = true
    const refuseJournal = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Synthetic recovery storage refusal', 'QuotaExceededError')
    })
    try {
      const restored = restorePersistedStructuredLaunchState(worktreeId, sessionId)
      await nativeChatComposerDraftWritesSettled()
      expect(restored).toBeDefined()
      if (!restored) {
        throw new Error('Expected the blocked launch recovery state')
      }
      const frozenParams = structuredClone(restored.intent.params)

      expect(restored.heldPromptDrafts).toEqual(original.heldPromptDrafts)
      expect(restored.selection.held).toEqual(original.heldOptions)
      expect(restored.visibilityUnknown).toBe(true)
      expect(restored.promptDelivery).toBe('draft')
      expect(restored.intent.createSpeedAuthority).toEqual(original.createSpeedAuthority)
      expect(getStructuredLaunchStateBySessionId(sessionId)).toBe(restored)
      expect(readStructuredAgentLaunchRecord(sessionId)).toMatchObject(original)
      expect(mocks.runtimeCall).not.toHaveBeenCalled()
      expect(mocks.callStructuredAgentSession).not.toHaveBeenCalled()

      expect(retryStructuredAgentSessionLaunch(worktreeId, sessionId)).toBe(true)
      await expect(restored.promise).rejects.toThrow(/storage|recover/i)
      await nativeChatComposerDraftWritesSettled()
      expect(restored.visibilityUnknown).toBe(true)
      expect(readStructuredAgentLaunchRecord(sessionId)).toMatchObject(original)
      expect(mocks.retryIntent).not.toHaveBeenCalled()
      expect(mocks.launch).not.toHaveBeenCalled()
      expect(mocks.runtimeCall).not.toHaveBeenCalled()
      expect(mocks.callStructuredAgentSession).not.toHaveBeenCalled()

      refuseJournal.mockRestore()
      storage.refuseWrites = false
      mocks.runtimeCall.mockImplementation(async (_target, method) => {
        if (method === 'session.tabs.listAll') {
          return { snapshots: [publishedSnapshot(worktreeId, sessionId)] }
        }
        if (method === 'status.get') {
          return {
            runtimeId: 'original-runtime',
            capabilities: ['agent-session.codex-speed-selection.v1']
          }
        }
        throw new Error(`Unexpected recovery RPC: ${method}`)
      })
      mocks.callStructuredAgentSession.mockImplementation(async (_target, method, params) => {
        if (method === 'agentSession.history') {
          return { ok: true, page: { fence: 4 } }
        }
        if (method === 'agentSession.setOption') {
          const pick = SetOptionParams.parse(params)
          return { ok: true, value: { ...pick, options: { ...original.heldOptions } } }
        }
        throw new Error(`Unexpected recovery mutation: ${method}`)
      })

      expect(retryStructuredAgentSessionLaunch(worktreeId, sessionId)).toBe(true)
      await expect(restored.promise).resolves.toMatchObject({ sessionId, fence: 4 })
      await nativeChatComposerDraftWritesSettled()
      expect(restored.heldPromptDrafts).toBeUndefined()
      expect(restored.intent.params).toEqual(frozenParams)
      expect(restored.intent.createSpeedAuthority).toEqual(original.createSpeedAuthority)
      expect(readNativeChatDraftCache(scope)).toContain('existing composer text')
      expect(readNativeChatDraftCache(scope).split('held unsent text')).toHaveLength(2)
      expect(mocks.retryIntent).not.toHaveBeenCalled()
      expect(mocks.launch).not.toHaveBeenCalled()
      expect(mocks.callStructuredAgentSession.mock.calls.map(([, method]) => method)).toEqual([
        'agentSession.history',
        'agentSession.setOption',
        'agentSession.setOption'
      ])
    } finally {
      refuseJournal.mockRestore()
      warn.mockRestore()
      resetStructuredAgentLaunchRegistryForTests()
      clearNativeChatDraftCacheForTests()
      vi.useRealTimers()
    }
  })

  it('retains a published modern launch record while its next-turn speed is still held', () => {
    const intent = launchIntent('wt-modern-held', 'codex-modern-held')
    intent.createPrepared = true
    intent.createMessageSupport = true
    intent.params.options = { model: 'model-original', serviceTier: 'default' }
    const frozen = structuredClone(intent.params)
    const callers = createStructuredLaunchCallerGroup({ kind: 'retry' })
    callers.outcome = 'published'
    const heldOptions = { serviceTier: 'tier-modern-held-exact-id' }
    const state: StructuredLaunchState = {
      identity: 'codex:wt-modern-held',
      intent,
      callers,
      promptDelivery: 'auto-submit',
      promise: Promise.resolve({ sessionId: intent.sessionId, fence: 4 }),
      visibilityUnknown: false,
      cancelled: false,
      selection: { seed: intent.params.options, held: heldOptions }
    }

    setStructuredLaunchState(state)
    resetStructuredAgentLaunchPersistenceForTests()

    expect(readStructuredAgentLaunchRecord(intent.sessionId)).toMatchObject({
      sessionId: intent.sessionId,
      lifecycle: 'visibility-unknown',
      heldOptions,
      options: frozen.options,
      clientOperationId: frozen.envelope.clientOperationId,
      payloadFingerprint: frozen.envelope.payloadFingerprint
    })
    expect(intent.params).toEqual(frozen)
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(mocks.callStructuredAgentSession).not.toHaveBeenCalled()
  })

  it('shares pending backend recovery with Retry before retiring the source or contacting the host', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_760_000_000_000)
    clearNativeChatDraftCacheForTests()
    const storage = createMemoryNativeChatComposerDraftStorage()
    setNativeChatComposerDraftStorageForTests(storage)
    await hydrateNativeChatComposerDrafts()
    const worktreeId = 'wt-pending-backend-recovery'
    const sessionId = 'codex-pending-backend-recovery'
    const original = {
      sessionId,
      executionHostId: 'runtime:pending-host',
      agent: 'codex',
      lifecycle: 'visibility-unknown',
      clientOperationId: 'frozen-pending-create',
      payloadFingerprint: 'frozen-pending-fingerprint',
      expectedRuntimeFence: null,
      options: { model: 'model-original', fastMode: 'false' },
      createCanonicalOptions: { model: 'model-original', serviceTier: 'default' },
      createMessageSupport: false,
      createSpeedAuthority: {
        expectedEnvironmentPairingRevision: 7,
        expectedEnvironmentRuntimeId: 'original-runtime'
      },
      heldOptions: { model: 'model-held', serviceTier: 'default' },
      heldPromptDrafts: [
        { clientMessageId: 'pending-backend-reservation', text: 'wait for durable recovery' }
      ]
    }
    localStorage.setItem('orca:structuredAgentLaunches:v1', JSON.stringify([original]))
    const actual = await vi.importActual<typeof LaunchIntentModule>(
      './launch-structured-agent-session'
    )
    mocks.restoreIntent.mockImplementation(actual.restoreStructuredAgentSessionLaunchIntent)
    const updateStarted = Promise.withResolvers<void>()
    const commit = Promise.withResolvers<void>()
    const update = storage.update.bind(storage)
    let updates = 0
    storage.update = async (scope, apply) => {
      updates += 1
      updateStarted.resolve()
      await commit.promise
      await update(scope, apply)
    }
    mocks.runtimeCall.mockImplementation(async (_target, method) => {
      if (method === 'session.tabs.listAll') {
        return { snapshots: [publishedSnapshot(worktreeId, sessionId)] }
      }
      if (method === 'status.get') {
        return {
          runtimeId: 'original-runtime',
          capabilities: ['agent-session.codex-speed-selection.v1']
        }
      }
      throw new Error(`Unexpected pending-recovery RPC: ${method}`)
    })
    mocks.callStructuredAgentSession.mockImplementation(async (_target, method, params) => {
      if (method === 'agentSession.history') {
        return { ok: true, page: { fence: 4 } }
      }
      if (method === 'agentSession.setOption') {
        return {
          ok: true,
          value: { ...SetOptionParams.parse(params), options: { ...original.heldOptions } }
        }
      }
      throw new Error(`Unexpected pending-recovery mutation: ${method}`)
    })
    let restored: StructuredLaunchState | undefined
    try {
      restored = restorePersistedStructuredLaunchState(worktreeId, sessionId)
      expect(restored).toBeDefined()
      if (!restored) {
        throw new Error('Expected registered launch while its draft commit is pending')
      }
      expect(retryStructuredAgentSessionLaunch(worktreeId, sessionId)).toBe(true)
      const started = await Promise.race([
        updateStarted.promise.then(() => 'update-started'),
        restored.promise.then(
          () => 'retry-completed',
          () => 'retry-rejected'
        )
      ])
      expect(started).toBe('update-started')
      expect(storage.drafts.size).toBe(0)
      expect(restored.heldPromptDrafts).toEqual(original.heldPromptDrafts)
      expect(readStructuredAgentLaunchRecord(sessionId)).toMatchObject(original)
      let retrySettled = false
      void restored.promise.then(
        () => {
          retrySettled = true
        },
        () => {
          retrySettled = true
        }
      )
      await flushLaunchSettlement()

      expect(retrySettled).toBe(false)
      expect(updates).toBe(1)
      expect(getStructuredLaunchStateBySessionId(sessionId)).toBe(restored)
      expect(restored.heldPromptDrafts).toEqual(original.heldPromptDrafts)
      expect(readStructuredAgentLaunchRecord(sessionId)).toMatchObject(original)
      expect(mocks.runtimeCall).not.toHaveBeenCalled()
      expect(mocks.callStructuredAgentSession).not.toHaveBeenCalled()
      expect(mocks.retryIntent).not.toHaveBeenCalled()
      expect(mocks.launch).not.toHaveBeenCalled()

      commit.resolve()
      await expect(restored.promise).resolves.toMatchObject({ sessionId, fence: 4 })
      expect(restored.heldPromptDrafts).toBeUndefined()
      expect(storage.drafts.get(structuredAgentSessionDraftScopeKey(sessionId))?.text).toBe(
        original.heldPromptDrafts[0].text
      )
      expect(restored.intent.params.envelope.clientOperationId).toBe(original.clientOperationId)
      expect(restored.intent.params.envelope.payloadFingerprint).toBe(original.payloadFingerprint)
      expect(restored.intent.createSpeedAuthority).toEqual(original.createSpeedAuthority)
      expect(mocks.callStructuredAgentSession.mock.calls.map(([, method]) => method)).toEqual([
        'agentSession.history',
        'agentSession.setOption',
        'agentSession.setOption'
      ])
      expect(mocks.launch).not.toHaveBeenCalled()
    } finally {
      commit.resolve()
      await nativeChatComposerDraftWritesSettled()
      await restored?.promise.catch(() => undefined)
      resetStructuredAgentLaunchRegistryForTests()
      clearNativeChatDraftCacheForTests()
      vi.useRealTimers()
    }
  })
})
