import { maybeCleanupLaunchState } from './structured-agent-session-launch-outcome-tracking'
// @vitest-environment happy-dom
import type * as LaunchIntentModule from './launch-structured-agent-session'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CreateIntentParams,
  SendParams,
  SetOptionParams
} from '../../../shared/rpc-contract/structured-agent-session-params'
import { structuredAgentSessionCreateParams } from '../../../shared/structured-agent-session-create'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionHistoryPage } from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionLaunchIntent } from './launch-structured-agent-session'

const mocks = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params: unknown) => Promise<unknown>>(),
  createIntent: vi.fn(),
  retryIntent: vi.fn(),
  inventory: vi.fn(),
  firstMessageSupport: false
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  supportsStructuredAgentSessionCreateMessage: async () => mocks.firstMessageSupport
}))
vi.mock('@/runtime/codex-speed-selection', () => ({
  CodexSpeedSelectionError: class extends Error {},
  prepareCodexSpeedWireOptions: async (input: { options?: Readonly<Record<string, string>> }) => ({
    options: input.options
  })
}))
vi.mock('./launch-structured-agent-session', async (importOriginal) => ({
  ...(await importOriginal<typeof LaunchIntentModule>()),
  createStructuredAgentSessionLaunchIntent: mocks.createIntent,
  retryStructuredAgentSessionLaunchIntent: mocks.retryIntent
}))
vi.mock('./structured-agent-session-host-admission', () => ({
  askHostCreateSupport: async () => ({ kind: 'admitted' })
}))
vi.mock('@/runtime/structured-session-tab-inventory', () => ({
  readStructuredSessionTabInventory: mocks.inventory
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: {},
      unifiedTabsByWorktree: {},
      seedNativeChatLaunchDraft: vi.fn(),
      clearNativeChatLaunchDraft: vi.fn()
    }),
    subscribe: () => () => {}
  }
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn() } }))

import {
  startStructuredAgentLaunch,
  getStructuredAgentSessionLaunchLifecycle
} from './structured-agent-session-launch'
import {
  holdStructuredAgentSessionLaunchOption,
  getStructuredAgentSessionLaunchSelection
} from './structured-agent-session-launch-options'
import {
  resetStructuredAgentLaunchRegistryForTests,
  getStructuredLaunchStateBySessionId
} from './structured-agent-session-launch-registry'
import { resetStructuredAgentLaunchPersistenceForTests } from './structured-agent-session-launch-persistence'
import { resetStructuredAgentSessionSendsForTests } from '../components/native-chat/structured-agent-session-message-sender'
import { getStructuredAgentSessionPendingSends } from '../components/native-chat/structured-agent-session-pending-sends'
import { resetStructuredAgentSessionReadOwnersForTests } from '../components/native-chat/structured-agent-session-read-owner'
import { newAgentLaunchRequestId } from './agent-launch-request-id'

const WORKTREE = 'synthetic-held-worktree'
const PAID = 'synthetic-held-exact-tier'
const RECEIPT_FENCE = 7

function submission(clientMessageId: string): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: RECEIPT_FENCE,
    payloadFingerprint: 'a'.repeat(64),
    dispatchState: 'accepted',
    handoverRecorded: true,
    providerItemId: null,
    reason: null,
    submittedAt: 1_760_000_000_000,
    resolvedAt: 1_760_000_000_000
  }
}

function created(params: ReturnType<typeof CreateIntentParams.parse>) {
  const cursor = { epoch: 'synthetic-epoch', sequence: params.firstMessage ? 1 : 0 }
  const firstMessage = params.firstMessage
    ? submission(params.firstMessage.clientMessageId)
    : undefined
  const page: AgentSessionHistoryPage = {
    sessionId: params.envelope.sessionId,
    epoch: cursor.epoch,
    fence: RECEIPT_FENCE,
    direction: 'tail',
    items: [],
    removedItemIds: [],
    submissions: firstMessage ? [firstMessage] : [],
    window: { oldest: null, newest: null, nextCursor: cursor },
    liveCursor: cursor,
    hasOlder: false,
    hasNewer: false,
    latestTurn: null
  }
  return {
    ok: true,
    replayed: false,
    value: {
      sessionId: page.sessionId,
      fence: RECEIPT_FENCE,
      page,
      firstMessage,
      unconfirmedClientMessageIds: []
    }
  }
}

