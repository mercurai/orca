// @vitest-environment happy-dom
import type * as LaunchIntentModule from '../../launch-structured-agent-session'

import type * as LaunchErrors from '@/lib/agent-session/launch/structured-agent-session-launch-errors'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/runtime-session-contracts'
import type { StructuredAgentSessionLaunchIntent } from '@/lib/launch-structured-agent-session'
import type * as RecoveryModule from '@/lib/agent-session/launch/structured-agent-session-launch-recovery'

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

const launchErrorMocks = vi.hoisted(() => {
  class StructuredAgentSessionCreateRefusalError extends Error {}
  return { StructuredAgentSessionCreateRefusalError }
})

vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-errors', async () => ({
  ...(await vi.importActual<typeof LaunchErrors>(
    '@/lib/agent-session/launch/structured-agent-session-launch-errors'
  )),
  ...launchErrorMocks
}))

vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-create-call', () => ({
  launchStructuredAgentSession: mocks.launch
}))

vi.mock('@/lib/launch-structured-agent-session', () => {
  return {
    abandonStructuredAgentSessionLaunchIntent: mocks.abandonIntent,
    createStructuredAgentSessionLaunchIntent: vi.fn(),
    launchStructuredAgentSession: mocks.launch,
    restoreStructuredAgentSessionLaunchIntent: mocks.restoreIntent,
    retryStructuredAgentSessionLaunchIntent: mocks.retryIntent,
    StructuredAgentSessionCreateRefusalError:
      launchErrorMocks.StructuredAgentSessionCreateRefusalError
  }
})

vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-recovery', async () => {
  const actual = await vi.importActual<typeof RecoveryModule>(
    '@/lib/agent-session/launch/structured-agent-session-launch-recovery'
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
import { registerStructuredSelectionCatalogStore } from '../../structured-agent-session-selection-controller'
import type { SelectionOutcome } from '../../../../../shared/structured-agent-session-selection-operations'
import {
  applyStructuredLaunchHeldOptions,
  getStructuredAgentSessionLaunchHeldOptions,
  holdStructuredAgentSessionLaunchOption,
  restoreStructuredLaunchHeldOptions,
  structuredLaunchSelectionController,
  structuredLaunchHeldOptions,
  structuredLaunchOptionOverlay
} from './structured-agent-session-launch-options'
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
import { SetOptionParams } from '../../../../../shared/rpc-contract/structured-agent-session-params'

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

function codexLaunchState(sessionId: string): StructuredLaunchState {
  const intent = launchIntent(`wt-${sessionId}`, sessionId)
  intent.createPrepared = true
  intent.createMessageSupport = false
  intent.params.options = { model: 'model-original', serviceTier: 'default' }
  intent.createCanonicalOptions = { ...intent.params.options }
  const state: StructuredLaunchState = {
    identity: `codex:wt-${sessionId}`,
    intent,
    promptDelivery: 'auto-submit',
    callers: createStructuredLaunchCallerGroup({ kind: 'retry' }),
    promise: Promise.resolve({ sessionId, fence: 4 }),
    visibilityUnknown: true,
    cancelled: false,
    selection: { seed: intent.params.options }
  }
  setStructuredLaunchState(state)
  return state
}

async function flushLaunchSettlement(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve()
  }
}

