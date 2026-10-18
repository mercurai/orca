// @vitest-environment happy-dom

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
  refresh: vi.fn()
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
  notifyStructuredLaunchListeners,
  resetStructuredAgentLaunchRegistryForTests,
  setStructuredLaunchState,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'
import { createStructuredLaunchCallerGroup } from './structured-agent-session-launch-callers'
import { restorePersistedStructuredLaunchState } from './structured-agent-session-launch-reload'

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
    expect(mocks.restoreIntent).toHaveBeenCalledWith(expect.objectContaining({
      worktreeId,
      sessionId,
      executionHostId: original.executionHostId,
      clientOperationId: original.clientOperationId,
      payloadFingerprint: original.payloadFingerprint,
      expectedRuntimeFence: original.expectedRuntimeFence,
      options: original.options,
      createCanonicalOptions: original.createCanonicalOptions,
      createSpeedAuthority: original.createSpeedAuthority
    }))
    expect(mocks.retryIntent).not.toHaveBeenCalled()
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(mocks.callStructuredAgentSession).not.toHaveBeenCalled()
  })
})
