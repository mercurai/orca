// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_SESSION_OPTION_CATALOG,
  CODEX_SESSION_OPTION_CATALOG
} from '../../../../shared/agent-session-option-catalog-claude-codex'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState
} from '../../../../shared/structured-agent-session-options'
import { structuredAgentSessionOptionView } from '../../../../shared/structured-agent-session-option-view'
import { CODEX_SPEED_SELECTION_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-create-capabilities'
import { SendParams } from '../../../../shared/rpc-contract/structured-agent-session-params'
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), send: vi.fn() }))
vi.mock('@/lib/structured-agent-session-launch-options', () => ({
  getStructuredAgentSessionLaunchSelection: () => null
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.rpc,
  ensureRuntimeEnvironmentCompatible: async () => undefined
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.send
}))

import { useStructuredAgentSessionSendOptions } from './use-structured-agent-session-send-options'
import {
  attemptStructuredAgentSessionSend,
  noteStructuredAgentSessionFence,
  resetStructuredAgentSessionFencesForTests
} from './structured-agent-session-send-attempt'

const MODEL = 'synthetic-composer-model'
const FAST = 'synthetic-fast-exact-request-id'
const ULTRA = 'synthetic-ultrafast-exact-request-id'
const SESSION = 'synthetic-composer-speed-session'

function composer(agent = 'codex', takesSendOptions = true) {
  const seed = agent === 'claude' ? CLAUDE_SESSION_OPTION_CATALOG : CODEX_SESSION_OPTION_CATALOG
  const optionStateRef = {
    current: applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState(agent, seed),
      seed,
      {
        models: [
          {
            id: MODEL,
            label: 'Synthetic',
            isDefault: true,
            // A single advertised effort intentionally has no picker in discoveredModel.
            efforts: [
              { value: 'low', label: 'Low' },
              { value: 'high', label: 'High' }
            ],
            serviceTiers: [
              { value: FAST, label: 'Fast' },
              { value: ULTRA, label: 'Ultrafast' }
            ]
          }
        ],
        current: { model: MODEL, effort: 'high', serviceTier: FAST }
      }
    )
  }
  const pendingOptionsRef: { current: Record<string, string> } = { current: {} }
  const hook = renderHook(() =>
    useStructuredAgentSessionSendOptions(SESSION, undefined, {
      optionStateRef,
      pendingOptionsRef,
      takesSendOptions,
      optionView: (state, launchSeed, held) =>
        structuredAgentSessionOptionView(state, launchSeed, held)
    })
  )
  return { read: () => hook.result.current(), optionStateRef, pendingOptionsRef }
}

async function sendComposer(c: ReturnType<typeof composer>) {
  const entry: StructuredAgentSessionPendingSend = {
    clientMessageId: 'synthetic-composer-message',
    sessionId: SESSION,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'selected speed' }] },
    previewUris: [],
    queuedAt: 1_700_000_000_000,
    // Read through the actual composer hook, including pending picks; no hand-built speed payload.
    options: c.read(),
    phase: 'sending',
    issued: false
  }
  return attemptStructuredAgentSessionSend({
    entry,
    target: { kind: 'local' },
    beforeIssue: () => {
      entry.issued = true
    },
    abandoned: () => false
  })
}

beforeEach(() => {
  mocks.rpc.mockReset()
  mocks.send.mockReset()
  mocks.rpc.mockResolvedValue({
    runtimeId: 'synthetic-runtime',
    capabilities: [CODEX_SPEED_SELECTION_RUNTIME_CAPABILITY]
  })
  mocks.send.mockImplementation(async (_target, _method, params) => {
    SendParams.parse(params)
    throw new Error('Synthetic transport after issue')
  })
  resetStructuredAgentSessionFencesForTests()
  noteStructuredAgentSessionFence(SESSION, 7)
})

describe('Codex composer speed on the send path', () => {
  it('carries the exact shown tier and its model through the actual composer hook', () => {
    expect(composer().read()).toMatchObject({ model: MODEL, effort: 'high', serviceTier: FAST })
  })

  it('reads a pending new speed immediately before send while host state still holds the old tier', async () => {
    const c = composer()
    // The picker holds its new selection while its independent setOption negotiation is pending.
    c.pendingOptionsRef.current = { serviceTier: ULTRA }
    expect(c.read()).toMatchObject({ model: MODEL, serviceTier: ULTRA })
    await sendComposer(c)
    expect(mocks.send).toHaveBeenCalledWith(
      { kind: 'local' },
      'agentSession.send',
      expect.objectContaining({
        options: expect.objectContaining({ model: MODEL, serviceTier: ULTRA })
      }),
      expect.anything()
    )
    expect(SendParams.safeParse(mocks.send.mock.calls[0]?.[2]).success).toBe(true)
  })

  it('refuses the actual send when speed support negotiation is unknown', async () => {
    const c = composer()
    c.pendingOptionsRef.current = { serviceTier: ULTRA }
    mocks.rpc.mockRejectedValue(new Error('Synthetic capability metadata unavailable'))

    expect(await sendComposer(c)).toMatchObject({ kind: 'not-sent' })
    expect(mocks.rpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'status.get',
      undefined,
      expect.anything()
    )
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('preserves Claude model and effort selection without carrying Codex service tiers', () => {
    expect(composer('claude').read()).toEqual({ model: MODEL, effort: 'high' })
  })

  it('blocks an older host send while Standard is pending over a paid host tier', async () => {
    const c = composer('codex', false)
    c.pendingOptionsRef.current = { serviceTier: 'default' }

    await expect(sendComposer(c)).rejects.toThrow(/speed|host|Standard/i)
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('keeps an older host without send-option support unchanged', () => {
    expect(composer('codex', false).read()).toBeUndefined()
  })
})