describe('structured agent launch reload recovery', () => {
  let restoreCatalogStore: (() => void) | undefined
  afterEach(() => {
    restoreCatalogStore?.()
  })
  beforeEach(() => {
    // A restored launch on a paired runtime acquires its selection owner against a hydrated catalog.
    restoreCatalogStore = registerStructuredSelectionCatalogStore({
      read: () => ({ runtimeEnvironmentCatalogHydrated: true }),
      subscribe: () => () => {}
    })
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
        explicitLaunchOptions?: Readonly<Record<string, string>>
        optionsMode?: 'replace-model-selection'
        options?: Readonly<Record<string, string>>
      }) => ({
        ...launchIntent(args.worktreeId, args.sessionId),
        agent: args.agent,
        explicitLaunchOptions: args.explicitLaunchOptions,
        params: {
          ...launchIntent(args.worktreeId, args.sessionId).params,
          agent: args.agent,
          optionsMode: args.optionsMode,
          options: args.options,
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
          explicitLaunchOptions: { model: 'action-model', fastMode: 'false' },
          optionsMode: 'replace-model-selection',
          options: { model: 'frozen-model', effort: 'high' },
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
    const restored = getStructuredLaunchStateBySessionId(sessionId)!
    expect(restored.selection).toMatchObject({
      explicit: { model: 'action-model', fastMode: 'false' }
    })
    expect(structuredLaunchOptionOverlay(restored)).toEqual({})
    await flushLaunchSettlement()

    expect(mocks.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        worktreeId,
        explicitLaunchOptions: { model: 'action-model', fastMode: 'false' },
        params: expect.objectContaining({
          optionsMode: 'replace-model-selection',
          options: { model: 'frozen-model', effort: 'high' },
          envelope: expect.objectContaining({
            clientOperationId: 'operation-reloaded',
            payloadFingerprint: 'fingerprint-reloaded'
          })
        })
      }),
      expect.any(Function),
      true,
      expect.any(Function)
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
      selection: { seed: intent.params.options }
    }
    setStructuredLaunchState(state)
    restoreStructuredLaunchHeldOptions(state, {
      model: 'model-held',
      serviceTier: 'tier-ultra-exact-request-id'
    })
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
      heldOptions: { model: 'model-held', serviceTier: 'tier-ultra-exact-request-id' }
    })
    expect(intent.params).toEqual(frozenParams)
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(mocks.callStructuredAgentSession).not.toHaveBeenCalled()
  })

  it('persists only the newer Standard pick over a transmitted older paid tier', () => {
    const intent = launchIntent('wt-speed-intent', 'codex-speed-intent')
    intent.createPrepared = true
    intent.createMessageSupport = false
    intent.params.options = { model: 'model-original', serviceTier: 'default' }
    intent.createCanonicalOptions = { ...intent.params.options }
    const state: StructuredLaunchState = {
      identity: 'codex:wt-speed-intent',
      intent,
      promptDelivery: 'auto-submit',
      callers: createStructuredLaunchCallerGroup({ kind: 'retry' }),
      promise: Promise.resolve({ sessionId: intent.sessionId, fence: 4 }),
      visibilityUnknown: true,
      cancelled: false,
      selection: { seed: intent.params.options }
    }
    setStructuredLaunchState(state)
    const controller = structuredLaunchSelectionController(state)
    const paid = controller.issue('serviceTier', 'tier-ultra-exact-request-id', 'model-original')
    // In flight and unanswered: a reload must not later send it over the newer pick.
    void controller.transmit(paid, () => new Promise(() => {}))
    void holdStructuredAgentSessionLaunchOption(intent.sessionId, 'fastMode', 'false')
    notifyStructuredLaunchListeners()
    resetStructuredAgentLaunchPersistenceForTests()

    expect(readStructuredAgentLaunchRecord(intent.sessionId)?.heldOptions).toEqual({
      fastMode: 'false'
    })
    expect(getStructuredAgentSessionLaunchHeldOptions(intent.sessionId)).toEqual({
      fastMode: 'false'
    })
    expect(mocks.callStructuredAgentSession).not.toHaveBeenCalled()
  })

  it('keeps a refused newer Standard over an older in-flight paid tier through reload', async () => {
    const launchState = (sessionId: string): StructuredLaunchState => {
      const intent = launchIntent(`wt-${sessionId}`, sessionId)
      intent.createPrepared = true
      intent.createMessageSupport = false
      intent.params.options = { model: 'model-original', serviceTier: 'default' }
      intent.createCanonicalOptions = { ...intent.params.options }
      const created: StructuredLaunchState = {
        identity: `codex:wt-${sessionId}`,
        intent,
        promptDelivery: 'auto-submit',
        callers: createStructuredLaunchCallerGroup({ kind: 'retry' }),
        promise: Promise.resolve({ sessionId, fence: 4 }),
        visibilityUnknown: true,
        cancelled: false,
        selection: { seed: intent.params.options }
      }
      setStructuredLaunchState(created)
      return created
    }
    const state = launchState('codex-speed-refused')
    const sessionId = state.intent.sessionId
    const receipt = { sessionId, fence: 4 } as Parameters<
      typeof applyStructuredLaunchHeldOptions
    >[1]
    await applyStructuredLaunchHeldOptions(state, receipt, false)
    const controller = structuredLaunchSelectionController(state)
    const paid = controller.issue('serviceTier', 'tier-ultra-exact-request-id', 'model-original')
    // The older paid request is on the wire and unanswered while Standard is picked and refused.
    const paidReply = Promise.withResolvers<SelectionOutcome>()
    void controller.transmit(paid, () => paidReply.promise)
    mocks.callStructuredAgentSession.mockResolvedValueOnce({
      ok: false,
      refusal: { code: 'structured_agent_session_unsupported', message: 'no' }
    })
    const standard = holdStructuredAgentSessionLaunchOption(sessionId, 'fastMode', 'false')
    await expect(standard).resolves.toMatchObject({ kind: 'refused' })
    notifyStructuredLaunchListeners()
    resetStructuredAgentLaunchPersistenceForTests()

    // The refused Standard is the newest intent: the in-flight paid tier is not serialized beside it.
    expect(getStructuredAgentSessionLaunchHeldOptions(sessionId)).toEqual({ fastMode: 'false' })
    expect(readStructuredAgentLaunchRecord(sessionId)?.heldOptions).toEqual({ fastMode: 'false' })

    // The delayed old reply settles its own request and cannot discard the retained Standard.
    paidReply.resolve({ kind: 'accepted', options: { serviceTier: 'tier-ultra-exact-request-id' } })
    await expect(paid.result).resolves.toMatchObject({ kind: 'accepted' })
    expect(getStructuredAgentSessionLaunchHeldOptions(sessionId)).toEqual({ fastMode: 'false' })

    // Reload restores the persisted record; only Standard is then sent, never the paid tier.
    const held = getStructuredAgentSessionLaunchHeldOptions(sessionId)
    mocks.callStructuredAgentSession.mockClear()
    mocks.callStructuredAgentSession.mockResolvedValue({
      ok: true,
      value: { options: { fastMode: 'false' } }
    })
    const reloaded = launchState('codex-speed-refused-reloaded')
    restoreStructuredLaunchHeldOptions(reloaded, held)
    await applyStructuredLaunchHeldOptions(reloaded, {
      ...receipt,
      sessionId: reloaded.intent.sessionId
    })
    const sent = mocks.callStructuredAgentSession.mock.calls
      .filter(([, method]) => method === 'agentSession.setOption')
      .map(([, , params]) => params)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ key: 'fastMode', value: 'false' })
    expect(JSON.stringify(sent)).not.toContain('tier-ultra-exact-request-id')
  })

  describe.each([
    { name: 'cross-key fastMode=false', key: 'fastMode', value: 'false' },
    { name: 'same-key serviceTier=default', key: 'serviceTier', value: 'default' }
  ])('a refused newer Standard ($name) over an older in-flight paid tier', (standard) => {
    const paidTier = 'tier-ultra-exact-request-id'
    const wireKey = (key: string, value: string): string => `${key}=${value}`
    // The real option sender, with host replies held open until a test answers them.
    async function refuseStandardBehindPaid() {
      const wire = new Map<string, PromiseWithResolvers<unknown>>()
      mocks.runtimeCall.mockImplementation(async (_target, method) => {
        if (method === 'status.get') {
          return { runtimeId: 'runtime', capabilities: ['agent-session.codex-speed-selection.v1'] }
        }
        throw new Error(`Unexpected RPC: ${method}`)
      })
      mocks.callStructuredAgentSession.mockImplementation(async (_target, method, params) => {
        if (method !== 'agentSession.setOption') {
          return { ok: true, page: { fence: 4 } }
        }
        const reply = Promise.withResolvers<unknown>()
        wire.set(wireKey(params.key, params.value), reply)
        return reply.promise
      })
      const state = codexLaunchState(`codex-${standard.key}-refused`)
      const sessionId = state.intent.sessionId
      const receipt = { sessionId, fence: 4 } as Parameters<
        typeof applyStructuredLaunchHeldOptions
      >[1]
      await applyStructuredLaunchHeldOptions(state, receipt, false)
      const paid = holdStructuredAgentSessionLaunchOption(sessionId, 'serviceTier', paidTier)!
      await vi.waitFor(() => expect(wire.has(wireKey('serviceTier', paidTier))).toBe(true))
      const newest = holdStructuredAgentSessionLaunchOption(
        sessionId,
        standard.key,
        standard.value
      )!
      await vi.waitFor(() => expect(wire.has(wireKey(standard.key, standard.value))).toBe(true))
      wire.get(wireKey(standard.key, standard.value))!.resolve({
        ok: false,
        refusal: { code: 'structured_agent_session_unsupported', message: 'no' }
      })
      await expect(newest).resolves.toMatchObject({ kind: 'refused' })
      return { state, sessionId, receipt, wire, paid }
    }
    function expectOnlyStandard(state: StructuredLaunchState): void {
      const expected = { [standard.key]: standard.value }
      const sessionId = state.intent.sessionId
      expect(getStructuredAgentSessionLaunchHeldOptions(sessionId)).toEqual(expected)
      expect(structuredLaunchOptionOverlay(state)).toEqual(expected)
      notifyStructuredLaunchListeners()
      resetStructuredAgentLaunchPersistenceForTests()
      expect(readStructuredAgentLaunchRecord(sessionId)?.heldOptions).toEqual(expected)
    }

    it.each([
      { late: 'accepted', reply: { ok: true, value: { options: { serviceTier: paidTier } } } },
      {
        late: 'refused',
        reply: {
          ok: false,
          refusal: { code: 'structured_agent_session_unsupported', message: 'late' }
        }
      }
    ])('keeps Standard when the older paid request is answered $late', async ({ late, reply }) => {
      const { state, sessionId, receipt, wire, paid } = await refuseStandardBehindPaid()
      expectOnlyStandard(state)

      wire.get(wireKey('serviceTier', paidTier))!.resolve(reply)
      await expect(paid).resolves.toMatchObject({ kind: late })
      expectOnlyStandard(state)

      // Reload restores the persisted record; only Standard is then sent, never the paid tier.
      const held = getStructuredAgentSessionLaunchHeldOptions(sessionId)
      mocks.callStructuredAgentSession.mockClear()
      mocks.callStructuredAgentSession.mockImplementation(async (_target, method, params) =>
        method === 'agentSession.setOption'
          ? { ok: true, value: { options: { [params.key]: params.value } } }
          : { ok: true, page: { fence: 4 } }
      )
      const reloaded = codexLaunchState(`codex-${standard.key}-${late}-reloaded`)
      restoreStructuredLaunchHeldOptions(reloaded, held)
      await applyStructuredLaunchHeldOptions(reloaded, {
        ...receipt,
        sessionId: reloaded.intent.sessionId
      })
      const sent = mocks.callStructuredAgentSession.mock.calls
        .filter(([, method]) => method === 'agentSession.setOption')
        .map(([, , params]) => params)
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({ key: standard.key, value: standard.value })
      expect(JSON.stringify(sent)).not.toContain(paidTier)
    })

    it('lets a newer in-memory pick win over the retained refusal before it is cleared', async () => {
      const { state, sessionId, wire } = await refuseStandardBehindPaid()
      const seen: Record<string, string>[] = []
      structuredLaunchSelectionController(state).subscribe(() => {
        seen.push(getStructuredAgentSessionLaunchHeldOptions(sessionId))
      })
      const newestKey = wireKey('serviceTier', 'tier-newest-exact-id')
      void holdStructuredAgentSessionLaunchOption(sessionId, 'serviceTier', 'tier-newest-exact-id')
      await vi.waitFor(() => expect(wire.has(newestKey)).toBe(true))

      // issue() notified before the retained refusal was cleared: the newer pick already won.
      expect(seen[0]).toEqual({ serviceTier: 'tier-newest-exact-id' })
      expect(getStructuredAgentSessionLaunchHeldOptions(sessionId)).toEqual({
        serviceTier: 'tier-newest-exact-id'
      })
      expect(structuredLaunchOptionOverlay(state)).toEqual({ serviceTier: 'tier-newest-exact-id' })
    })
  })

  it('restores a legacy record holding both speed keys with one winner', () => {
    const intent = launchIntent('wt-speed-legacy', 'codex-speed-legacy')
    const state: StructuredLaunchState = {
      identity: 'codex:wt-speed-legacy',
      intent,
      promptDelivery: 'auto-submit',
      callers: createStructuredLaunchCallerGroup({ kind: 'retry' }),
      promise: Promise.resolve({ sessionId: intent.sessionId, fence: 4 }),
      visibilityUnknown: true,
      cancelled: false,
      selection: {}
    }
    setStructuredLaunchState(state)
    restoreStructuredLaunchHeldOptions(state, {
      fastMode: 'false',
      serviceTier: 'tier-ultra-exact-request-id'
    })
    expect(getStructuredAgentSessionLaunchHeldOptions(intent.sessionId)).toEqual({
      serviceTier: 'tier-ultra-exact-request-id'
    })
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

    expect(getStructuredAgentSessionLaunchHeldOptions(sessionId)).toEqual(heldOptions)
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
      '../../launch-structured-agent-session'
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
      expect(structuredLaunchHeldOptions(restored)).toEqual(original.heldOptions)
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
      selection: { seed: intent.params.options }
    }
    restoreStructuredLaunchHeldOptions(state, heldOptions)

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
      '../../launch-structured-agent-session'
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
