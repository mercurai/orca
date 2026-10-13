// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import type { StructuredAgentSessionLaunchIntent } from '@/lib/launch-structured-agent-session'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'

type CallParams = {
  envelope?: { expectedRuntimeFence?: number | null }
  key?: string
  value?: string
}

const mocks = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params: CallParams) => Promise<unknown>>(),
  createIntent: vi.fn(),
  retryIntent: vi.fn(),
  launch: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn() } }))

vi.mock('@/lib/launch-structured-agent-session', () => {
  class StructuredAgentSessionCreateRefusalError extends Error {}
  return {
    createStructuredAgentSessionLaunchIntent: mocks.createIntent,
    retryStructuredAgentSessionLaunchIntent: mocks.retryIntent,
    restoreStructuredAgentSessionLaunchIntent: vi.fn(),
    abandonStructuredAgentSessionLaunchIntent: vi.fn(),
    launchStructuredAgentSession: mocks.launch,
    StructuredAgentSessionCreateRefusalError
  }
})

vi.mock('@/runtime/local-structured-session-tabs-sync', () => ({
  refreshLocalStructuredSessionTabs: vi.fn()
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
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

import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-agent-session'
import { refreshLocalStructuredSessionTabs } from '@/runtime/local-structured-session-tabs-sync'
import {
  cancelStructuredAgentLaunch,
  getStructuredAgentSessionLaunchLifecycle,
  retryStructuredAgentSessionLaunch,
  startStructuredAgentLaunch
} from './structured-agent-session-launch'
import {
  getStructuredAgentSessionLaunchSelection,
  holdStructuredAgentSessionLaunchOption
} from './structured-agent-session-launch-options'
import { resetStructuredAgentLaunchPersistenceForTests } from './structured-agent-session-launch-persistence'
import { hasStagedStructuredLaunchPrompt } from './structured-agent-session-launch-prompt'
import {
  resetStructuredAgentLaunchRegistryForTests,
  subscribeStructuredAgentLaunchStatus
} from './structured-agent-session-launch-registry'
import {
  markStructuredAgentSessionLaunchesPublished,
  markStructuredAgentSessionLaunchPublished,
  publishedStructuredSessions
} from './structured-agent-session-launch-publication'

const WORKTREE_ID = 'wt-1'
const SESSION_ID = 'session-1'

function launchIntent(seedOptions?: Record<string, string>): StructuredAgentSessionLaunchIntent {
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
    ...(seedOptions ? { seedOptions } : {})
  }
}

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

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => (resolve = settle))
  return { promise, resolve }
}

const ACCEPTED = { ok: true, value: { key: 'model', value: 'x' } }

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

function lifecycle() {
  return getStructuredAgentSessionLaunchLifecycle(WORKTREE_ID, SESSION_ID)
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }
}

