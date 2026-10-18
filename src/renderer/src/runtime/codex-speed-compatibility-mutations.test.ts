// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateIntentParams, SendParams } from '../../../shared/rpc-contract/structured-agent-session-params'
import { structuredAgentSessionCreateParams } from '../../../shared/structured-agent-session-create'
import { structuredAgentSessionCreateFingerprint } from '../../../shared/structured-agent-session-mutation'
import { structuredAgentSessionMessageSendMutation } from '../../../shared/structured-agent-session-send-mutation'
import type { StructuredAgentSessionLaunchIntent } from '../lib/launch-structured-agent-session'
import type { StructuredAgentSessionPendingSend } from '../components/native-chat/structured-agent-session-pending-sends'

const mocks = vi.hoisted(() => {
  const state: { capabilities: string[] | null } = { capabilities: [] }
  return {
    call: vi.fn<(target: unknown, method: string, params?: unknown) => Promise<unknown>>(),
    get capabilities() { return state.capabilities },
    set capabilities(value: string[] | null) { state.capabilities = value },
    compatible: vi.fn(async () => undefined)
  }
})
vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.call,
  ensureRuntimeEnvironmentCompatible: mocks.compatible,
  runtimeEnvironmentSupportsCapability: async (_environment: string, capability: string) => {
    if (mocks.capabilities === null) {
      throw new Error('Synthetic capability probe unavailable')
    }
    return mocks.capabilities.includes(capability)
  }
}))
vi.mock('./local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: () => mocks.capabilities,
  ensureLocalRuntimeCapabilities: async () => mocks.capabilities
}))
vi.mock('../lib/structured-agent-session-host-admission', () => ({
  askHostCreateSupport: async () => ({ kind: 'admitted' })
}))
vi.mock('../lib/launch-structured-agent-session', () => ({
  abandonStructuredAgentSessionLaunchIntent: vi.fn()
}))

import { launchStructuredAgentSession } from '../lib/structured-agent-session-launch-create-call'
import {
  attemptStructuredAgentSessionSend,
  noteStructuredAgentSessionFence,
  resetStructuredAgentSessionFencesForTests
} from '../components/native-chat/structured-agent-session-send-attempt'

const SPEED_CAPABILITY = 'agent-session.codex-speed-selection.v1'
const ULTRA = 'synthetic-ultrafast-exact-request-id'
const SESSION = 'codex_synthetic_speed_bridge'
const TARGET = { kind: 'local' } as const
const BODY = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'synthetic message' }] } as const

function intent(tier: string): StructuredAgentSessionLaunchIntent {
  return {
    sessionId: SESSION,
    worktreeId: 'synthetic-worktree',
    executionHostId: 'local',
    target: TARGET,
    agent: 'codex',
    seedOptions: { serviceTier: tier },
    params: structuredAgentSessionCreateParams({
      sessionId: SESSION,
      worktree: 'id:synthetic-worktree',
      agent: 'codex',
      options: { serviceTier: tier },
      randomUuid: () => 'synthetic-create-operation',
      now: 1_000
    })
  }
}

function entry(tier: string): StructuredAgentSessionPendingSend {
  return {
    clientMessageId: 'synthetic-send-operation',
    sessionId: SESSION,
    body: { ...BODY, blocks: [...BODY.blocks] },
    previewUris: [],
    queuedAt: 1_000,
    options: { serviceTier: tier },
    phase: 'sending',
    issued: false
  }
}

function attempt(pending: StructuredAgentSessionPendingSend) {
  return attemptStructuredAgentSessionSend({
    entry: pending,
    target: TARGET,
    beforeIssue: () => { pending.issued = true },
    abandoned: () => false
  })
}

function callsFor(method: string) {
  return mocks.call.mock.calls.filter(([, name]) => name === method)
}

describe('Codex speed compatibility is negotiated before mutation fingerprints', () => {
  beforeEach(() => {
    mocks.call.mockReset()
    mocks.call.mockImplementation(async (_target, method) => {
      if (method === 'status.get') {
        if (mocks.capabilities === null) {
          throw new Error('Synthetic capability probe unavailable')
        }
        return { runtimeId: 'synthetic-runtime', capabilities: mocks.capabilities }
      }
      throw new Error('Synthetic transport loss')
    })
    mocks.capabilities = []
    resetStructuredAgentSessionFencesForTests()
    noteStructuredAgentSessionFence(SESSION, 7)
  })

  it.each(['legacy', 'unknown'] as const)(
    'refuses an Ultrafast create before writing to a %s host',
    async (host) => {
      mocks.capabilities = host === 'unknown' ? null : []
      const launch = intent(ULTRA)
      await expect(launchStructuredAgentSession(launch)).rejects.toThrow(/speed|tier|update|support/i)
      expect(callsFor('agentSession.create')).toEqual([])
      expect(launch.seedOptions).toEqual({ serviceTier: ULTRA })
    }
  )

  it.each(['legacy', 'unknown'] as const)(
    'refuses an Ultrafast send before writing to a %s host',
    async (host) => {
      mocks.capabilities = host === 'unknown' ? null : []
      const pending = entry(ULTRA)
      const result = await attempt(pending)
      expect(result).toMatchObject({ kind: 'not-sent' })
      expect(JSON.stringify(result)).toMatch(/speed|tier|update|support/i)
      expect(callsFor('agentSession.send')).toEqual([])
      expect(pending.issued).toBe(false)
      expect(pending.options).toEqual({ serviceTier: ULTRA })
    }
  )

  it('freezes translated Standard create payload and fingerprint through a host upgrade', async () => {
    const launch = intent('default')
    await expect(launchStructuredAgentSession(launch)).rejects.toThrow('Synthetic transport loss')
    const original = CreateIntentParams.parse(callsFor('agentSession.create')[0]?.[2])
    expect(original.options).toEqual({ fastMode: 'false' })
    expect(original.envelope.payloadFingerprint).toBe(structuredAgentSessionCreateFingerprint({
      sessionId: SESSION,
      ...original
    }))
    mocks.capabilities = [SPEED_CAPABILITY]
    await expect(launchStructuredAgentSession(launch, undefined, true)).rejects.toThrow('Synthetic transport loss')
    const replay = CreateIntentParams.parse(callsFor('agentSession.create')[1]?.[2])
    expect(replay).toEqual(original)
    expect(launch.seedOptions).toEqual({ serviceTier: 'default' })
  })

  it('freezes translated Standard send payload and fingerprint through a host upgrade', async () => {
    const pending = entry('default')
    await attempt(pending)
    const original = SendParams.parse(callsFor('agentSession.send')[0]?.[2])
    expect(original.options).toEqual({ fastMode: 'false' })
    const expected = structuredAgentSessionMessageSendMutation({
      sessionId: SESSION,
      clientOperationId: pending.clientMessageId,
      expectedRuntimeFence: 7,
      body: pending.body,
      options: { fastMode: 'false' }
    })
    expect(original.envelope.payloadFingerprint).toBe(expected.envelope.payloadFingerprint)
    mocks.capabilities = [SPEED_CAPABILITY]
    await attempt(pending)
    const replay = SendParams.parse(callsFor('agentSession.send')[1]?.[2])
    expect(replay).toEqual(original)
    expect(pending.options).toEqual({ serviceTier: 'default' })
  })
})
