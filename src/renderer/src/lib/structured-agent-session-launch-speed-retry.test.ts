// @vitest-environment happy-dom
import type * as LaunchIntentModule from './launch-structured-agent-session'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { structuredAgentSessionCreateParams } from '../../../shared/structured-agent-session-create'
import { CreateIntentParams } from '../../../shared/rpc-contract/structured-agent-session-params'
import type { StructuredAgentSessionLaunchIntent } from './launch-structured-agent-session'
import type { StructuredLaunchState } from './structured-agent-session-launch-registry'

const mocks = vi.hoisted(() => ({
  authorize: vi.fn<(input: { options?: Readonly<Record<string, string>> }) => Promise<{
    options?: Readonly<Record<string, string>>
  }>>(),
  call: vi.fn()
}))
vi.mock('@/runtime/codex-speed-selection', () => ({
  prepareCodexSpeedWireOptions: mocks.authorize,
  CodexSpeedSelectionError: class extends Error {}
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  supportsStructuredAgentSessionCreateMessage: async () => true
}))
vi.mock('./structured-agent-session-host-admission', () => ({
  askHostCreateSupport: async () => ({ kind: 'admitted' })
}))
vi.mock('./structured-agent-session-create-hydration', () => ({
  publishStructuredAgentSessionCreateHydration: vi.fn()
}))
vi.mock('./launch-structured-agent-session', async (importOriginal) => ({
  ...await importOriginal<typeof LaunchIntentModule>(),
  abandonStructuredAgentSessionLaunchIntent: vi.fn()
}))
vi.mock('@/components/native-chat/use-structured-agent-session-option-state', async () => {
  const { createStructuredAgentSessionOptionState } = await import('../../../shared/structured-agent-session-options')
  return { firstFrameOptionState: () => createStructuredAgentSessionOptionState('codex') }
})
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: {} }), subscribe: () => () => {} }
}))

import { launchStructuredAgentSession } from './structured-agent-session-launch-create-call'
import { prepareStructuredLaunchCreateMessage } from './structured-agent-session-launch-create-message'
import { createStructuredLaunchCallerGroup } from './structured-agent-session-launch-callers'
import {
  discardStructuredLaunchPrompts,
  stageStructuredLaunchPrompt
} from './structured-agent-session-launch-prompt'
import { structuredAgentLaunchRecordFor } from './structured-agent-session-launch-record'
import { retryStructuredAgentSessionLaunch } from './structured-agent-session-launch'
import {
  resetStructuredAgentLaunchRegistryForTests,
  setStructuredLaunchState
} from './structured-agent-session-launch-registry'
import { resetStructuredAgentLaunchPersistenceForTests } from './structured-agent-session-launch-persistence'
import {
  getStructuredAgentSessionPendingSends
} from '../components/native-chat/structured-agent-session-pending-sends'
import { resetStructuredAgentSessionSendsForTests } from '../components/native-chat/structured-agent-session-message-sender'

const SESSION = 'codex_synthetic_authorization_retry'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_760_000_000_000)
  vi.clearAllMocks()
  localStorage.clear()
  resetStructuredAgentLaunchRegistryForTests()
  resetStructuredAgentLaunchPersistenceForTests()
})
afterEach(() => {
  discardStructuredLaunchPrompts(SESSION)
  resetStructuredAgentSessionSendsForTests()
  resetStructuredAgentLaunchRegistryForTests()
  resetStructuredAgentLaunchPersistenceForTests()
  vi.useRealTimers()
})