describe('picks made while a chat launches', () => {
  let setOptionReplies: Deferred<unknown>[]

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    resetStructuredAgentLaunchPersistenceForTests()
    resetStructuredAgentLaunchRegistryForTests()
    setOptionReplies = []
    mocks.createIntent.mockReturnValue(launchIntent({ model: 'gpt-seeded' }))
    mocks.retryIntent.mockImplementation((intent: StructuredAgentSessionLaunchIntent) => ({
      ...intent,
      seedOptions: { model: 'gpt-saved-since' }
    }))
    vi.mocked(refreshLocalStructuredSessionTabs).mockResolvedValue([PUBLISHED])
    mocks.call.mockImplementation((_target, method) => {
      if (method === 'agentSession.setOption') {
        const reply = deferred<unknown>()
        setOptionReplies.push(reply)
        return reply.promise
      }
      if (method === 'agentSession.send') {
        return Promise.resolve({ ok: true, value: { submission: { dispatchState: 'accepted' } } })
      }
      return new Promise(() => {})
    })
  })

  it('applies them against the receipt fence before the first turn and before publishing', async () => {
    const created = deferred<{ sessionId: string; fence: number }>()
    mocks.launch.mockReturnValue(created.promise)
    const launch = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      requestId: 'request-1',
      prompt: 'first turn'
    })

    const modelPick = holdStructuredAgentSessionLaunchOption(SESSION_ID, 'model', 'gpt-picked')
    holdStructuredAgentSessionLaunchOption(SESSION_ID, 'effort', 'high')
    created.resolve({ sessionId: SESSION_ID, fence: 7 })
    await settle()

    // The host published the tab, but the launch is not published until its picks land.
    markStructuredAgentSessionLaunchPublished(WORKTREE_ID, SESSION_ID, 'local')
    expect(lifecycle()).toBe('pending')
    expect(mutations()).toEqual([
      { method: 'agentSession.setOption', fence: 7, key: 'model', value: 'gpt-picked' }
    ])
    setOptionReplies[0]!.resolve({
      ok: true,
      value: { key: 'model', value: 'gpt-picked', options: { model: 'gpt-picked' } }
    })
    await expect(modelPick).resolves.toEqual({
      kind: 'accepted',
      options: { model: 'gpt-picked' }
    })
    await settle()
    expect(lifecycle()).toBe('pending')
    setOptionReplies[1]!.resolve(ACCEPTED)
    await launch.promptDeliveryResult

    expect(mutations()).toEqual([
      { method: 'agentSession.setOption', fence: 7, key: 'model', value: 'gpt-picked' },
      { method: 'agentSession.setOption', fence: 7, key: 'effort', value: 'high' },
      { method: 'agentSession.send' }
    ])
    expect(lifecycle()).toBeNull()
  })

  it('applies a pick made while the earlier ones are being applied', async () => {
    mocks.launch.mockResolvedValue({ sessionId: SESSION_ID, fence: 1 })
    const launch = startStructuredAgentLaunch(WORKTREE_ID, 'codex', { requestId: 'request-2' })
    holdStructuredAgentSessionLaunchOption(SESSION_ID, 'model', 'gpt-picked')
    await settle()
    expect(setOptionReplies).toHaveLength(1)

    holdStructuredAgentSessionLaunchOption(SESSION_ID, 'model', 'gpt-repicked')
    setOptionReplies[0]!.resolve(ACCEPTED)
    await settle()
    expect(lifecycle()).toBe('pending')
    setOptionReplies[1]!.resolve(ACCEPTED)
    await launch.launchResult

    expect(mutations().map((mutation) => mutation.value)).toEqual(['gpt-picked', 'gpt-repicked'])
  })

  it('reports a refused pick to its picker and publishes all the same', async () => {
    mocks.launch.mockResolvedValue({ sessionId: SESSION_ID, fence: 1 })
    const launch = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
      requestId: 'request-3',
      prompt: 'first turn'
    })
    const pick = holdStructuredAgentSessionLaunchOption(SESSION_ID, 'model', 'gpt-missing')
    await settle()
    setOptionReplies[0]!.resolve({
      ok: false,
      refusal: {
        code: 'agent_session_operation_capacity',
        message: 'Model gpt-missing is unavailable'
      }
    })

    // The picker gets the refusal as a fact; the host's diagnostic is not kept.
    await expect(pick).resolves.toEqual({
      kind: 'refused',
      failure: { kind: 'refused', code: 'agent_session_operation_capacity' }
    })
    await expect(launch.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    expect(mutations().map((mutation) => mutation.method)).toEqual([
      'agentSession.setOption',
      'agentSession.send'
    ])
  })

  it('reports a refusal the host threw as its fact, never the bare code it carries as a message', async () => {
    mocks.launch.mockResolvedValue({ sessionId: SESSION_ID, fence: 1 })
    startStructuredAgentLaunch(WORKTREE_ID, 'codex', { requestId: 'request-4' })
    const pick = holdStructuredAgentSessionLaunchOption(SESSION_ID, 'model', 'gpt-missing')
    await settle()
    setOptionReplies[0]!.resolve(
      Promise.reject(
        new RuntimeRpcCallError({
          id: 'request-1',
          ok: false,
          error: {
            code: 'runtime_error',
            message: 'agent_session_journal_unreadable',
            data: {
              refusal: {
                code: 'agent_session_journal_unreadable',
                details: { reason: 'journalUnavailable' }
              }
            }
          },
          _meta: { runtimeId: 'runtime-1' }
        })
      )
    )

    await expect(pick).resolves.toEqual({
      kind: 'refused',
      failure: {
        kind: 'refused',
        code: 'agent_session_journal_unreadable',
        details: { reason: 'journalUnavailable' }
      }
    })
  })

  it('keeps picks held through a failed start and applies them to the retry', async () => {
    mocks.launch
      .mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('unsupported'))
      .mockResolvedValueOnce({ sessionId: SESSION_ID, fence: 2 })
    startStructuredAgentLaunch(WORKTREE_ID, 'codex', { requestId: 'request-5' })
    holdStructuredAgentSessionLaunchOption(SESSION_ID, 'model', 'gpt-picked')
    await settle()
    expect(lifecycle()).toBe('failed')
    expect(mutations()).toEqual([])

    expect(retryStructuredAgentSessionLaunch(WORKTREE_ID, SESSION_ID)).toBe(true)
    // The retried create seeds from the saved selection of now.
    expect(getStructuredAgentSessionLaunchSelection(SESSION_ID)).toEqual({
      seed: { model: 'gpt-saved-since' },
      held: { model: 'gpt-picked' }
    })
    await settle()
    expect(mutations()).toEqual([
      { method: 'agentSession.setOption', fence: 2, key: 'model', value: 'gpt-picked' }
    ])
  })

  it('discards them when the tab closes before the launch publishes', async () => {
    const created = deferred<{ sessionId: string; fence: number }>()
    mocks.launch.mockReturnValue(created.promise)
    startStructuredAgentLaunch(WORKTREE_ID, 'codex', { requestId: 'request-6' })
    holdStructuredAgentSessionLaunchOption(SESSION_ID, 'model', 'gpt-picked')

    cancelStructuredAgentLaunch(WORKTREE_ID, SESSION_ID)
    created.resolve({ sessionId: SESSION_ID, fence: 1 })
    await settle()

    expect(mutations()).toEqual([])
    expect(holdStructuredAgentSessionLaunchOption(SESSION_ID, 'model', 'gpt-late')).toBeNull()
  })

  it('folds an accepted pick into what the launch reports it runs', async () => {
    mocks.launch.mockResolvedValue({ sessionId: SESSION_ID, fence: 1 })
    startStructuredAgentLaunch(WORKTREE_ID, 'codex', { requestId: 'request-7' })
    holdStructuredAgentSessionLaunchOption(SESSION_ID, 'effort', 'high')
    await settle()
    const seen: unknown[] = []
    subscribeStructuredAgentLaunchStatus(() =>
      seen.push(getStructuredAgentSessionLaunchSelection(SESSION_ID))
    )
    setOptionReplies[0]!.resolve({
      ok: true,
      value: { key: 'effort', value: 'high', options: { model: 'gpt-seeded', effort: 'high' } }
    })
    await settle()

    expect(seen[0]).toEqual({ seed: { model: 'gpt-seeded', effort: 'high' }, held: {} })
    expect(lifecycle()).toBeNull()
  })

  it('keeps a held speed pick through a later model pick while dropping other held options', async () => {
    const created = deferred<{ sessionId: string; fence: number }>()
    mocks.launch.mockReturnValue(created.promise)
    const launch = startStructuredAgentLaunch(WORKTREE_ID, 'codex', { requestId: 'request-8' })

    const speedPick = holdStructuredAgentSessionLaunchOption(SESSION_ID, 'serviceTier', 'ultrafast')
    const effortPick = holdStructuredAgentSessionLaunchOption(SESSION_ID, 'effort', 'high')
    const modelPick = holdStructuredAgentSessionLaunchOption(SESSION_ID, 'model', 'gpt-picked')

    expect(getStructuredAgentSessionLaunchSelection(SESSION_ID)?.held).toEqual({
      model: 'gpt-picked',
      serviceTier: 'ultrafast'
    })
    await expect(effortPick).resolves.toEqual({ kind: 'superseded' })

    created.resolve({ sessionId: SESSION_ID, fence: 7 })
    await settle()
    expect(mutations()).toEqual([
      { method: 'agentSession.setOption', fence: 7, key: 'model', value: 'gpt-picked' }
    ])
    setOptionReplies[0]!.resolve({
      ok: true,
      value: { key: 'model', value: 'gpt-picked', options: { model: 'gpt-picked' } }
    })
    await expect(modelPick).resolves.toEqual({
      kind: 'accepted',
      options: { model: 'gpt-picked' }
    })
    await settle()
    expect(mutations()).toEqual([
      { method: 'agentSession.setOption', fence: 7, key: 'model', value: 'gpt-picked' },
      { method: 'agentSession.setOption', fence: 7, key: 'serviceTier', value: 'ultrafast' }
    ])
    setOptionReplies[1]!.resolve({
      ok: true,
      value: {
        key: 'serviceTier',
        value: 'ultrafast',
        options: { model: 'gpt-picked', serviceTier: 'ultrafast' }
      }
    })
    await expect(speedPick).resolves.toEqual({
      kind: 'accepted',
      options: { model: 'gpt-picked', serviceTier: 'ultrafast' }
    })
    await launch.launchResult

    expect(mutations().map((mutation) => mutation.key)).toEqual(['model', 'serviceTier'])
  })

  it('keeps a held speed pick when the model is picked again', async () => {
    mocks.launch.mockReturnValue(deferred<{ sessionId: string; fence: number }>().promise)
    startStructuredAgentLaunch(WORKTREE_ID, 'codex', { requestId: 'request-8b' })

    const firstModelPick = holdStructuredAgentSessionLaunchOption(SESSION_ID, 'model', 'gpt-picked')
    holdStructuredAgentSessionLaunchOption(SESSION_ID, 'serviceTier', 'ultrafast')
    holdStructuredAgentSessionLaunchOption(SESSION_ID, 'model', 'gpt-repicked')

    await expect(firstModelPick).resolves.toEqual({ kind: 'superseded' })
    expect(getStructuredAgentSessionLaunchSelection(SESSION_ID)?.held).toEqual({
      model: 'gpt-repicked',
      serviceTier: 'ultrafast'
    })
  })

  describe('when the host refuses the held speed pick', () => {
    type RefusedLaunchSeen = {
      launch?: 'resolved' | 'rejected'
      delivered?: boolean
      promptRejected?: true
    }

    async function launchWithRefusedSpeedPick() {
      const created = deferred<{ sessionId: string; fence: number }>()
      mocks.launch.mockReturnValue(created.promise)
      const launch = startStructuredAgentLaunch(WORKTREE_ID, 'codex', {
        requestId: 'request-9',
        prompt: 'first turn'
      })
      const seen: RefusedLaunchSeen = {}
      void launch.launchResult.then(
        () => {
          seen.launch = 'resolved'
        },
        () => {
          seen.launch = 'rejected'
        }
      )
      void launch.promptDeliveryResult?.then(
        (result) => {
          seen.delivered = result.delivered
        },
        () => {
          seen.promptRejected = true
        }
      )

      const speedPick = holdStructuredAgentSessionLaunchOption(SESSION_ID, 'serviceTier', 'ultrafast')
      // Attached before the refusal arrives so the picker's outcome is never left unobserved.
      const reported = expect(speedPick).resolves.toMatchObject({
        kind: 'refused',
        failure: { kind: 'refused', code: 'agent_session_operation_invalid' }
      })
      created.resolve({ sessionId: SESSION_ID, fence: 7 })
      await settle()
      setOptionReplies[0]!.resolve({
        ok: false,
        refusal: {
          code: 'agent_session_operation_invalid',
          message: 'Service tier ultrafast is unavailable'
        }
      })
      await reported
      await settle()
      return { launch, seen }
    }

    function expectLaunchStillBlocked(seen: RefusedLaunchSeen) {
      expect(mutations()).toEqual([
        { method: 'agentSession.setOption', fence: 7, key: 'serviceTier', value: 'ultrafast' }
      ])
      expect(seen.launch).not.toBe('resolved')
      expect(seen.delivered).not.toBe(true)
      expect(lifecycle()).not.toBeNull()
      expect(lifecycle()).not.toBe('published')
      // The requested tier is kept as picked, never swapped for the seed's or a default speed.
      expect(getStructuredAgentSessionLaunchSelection(SESSION_ID)).toEqual({
        seed: { model: 'gpt-seeded' },
        held: { serviceTier: 'ultrafast' }
      })
    }

    it('sends no first turn and does not publish, keeping the pick and the created chat', async () => {
      const { launch, seen } = await launchWithRefusedSpeedPick()

      expectLaunchStillBlocked(seen)
      expect(launch.sessionId).toBe(SESSION_ID)
      expect(mocks.launch).toHaveBeenCalledTimes(1)
    })

    it('is not unblocked by the host inventory showing the chat', async () => {
      const { seen } = await launchWithRefusedSpeedPick()

      markStructuredAgentSessionLaunchesPublished('local', publishedStructuredSessions([PUBLISHED]))
      markStructuredAgentSessionLaunchPublished(WORKTREE_ID, SESSION_ID, 'local')
      await settle()

      expectLaunchStillBlocked(seen)
      expect(mocks.launch).toHaveBeenCalledTimes(1)
    })

    it('sends the first turn once, on the same chat, when a replacement speed is picked', async () => {
      const { launch, seen } = await launchWithRefusedSpeedPick()
      expectLaunchStillBlocked(seen)
      // The refused pick is still held, and the first turn still waits in the chat's send slot.
      expect(hasStagedStructuredLaunchPrompt(SESSION_ID)).toBe(true)

      const replacement = holdStructuredAgentSessionLaunchOption(SESSION_ID, 'serviceTier', 'fast')
      // Attached before the host replies so the picker's outcome is never left unobserved.
      const accepted = expect(replacement).resolves.toEqual({
        kind: 'accepted',
        options: { model: 'gpt-seeded', serviceTier: 'fast' }
      })
      const launched = expect(launch.launchResult).resolves.toEqual({
        sessionId: SESSION_ID,
        fence: 7
      })
      const delivered = expect(launch.promptDeliveryResult).resolves.toEqual({
        delivered: true,
        failureNotified: false
      })
      await settle()

      // The replacement goes to the host against the same receipt fence, still ahead of the turn.
      expect(setOptionReplies).toHaveLength(2)
      expect(mutations()).toEqual([
        { method: 'agentSession.setOption', fence: 7, key: 'serviceTier', value: 'ultrafast' },
        { method: 'agentSession.setOption', fence: 7, key: 'serviceTier', value: 'fast' }
      ])
      setOptionReplies[1]!.resolve({
        ok: true,
        value: {
          key: 'serviceTier',
          value: 'fast',
          options: { model: 'gpt-seeded', serviceTier: 'fast' }
        }
      })
      await Promise.all([accepted, launched, delivered])

      expect(mutations().map((mutation) => mutation.method)).toEqual([
        'agentSession.setOption',
        'agentSession.setOption',
        'agentSession.send'
      ])
      const sends = mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.send')
      expect(sends).toHaveLength(1)
      expect(sends[0]?.[2]).toMatchObject({
        envelope: { sessionId: SESSION_ID, expectedRuntimeFence: 7 },
        body: { blocks: [{ type: 'text', text: 'first turn' }] }
      })
      expect(hasStagedStructuredLaunchPrompt(SESSION_ID)).toBe(false)
      expect(lifecycle()).toBeNull()
      // One create for the whole recovery: no relaunch, so no second chat and no second fence.
      expect(mocks.launch).toHaveBeenCalledTimes(1)
      expect(mocks.createIntent).toHaveBeenCalledTimes(1)
      expect(mocks.retryIntent).not.toHaveBeenCalled()
      expect(seen.promptRejected).toBeUndefined()
    })
  })
})
