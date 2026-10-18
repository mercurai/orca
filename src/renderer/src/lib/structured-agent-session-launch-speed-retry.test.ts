// @vitest-environment happy-dom
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
vi.mock('./launch-structured-agent-session', () => ({
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
import { stageStructuredLaunchPrompt } from './structured-agent-session-launch-prompt'
import { structuredAgentLaunchRecordFor } from './structured-agent-session-launch-record'
import {
  getStructuredAgentSessionPendingSends
} from '../components/native-chat/structured-agent-session-pending-sends'
import { resetStructuredAgentSessionSendsForTests } from '../components/native-chat/structured-agent-session-message-sender'

const SESSION = 'codex_synthetic_authorization_retry'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  vi.clearAllMocks()
})
afterEach(() => {
  resetStructuredAgentSessionSendsForTests()
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
        randomUuid: () => 'synthetic-operation',
        now: 1_000
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
})