describe('create prompt ownership waits for speed authorization', () => {
  it('keeps the original staged message and delivery slot after failed authorization and retry', async () => {
    const intent: StructuredAgentSessionLaunchIntent = {
      sessionId: SESSION,
      worktreeId: 'synthetic-worktree',
      executionHostId: 'local',
      target: { kind: 'local' },
      agent: 'codex',
      params: structuredAgentSessionCreateParams({
        sessionId: SESSION,
        worktree: 'id:synthetic-worktree',
        agent: 'codex',
        options: { serviceTier: 'synthetic-exact-tier' },
        randomUuid: () => '00000000-0000-4000-8000-000000000001',
        now: 1_760_000_000_000
      })
    }
    const state: StructuredLaunchState = {
      identity: 'synthetic-launch',
      intent,
      promptDelivery: 'auto-submit',
      callers: createStructuredLaunchCallerGroup({ kind: 'retry' }),
      promise: Promise.resolve({ sessionId: SESSION, fence: 7 }),
      visibilityUnknown: false,
      cancelled: false,
      selection: { held: {} }
    }
    intent.prepareCreate = () => prepareStructuredLaunchCreateMessage(state)
    const prompt = stageStructuredLaunchPrompt(SESSION, 'original opening text')
    const pending = getStructuredAgentSessionPendingSends(SESSION)[0]
    expect(pending).toBeDefined()
    mocks.authorize.mockRejectedValueOnce(new Error('Synthetic speed support unknown'))
    mocks.authorize.mockImplementation(async ({ options }) => ({ options }))
    mocks.call.mockRejectedValue(new Error('Synthetic transport loss after authorization'))

    await expect(launchStructuredAgentSession(intent)).rejects.toThrow('Synthetic speed support unknown')
    expect(prompt.createOwned).toBeUndefined()
    expect(prompt.delivery).toBeUndefined()
    expect(intent.createPrepared).toBeUndefined()
    expect(structuredAgentLaunchRecordFor(intent, 'pending')).not.toHaveProperty('createMessageSupport')
    expect(mocks.call).not.toHaveBeenCalled()

    await expect(launchStructuredAgentSession(intent)).rejects.toThrow('Synthetic transport loss after authorization')
    const params = CreateIntentParams.parse(mocks.call.mock.calls[0]?.[2])
    expect(params.firstMessage).toMatchObject({
      clientMessageId: pending?.clientMessageId,
      body: { blocks: [{ type: 'text', text: 'original opening text' }] }
    })
    expect(getStructuredAgentSessionPendingSends(SESSION)[0]?.clientMessageId).toBe(pending?.clientMessageId)
    expect(prompt.createOwned).toBe(true)
    expect(prompt.delivery).toBeDefined()
    expect(mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.send')).toEqual([])
  })

  it('rebuilds a definitively failed create with its newly staged opening and held speed', async () => {
    const worktreeId = 'synthetic-definitive-retry'
    const intent: StructuredAgentSessionLaunchIntent = {
      sessionId: SESSION, worktreeId, executionHostId: 'local', target: { kind: 'local' }, agent: 'codex',
      seedOptions: { serviceTier: 'default' },
      params: structuredAgentSessionCreateParams({
        sessionId: SESSION, worktree: `id:${worktreeId}`, agent: 'codex',
        options: { serviceTier: 'default' },
        randomUuid: () => '00000000-0000-4000-8000-000000000002', now: 1_760_000_000_000
      })
    }
    const originalEnvelope = { ...intent.params.envelope }
    const state: StructuredLaunchState = {
      identity: `codex:${worktreeId}`, intent, promptDelivery: 'auto-submit',
      callers: createStructuredLaunchCallerGroup({ kind: 'retry' }),
      promise: Promise.resolve({ sessionId: SESSION, fence: 0 }),
      visibilityUnknown: false, cancelled: false,
      selection: { seed: intent.seedOptions, held: {
        model: 'synthetic-selected-model', serviceTier: 'synthetic-held-exact-tier'
      } }
    }
    // A definitive refusal permits a new operation; a new explicit send stages this opening.
    state.callers.outcome = 'failed'
    setStructuredLaunchState(state)
    const prompt = stageStructuredLaunchPrompt(SESSION, 'new explicit retry opening')
    const pending = getStructuredAgentSessionPendingSends(SESSION)[0]
    expect(pending).toBeDefined()
    mocks.authorize.mockImplementation(async ({ options }) => ({ options }))
    mocks.call.mockImplementation(async (_target, method, raw) => {
      if (method !== 'agentSession.create') {
        throw new Error(`Unexpected retry mutation ${method}`)
      }
      const params = CreateIntentParams.parse(raw)
      const firstMessage = params.firstMessage ? {
        clientMessageId: params.firstMessage.clientMessageId, fence: 7,
        payloadFingerprint: 'synthetic-opening-receipt', dispatchState: 'accepted',
        handoverRecorded: true, providerItemId: null, reason: null,
        submittedAt: 1_760_000_000_000, resolvedAt: 1_760_000_000_000
      } : undefined
      return { ok: true, value: {
        sessionId: SESSION, fence: 7, page: { submissions: firstMessage ? [firstMessage] : [] },
        ...(firstMessage ? { firstMessage } : {})
      } }
    })

    expect(retryStructuredAgentSessionLaunch(worktreeId, SESSION)).toBe(true)
    await expect(state.promise).resolves.toMatchObject({ sessionId: SESSION, fence: 7 })

    expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual(['agentSession.create'])
    const params = CreateIntentParams.parse(mocks.call.mock.calls[0]?.[2])
    expect(params.options).toEqual({
      model: 'synthetic-selected-model', serviceTier: 'synthetic-held-exact-tier'
    })
    expect(params.firstMessage).toMatchObject({
      clientMessageId: pending?.clientMessageId,
      body: { blocks: [{ type: 'text', text: 'new explicit retry opening' }] }
    })
    expect(state.intent).not.toBe(intent)
    expect(state.intent.prepareCreate).toEqual(expect.any(Function))
    expect(params.envelope.clientOperationId).not.toBe(originalEnvelope.clientOperationId)
    expect(params.envelope.sessionId).toBe(SESSION)
    expect(intent.params.envelope).toEqual(originalEnvelope)
    expect(prompt.createOwned).toBe(true)
    expect(state.intent.createCanonicalOptions).toEqual(params.options)
  })
})