function calls(method: string) {
  return mocks.call.mock.calls.filter(([, name]) => name === method)
}

async function begin(agent: 'codex' | 'claude' = 'codex') {
  const createReply = Promise.withResolvers<unknown>()
  const optionReply = Promise.withResolvers<unknown>()
  mocks.call.mockImplementation(async (_target, method, params) => {
    if (method === 'agentSession.create') {
      return createReply.promise
    }
    if (method === 'agentSession.setOption') {
      return optionReply.promise
    }
    if (method === 'agentSession.send') {
      const send = SendParams.parse(params)
      return { ok: true, value: { submission: submission(send.envelope.clientOperationId) } }
    }
    throw new Error(`Unexpected synthetic method ${method}`)
  })
  const launch = startStructuredAgentLaunch(WORKTREE, agent, {
    requestId: newAgentLaunchRequestId(),
    executionHostId: 'local',
    prompt: 'original held prompt'
  })
  await vi.waitFor(() => expect(calls('agentSession.create')).toHaveLength(1))
  const snapshot = CreateIntentParams.parse(calls('agentSession.create')[0]?.[2])
  return { launch, snapshot, createReply, optionReply }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_760_000_000_000)
  vi.clearAllMocks()
  localStorage.clear()
  resetStructuredAgentLaunchRegistryForTests()
  resetStructuredAgentLaunchPersistenceForTests()
  mocks.firstMessageSupport = false
  mocks.createIntent.mockImplementation((_worktree: string, agent: 'codex' | 'claude') => {
    const sessionId = `${agent}_synthetic_held_speed`
    const options: Record<string, string> =
      agent === 'codex' ? { serviceTier: 'default' } : { model: 'synthetic-claude' }
    const intent: StructuredAgentSessionLaunchIntent = {
      sessionId,
      worktreeId: WORKTREE,
      executionHostId: 'local',
      target: { kind: 'local' },
      agent,
      seedOptions: options,
      params: structuredAgentSessionCreateParams({
        sessionId,
        worktree: `id:${WORKTREE}`,
        agent,
        options,
        randomUuid: () => '01234567-89ab-cdef-0123-456789abcdef',
        now: 1_760_000_000_000
      })
    }
    return intent
  })
  mocks.inventory.mockImplementation(async () => [
    {
      worktree: WORKTREE,
      tabs: ['codex', 'claude'].map((agent) => ({
        type: 'agent-session',
        sessionId: `${agent}_synthetic_held_speed`
      }))
    }
  ])
})
afterEach(() => {
  resetStructuredAgentSessionSendsForTests()
  resetStructuredAgentSessionReadOwnersForTests()
  resetStructuredAgentLaunchRegistryForTests()
  resetStructuredAgentLaunchPersistenceForTests()
  vi.useRealTimers()
})

async function flush() {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve()
  }
}
function acceptOptionsAndSend() {
  mocks.call.mockImplementation(async (_target, method, params) => {
    if (method === 'agentSession.setOption') {
      const fields = SetOptionParams.parse(params)
      return { ok: true, value: { ...fields, options: { [fields.key]: fields.value } } }
    }
    if (method === 'agentSession.send') {
      const send = SendParams.parse(params)
      return { ok: true, value: { submission: submission(send.envelope.clientOperationId) } }
    }
    throw new Error(`Unexpected repeated mutation ${method}`)
  })
}
const REFUSED = {
  ok: false,
  refusal: {
    code: 'agent_session_operation_invalid',
    message: 'Synthetic speed unavailable',
    details: { reason: 'optionRejected' }
  }
}

describe('a refused speed held after create froze', () => {
  it('keeps the legacy prompt and receipt paused until explicit Standard replaces the refused speed', async () => {
    const fixture = await begin()
    const { sessionId } = fixture.launch
    let published = false
    void fixture.launch.launchResult.then(
      () => {
        published = true
      },
      () => {
        published = true
      }
    )
    const pick = holdStructuredAgentSessionLaunchOption(sessionId, 'serviceTier', PAID)
    fixture.createReply.resolve(created(fixture.snapshot))
    await vi.waitFor(() => expect(calls('agentSession.setOption')).toHaveLength(1))
    fixture.optionReply.resolve(REFUSED)
    await expect(pick).resolves.toMatchObject({ kind: 'refused' })
    await flush()
    expect(getStructuredAgentSessionLaunchSelection(sessionId)?.held).toMatchObject({
      serviceTier: PAID
    })
    expect(published).toBe(false)
    expect(getStructuredAgentSessionLaunchLifecycle(WORKTREE, sessionId)).toBe('pending')
    expect(calls('agentSession.send')).toEqual([])
    expect(getStructuredAgentSessionPendingSends(sessionId)[0]?.body.blocks).toEqual([
      { type: 'text', text: 'original held prompt' }
    ])

    mocks.call.mockImplementation(async (_target, method, params) => {
      if (method === 'agentSession.setOption') {
        const fields = SetOptionParams.parse(params)
        return { ok: true, value: { ...fields, options: { serviceTier: 'default' } } }
      }
      if (method === 'agentSession.send') {
        const send = SendParams.parse(params)
        return { ok: true, value: { submission: submission(send.envelope.clientOperationId) } }
      }
      throw new Error(`Unexpected repeated mutation ${method}`)
    })
    const recovery = holdStructuredAgentSessionLaunchOption(sessionId, 'serviceTier', 'default')
    await expect(recovery).resolves.toMatchObject({ kind: 'accepted' })
    await expect(fixture.launch.launchResult).resolves.toMatchObject({
      sessionId,
      fence: RECEIPT_FENCE
    })
    await expect(fixture.launch.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
    expect(calls('agentSession.create')).toHaveLength(1)
    expect(calls('agentSession.send')).toHaveLength(1)
    expect(CreateIntentParams.parse(calls('agentSession.create')[0]?.[2])).toEqual(fixture.snapshot)
    expect(mocks.retryIntent).not.toHaveBeenCalled()
  })

  it('preserves the frozen modern first message and retains a refused next-turn speed', async () => {
    mocks.firstMessageSupport = true
    const fixture = await begin()
    const { sessionId } = fixture.launch
    expect(fixture.snapshot.firstMessage?.body.blocks).toEqual([
      { type: 'text', text: 'original held prompt' }
    ])
    const pick = holdStructuredAgentSessionLaunchOption(sessionId, 'serviceTier', PAID)
    fixture.createReply.resolve(created(fixture.snapshot))
    await vi.waitFor(() => expect(calls('agentSession.setOption')).toHaveLength(1))
    fixture.optionReply.resolve(REFUSED)
    await expect(pick).resolves.toMatchObject({ kind: 'refused' })
    await expect(fixture.launch.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
    expect(getStructuredAgentSessionLaunchSelection(sessionId)?.held).toMatchObject({
      serviceTier: PAID
    })
    expect(getStructuredLaunchStateBySessionId(sessionId)?.intent.params).toEqual(fixture.snapshot)
    expect(calls('agentSession.create')).toHaveLength(1)
    expect(calls('agentSession.send')).toEqual([])
  })

  it('retains a modern blocked speed after the original caller releases its launch', async () => {
    mocks.firstMessageSupport = true
    const fixture = await begin()
    const { sessionId } = fixture.launch
    const state = getStructuredLaunchStateBySessionId(sessionId)
    if (!state) {
      throw new Error('Expected original launch state')
    }
    const pick = holdStructuredAgentSessionLaunchOption(sessionId, 'serviceTier', PAID)
    fixture.createReply.resolve(created(fixture.snapshot))
    await vi.waitFor(() => expect(calls('agentSession.setOption')).toHaveLength(1))
    fixture.optionReply.resolve(REFUSED)
    await expect(pick).resolves.toMatchObject({ kind: 'refused' })
    await fixture.launch.promptDeliveryResult
    state.callers.entries.clear()
    await flush()
    maybeCleanupLaunchState(state)
    expect(getStructuredLaunchStateBySessionId(sessionId)).toBe(state)
    expect(state.selection.held).toMatchObject({ serviceTier: PAID })
    expect(calls('agentSession.create')).toHaveLength(1)
    expect(calls('agentSession.send')).toEqual([])
  })

  it.each([
    ['fastMode', 'true', 'serviceTier', 'default'],
    ['serviceTier', PAID, 'fastMode', 'false']
  ])(
    'supersedes blocked %s=%s with %s=%s without another create',
    async (oldKey, oldValue, key, value) => {
      const fixture = await begin()
      const { sessionId } = fixture.launch
      const original = holdStructuredAgentSessionLaunchOption(sessionId, oldKey, oldValue)
      fixture.createReply.resolve(created(fixture.snapshot))
      await vi.waitFor(() => expect(calls('agentSession.setOption')).toHaveLength(1))
      fixture.optionReply.resolve(REFUSED)
      await expect(original).resolves.toMatchObject({ kind: 'refused' })
      await flush()
      expect(calls('agentSession.send')).toEqual([])
      acceptOptionsAndSend()
      const replacement = holdStructuredAgentSessionLaunchOption(sessionId, key, value)
      expect(getStructuredAgentSessionLaunchSelection(sessionId)?.held).not.toHaveProperty(oldKey)
      await expect(replacement).resolves.toMatchObject({ kind: 'accepted' })
      await expect(fixture.launch.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
      expect(calls('agentSession.create')).toHaveLength(1)
      expect(calls('agentSession.send')).toHaveLength(1)
      expect(mocks.retryIntent).not.toHaveBeenCalled()
    }
  )

  it('does not let an old refused acknowledgement block a newer explicit selection', async () => {
    const fixture = await begin()
    const { sessionId } = fixture.launch
    const original = holdStructuredAgentSessionLaunchOption(sessionId, 'serviceTier', PAID)
    fixture.createReply.resolve(created(fixture.snapshot))
    await vi.waitFor(() => expect(calls('agentSession.setOption')).toHaveLength(1))
    acceptOptionsAndSend()
    const replacement = holdStructuredAgentSessionLaunchOption(sessionId, 'serviceTier', 'default')
    fixture.optionReply.resolve(REFUSED)
    await expect(original).resolves.toMatchObject({ kind: 'superseded' })
    await expect(replacement).resolves.toMatchObject({ kind: 'accepted' })
    await expect(fixture.launch.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
    expect(calls('agentSession.create')).toHaveLength(1)
    expect(calls('agentSession.send')).toHaveLength(1)
  })

  it.each([
    ['codex', 'model', 'synthetic-missing-model'],
    ['claude', 'fastMode', 'true']
  ] as const)('preserves the existing refusal behavior for %s %s', async (agent, key, value) => {
    const fixture = await begin(agent)
    const pick = holdStructuredAgentSessionLaunchOption(fixture.launch.sessionId, key, value)
    fixture.createReply.resolve(created(fixture.snapshot))
    await vi.waitFor(() => expect(calls('agentSession.setOption')).toHaveLength(1))
    fixture.optionReply.resolve(REFUSED)
    await expect(pick).resolves.toMatchObject({ kind: 'refused' })
    await expect(fixture.launch.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
    expect(calls('agentSession.create')).toHaveLength(1)
    expect(calls('agentSession.send')).toHaveLength(1)
  })
})
