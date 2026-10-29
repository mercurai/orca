// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CreateIntentParams,
  SendParams
} from '../../../shared/rpc-contract/structured-agent-session-params'
import { structuredAgentSessionCreateFingerprint } from '../../../shared/structured-agent-session-mutation'
import { registerActionEffortCreateTests } from './structured-agent-session-launch-action-effort.test-fixture'
import { isStructuredAgentSessionMainAgentWorking } from '../../../shared/structured-agent-session-main-agent-working'
import type { HostCreateSupport } from './structured-agent-session-host-admission'

const mocks = vi.hoisted(() => {
  const settings: Record<string, unknown> = {}
  return {
    call: vi.fn<(target: unknown, method: string, params: unknown) => Promise<unknown>>(),
    supports: vi.fn<() => Promise<boolean>>(),
    supportsMode: vi.fn<() => Promise<boolean>>(),
    admit: vi.fn<() => Promise<HostCreateSupport>>(),
    inventory: vi.fn(),
    settings
  }
})
const layoutOwner = vi.hoisted(() => ({ isMain: false }))
vi.mock('../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))
// This machine's host closes the chat's tab when asked.
vi.mock('@/runtime/runtime-rpc-client', async () => {
  const { CODEX_SPEED_SELECTION_RUNTIME_CAPABILITY } =
    await import('../../../shared/agent-session-create-capabilities')
  return {
    callRuntimeRpc: vi.fn(async () => ({
      capabilities: [CODEX_SPEED_SELECTION_RUNTIME_CAPABILITY]
    })),
    runtimeEnvironmentSupportsCapability: async () => true
  }
})
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  supportsStructuredAgentSessionCreateOptionsMode: mocks.supportsMode,
  supportsStructuredAgentSessionCreateMessage: mocks.supports
}))
vi.mock('./structured-agent-session-host-admission', () => ({
  askHostCreateSupport: mocks.admit
}))
vi.mock('@/runtime/structured-session-tab-inventory', () => ({
  readStructuredSessionTabInventory: mocks.inventory
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: mocks.settings,
      unifiedTabsByWorktree: {},
      groupsByWorktree: {},
      seedNativeChatLaunchDraft: vi.fn(),
      clearNativeChatLaunchDraft: vi.fn()
    }),
    subscribe: () => () => {}
  }
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/structured-chat-host-permission', () => ({
  readStructuredChatHostPermissionVerdict: async () => ({ kind: 'allowed' })
}))

import {
  startStructuredAgentLaunch,
  cancelStructuredAgentLaunch,
  retryStructuredAgentSessionLaunch,
  getStructuredAgentSessionLaunchLifecycle
} from './structured-agent-session-launch'
import { holdStructuredAgentSessionLaunchOption } from './structured-agent-session-launch-options'
import { recordHostModelCatalogSnapshot } from '@/runtime/host-model-catalog-snapshots'
import {
  getStructuredLaunchStateBySessionId,
  resetStructuredAgentLaunchRegistryForTests
} from './agent-session/launch/structured-agent-session-launch-registry'
import {
  readStructuredAgentLaunchRecord,
  resetStructuredAgentLaunchPersistenceForTests
} from './agent-session/launch/structured-agent-session-launch-persistence'
import { newAgentLaunchRequestId } from './agent-launch-request-id'
import { markStructuredAgentSessionLaunchPublished } from './agent-session/launch/structured-agent-session-launch-publication'
import { resetStructuredAgentSessionSendsForTests } from '@/components/native-chat/structured-agent-session-message-sender'
import { StructuredAgentSessionCreateRefusalError } from './structured-agent-session-launch-errors'
import {
  getStructuredAgentSessionReadOwner,
  findStructuredAgentSessionReadOwner
} from '@/components/native-chat/structured-agent-session-read-owner'
import {
  getStructuredAgentSessionPendingSends,
  getStructuredAgentSessionSendNotice
} from '@/components/native-chat/structured-agent-session-pending-sends'
import { structuredAgentSessionStopControl } from '../../../shared/structured-agent-session-stop-control'
import {
  readNativeChatDraftCache,
  writeNativeChatDraftCache
} from '@/components/native-chat/native-chat-draft-cache'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/native-chat-composer-draft-store'

import {
  deferred,
  submission,
  createdMessageReply,
  resetCreateMessageTestState,
  disposeCreateMessageTestState
} from './structured-agent-session-launch-create-message.test-fixture'

function createParams() {
  return CreateIntentParams.parse(
    mocks.call.mock.calls.find(([, method]) => method === 'agentSession.create')?.[2]
  )
}
function created() {
  return createdMessageReply(createParams())
}
const target = { kind: 'local' } as const
const start = () =>
  startStructuredAgentLaunch('workspace-1', 'codex', {
    requestId: newAgentLaunchRequestId(),
    executionHostId: 'local',
    prompt: 'opening text'
  })
const draft = (sessionId: string) =>
  readNativeChatDraftCache(structuredAgentSessionDraftScopeKey(sessionId))

// An older host (no create-message) applies an action's explicit options one setOption at a time.
function startLegacyActionLaunch(
  launchOptions: Record<string, string>,
  refusedKey: string,
  refusal: Record<string, unknown>
) {
  mocks.supports.mockResolvedValue(false)
  mocks.call.mockImplementation(async (_target, method, params) => {
    if (method === 'agentSession.create') {
      return created()
    }
    if (method === 'agentSession.setOption') {
      const key = params && typeof params === 'object' && 'key' in params ? params.key : null
      return key === refusedKey
        ? { ok: false, refusal }
        : { ok: true, value: { options: { model: launchOptions.model } } }
    }
    const send = SendParams.parse(params)
    const clientMessageId = send.envelope.clientOperationId
    return { ok: true, value: { clientMessageId, submission: submission(clientMessageId) } }
  })
  const launch = startStructuredAgentLaunch('workspace-1', 'codex', {
    requestId: newAgentLaunchRequestId(),
    executionHostId: 'local',
    prompt: 'opening text',
    launchOptions
  })
  mocks.inventory.mockResolvedValue([
    { worktree: 'workspace-1', tabs: [{ type: 'agent-session', sessionId: launch.sessionId }] }
  ])
  return launch
}

describe('the first message owned by create', () => {
  beforeEach(() => {
    layoutOwner.isMain = false
    resetCreateMessageTestState(mocks)
  })
  afterEach(disposeCreateMessageTestState)

  it('freezes the message and held options in create and publishes without another read or send', async () => {
    const create = deferred<unknown>()
    mocks.call.mockReturnValue(create.promise)
    const launch = start()
    holdStructuredAgentSessionLaunchOption(launch.sessionId, 'model', 'picked-model')
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    const params = createParams()
    expect(params.firstMessage?.body.blocks).toEqual([{ type: 'text', text: 'opening text' }])
    expect(params.options).toEqual({ model: 'picked-model' })
    expect(params.envelope.payloadFingerprint).toBe(
      structuredAgentSessionCreateFingerprint({ sessionId: launch.sessionId, ...params })
    )
    expect(getStructuredAgentSessionPendingSends(launch.sessionId)[0]?.phase).toBe('sending')
    const stop = vi.fn(async () => null)
    expect(
      structuredAgentSessionStopControl({
        published: false,
        host: { stopsConversation: true, stop },
        transportState: { turnId: null, isWorking: false },
        sends: { sending: true, stopSends: vi.fn() }
      }).canStop
    ).toBe(false)
    create.resolve(created())
    await launch.launchResult
    await expect(launch.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
    const state = getStructuredAgentSessionReadOwner(launch.sessionId, target).getSnapshot().state
    expect(state.fence).toBe(1)
    const isWorking = isStructuredAgentSessionMainAgentWorking(null, state.submissions, state.fence)
    expect(isWorking).toBe(true)
    const control = structuredAgentSessionStopControl({
      published: true,
      host: { stopsConversation: true, stop },
      transportState: { turnId: null, isWorking },
      sends: { sending: false, stopSends: vi.fn() }
    })
    expect(control.canStop).toBe(true)
    await control.stop()
    expect(stop).toHaveBeenCalledWith(null, expect.any(Function))
    expect(draft(launch.sessionId)).toBe('')
    expect(mocks.inventory).not.toHaveBeenCalled()
    expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual(['agentSession.create'])
  })

  it.each([
    ['new', {}],
    ['resumed', { resumeFrom: { providerSessionId: 'provider-session-1' } }]
  ])(
    "keeps a remembered model the host's saved list lacks, %s: create sends the literal saved choice",
    async (_kind, resume) => {
      mocks.settings = {
        nativeChatSessionOptions: {
          claude: { model: 'claude-gone' }
        }
      }
      const xhigh = [{ value: 'xhigh', label: 'xhigh' }]
      recordHostModelCatalogSnapshot(target, 'claude', null, {
        origin: 'probe',
        fetchedAt: 1,
        models: [{ id: 'opus[1m]', label: 'Opus', isDefault: true, efforts: xhigh }]
      })
      mocks.call.mockImplementation(async () => created())
      try {
        const launch = startStructuredAgentLaunch('workspace-1', 'claude', {
          requestId: newAgentLaunchRequestId(),
          executionHostId: 'local',
          prompt: 'opening text',
          ...resume
        })
        await launch.launchResult
        expect(createParams().options?.model).toBe('claude-gone')
      } finally {
        mocks.settings = {}
      }
    }
  )

  registerActionEffortCreateTests(mocks, created)

  it('leaves a host without options-mode on its own new-chat permission mode', async () => {
    mocks.supportsMode.mockResolvedValue(false)
    mocks.call.mockImplementation(async () => created())
    const launch = startStructuredAgentLaunch('workspace-1', 'codex', {
      requestId: newAgentLaunchRequestId(),
      executionHostId: 'local',
      prompt: 'opening text',
      launchOptions: { permissionMode: 'full-access' }
    })
    await launch.launchResult
    expect(createParams().options).toBeUndefined()
    expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual(['agentSession.create'])
  })

  it('keeps a held model and tier through a default change, refusal and retry', async () => {
    const tiers = (...values: string[]) => values.map((value) => ({ value, label: value }))
    const efforts = tiers('medium', 'high')
    const list = (defaultId: string) => ({
      origin: 'probe' as const,
      catalogState: 'available' as const,
      fetchedAt: 1,
      listingNamesConfiguredModel: true,
      defaultHoldsInEveryWorkspace: true as const,
      models: [
        ['m1', 'priority'],
        ['m2', 'flex']
      ].map(([id, tier]) => ({
        id,
        label: id,
        isDefault: defaultId === id,
        efforts,
        serviceTiers: tiers(tier)
      }))
    })
    recordHostModelCatalogSnapshot(target, 'codex', null, list('m1'))
    const refused = deferred<unknown>()
    const create = deferred<unknown>()
    mocks.call.mockReturnValueOnce(refused.promise).mockReturnValueOnce(create.promise)
    mocks.call.mockResolvedValue({ ok: true, value: { key: 'effort', value: 'medium' } })
    const launch = start()
    holdStructuredAgentSessionLaunchOption(launch.sessionId, 'model', 'm1')
    const tierPick = holdStructuredAgentSessionLaunchOption(
      launch.sessionId,
      'serviceTier',
      'priority'
    )
    holdStructuredAgentSessionLaunchOption(launch.sessionId, 'effort', 'high')
    // A new account default cannot move an explicit model/tier pair onto another model.
    recordHostModelCatalogSnapshot(target, 'codex', null, list('m2'))
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    expect(createParams().options).toEqual({ model: 'm1', effort: 'high', serviceTier: 'priority' })
    refused.resolve({
      ok: false,
      refusal: { code: 'structured_agent_session_unsupported', message: 'no' }
    })
    await expect(launch.launchResult).rejects.toBeInstanceOf(
      StructuredAgentSessionCreateRefusalError
    )
    recordHostModelCatalogSnapshot(target, 'codex', null, list('m1'))
    expect(retryStructuredAgentSessionLaunch('workspace-1', launch.sessionId)).toBe(true)
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    const retried = CreateIntentParams.parse(mocks.call.mock.calls[1]?.[2])
    expect(retried.options).toEqual({ model: 'm1', effort: 'high', serviceTier: 'priority' })
    // A pick made while create is out is newer than what it carries, so it applies after.
    holdStructuredAgentSessionLaunchOption(launch.sessionId, 'effort', 'medium')
    create.resolve(created())
    await expect(tierPick).resolves.toEqual({
      kind: 'accepted',
      options: { model: 'm1', effort: 'high', serviceTier: 'priority' }
    })
    await vi.waitFor(() =>
      expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual([
        'agentSession.create',
        'agentSession.create',
        'agentSession.setOption'
      ])
    )
    expect(mocks.call.mock.calls[2]?.[2]).toMatchObject({ key: 'effort', value: 'medium' })
  })

  it('returns a refused create once after the new draft, with no later send', async () => {
    const create = deferred<unknown>()
    mocks.call.mockReturnValue(create.promise)
    const launch = start()
    const state = getStructuredLaunchStateBySessionId(launch.sessionId)
    if (state) {
      state.intent.surfaceAddress = { worktreeId: 'workspace-1', precedingTabIds: [] }
    }
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    writeNativeChatDraftCache(
      structuredAgentSessionDraftScopeKey(launch.sessionId),
      'typed meanwhile'
    )
    create.resolve({
      ok: false,
      refusal: { code: 'structured_agent_session_unsupported', message: 'unavailable' }
    })
    await expect(launch.launchResult).rejects.toBeInstanceOf(
      StructuredAgentSessionCreateRefusalError
    )
    await launch.promptDeliveryResult?.catch(() => undefined)
    expect(draft(launch.sessionId)).toBe('typed meanwhile\n\nopening text')
    expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual(['agentSession.create'])
    expect(getStructuredAgentSessionPendingSends(launch.sessionId)).toEqual([])
    expect(findStructuredAgentSessionReadOwner(launch.sessionId, target)).toBeUndefined()
  })

  it('returns text at 30 seconds and a late create reply cannot send it again', async () => {
    const create = deferred<unknown>()
    mocks.call.mockReturnValue(create.promise)
    const launch = start()
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(30_000)
    expect(draft(launch.sessionId)).toBe('opening text')
    await expect(launch.promptDeliveryResult).resolves.toMatchObject({
      delivered: false,
      inComposer: true,
      unconfirmed: true
    })
    expect(getStructuredAgentSessionLaunchLifecycle('workspace-1', launch.sessionId)).toBe(
      'visibility-unknown'
    )
    expect(draft(launch.sessionId)).toBe('opening text')
    create.resolve(created())
    await launch.launchResult
    expect(draft(launch.sessionId)).toBe('opening text')
    expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual(['agentSession.create'])
  })

  it('retains an explicit held permission even when modern create omits the seeded default', async () => {
    mocks.call.mockImplementation(async () => created())
    const launch = start()
    holdStructuredAgentSessionLaunchOption(launch.sessionId, 'permissionMode', 'ask')
    await launch.launchResult
    const params = createParams()
    expect(params.firstMessage).toBeDefined()
    expect(params.options).toEqual({ permissionMode: 'ask' })
    expect(params.envelope.payloadFingerprint).toBe(
      structuredAgentSessionCreateFingerprint({ sessionId: launch.sessionId, ...params })
    )
  })

  it.each([
    {
      name: 'defers a Claude action to an older host without forwarding its Fast preference',
      agent: 'claude' as const,
      launchOptions: { fastMode: 'true' },
      expectedOptions: undefined
    },
    {
      name: 'keeps the seeded permission in a plain Codex launch on an older host',
      agent: 'codex' as const,
      launchOptions: undefined,
      expectedOptions: { permissionMode: 'ask' }
    }
  ])('$name', async ({ agent, launchOptions, expectedOptions }) => {
    mocks.supports.mockResolvedValue(false)
    mocks.call.mockImplementation(async (_target, method, params) => {
      if (method === 'agentSession.create') {
        return created()
      }
      const send = SendParams.parse(params)
      return {
        ok: true,
        value: {
          clientMessageId: send.envelope.clientOperationId,
          submission: submission(send.envelope.clientOperationId)
        }
      }
    })
    const launch = startStructuredAgentLaunch('workspace-1', agent, {
      requestId: newAgentLaunchRequestId(),
      executionHostId: 'local',
      prompt: 'opening text',
      ...(launchOptions ? { launchOptions } : {})
    })
    mocks.inventory.mockResolvedValue([
      { worktree: 'workspace-1', tabs: [{ type: 'agent-session', sessionId: launch.sessionId }] }
    ])
    await launch.launchResult
    await expect(launch.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
    expect(createParams()).not.toHaveProperty('firstMessage')
    if (expectedOptions === undefined) {
      expect(createParams()).not.toHaveProperty('options')
    } else {
      expect(createParams().options).toEqual(expectedOptions)
    }
    expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual([
      'agentSession.create',
      'agentSession.send'
    ])
  })

  it('a generated legacy effort refusal does not stop the opening prompt', async () => {
    const launch = startLegacyActionLaunch({ model: 'gpt-5.6-sol' }, 'effort', {
      code: 'agent_session_operation_invalid',
      message: 'unavailable'
    })
    const receipt = await launch.launchResult
    expect(receipt.configurationFailure).toBeUndefined()
    await expect(launch.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
    expect(
      mocks.call.mock.calls
        .filter(([, method]) => method === 'agentSession.setOption')
        .map(([, , params]) => params)
    ).toEqual([
      expect.objectContaining({ key: 'model', value: 'gpt-5.6-sol' }),
      expect.objectContaining({ key: 'effort', value: 'medium' })
    ])
    expect(createParams()).not.toHaveProperty('options')
    expect(draft(launch.sessionId)).toBe('')
  })

  it.each(['model', 'effort'])(
    'keeps the legacy chat and text when required %s is refused, with no fresh Retry',
    async (refused) => {
      const launch = startLegacyActionLaunch({ model: 'action-model', effort: 'high' }, refused, {
        code: 'agent_session_operation_invalid',
        details: { reason: 'optionRejected' },
        message: 'unavailable'
      })
      const receipt = await launch.launchResult
      expect(receipt).toMatchObject({ sessionId: launch.sessionId, configurationFailure: {} })
      await expect(launch.promptDeliveryResult).resolves.toMatchObject({
        delivered: false,
        inComposer: true,
        failureNotified: true
      })
      expect(draft(launch.sessionId)).toBe('opening text')
      expect(getStructuredAgentSessionSendNotice(launch.sessionId)).toContain('Codex')
      expect(mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.send')).toEqual(
        []
      )
      expect(retryStructuredAgentSessionLaunch('workspace-1', launch.sessionId)).toBe(false)
      expect(readStructuredAgentLaunchRecord(launch.sessionId)).toBeUndefined()
      expect(
        mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.create')
      ).toHaveLength(1)
    }
  )

  it('keeps the older host acquisition wait outside the send deadline', async () => {
    const create = deferred<unknown>()
    mocks.supports.mockResolvedValue(false)
    mocks.call.mockReturnValue(create.promise)
    const launch = start()
    mocks.inventory.mockResolvedValue([
      { worktree: 'workspace-1', tabs: [{ type: 'agent-session', sessionId: launch.sessionId }] }
    ])
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(45_000)
    expect(draft(launch.sessionId)).toBe('')
    expect(getStructuredAgentSessionPendingSends(launch.sessionId)[0]?.phase).toBe('sending')
    mocks.call.mockImplementation(async (_target, _method, params) => {
      const send = SendParams.parse(params)
      return {
        ok: true,
        value: {
          clientMessageId: send.envelope.clientOperationId,
          submission: submission(send.envelope.clientOperationId)
        }
      }
    })
    create.resolve(created())
    await launch.launchResult
    await expect(launch.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
    expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual([
      'agentSession.create',
      'agentSession.send'
    ])
  })

  it('bounds the click even if capability negotiation has not answered', async () => {
    const support = deferred<boolean>()
    mocks.supports.mockReturnValue(support.promise)
    mocks.call.mockImplementation(async () => created())
    const launch = start()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(draft(launch.sessionId)).toBe('opening text')
    await expect(launch.promptDeliveryResult).resolves.toMatchObject({
      delivered: false,
      inComposer: true
    })
    expect(draft(launch.sessionId)).toBe('opening text')
    support.resolve(true)
    await launch.launchResult
    expect(createParams()).not.toHaveProperty('firstMessage')
    expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual(['agentSession.create'])
    expect(draft(launch.sessionId)).toBe('opening text')
  })

  it('keeps the same first-message intent when the paired host reports its seed', async () => {
    mocks.admit.mockResolvedValue({ kind: 'admitted', seedOptions: { model: 'host-default' } })
    mocks.call.mockImplementation(async () => created())
    const launch = startStructuredAgentLaunch('workspace-1', 'codex', {
      requestId: newAgentLaunchRequestId(),
      executionHostId: 'runtime:server-1',
      prompt: 'opening text'
    })
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    expect(createParams().firstMessage?.body.blocks).toEqual([
      { type: 'text', text: 'opening text' }
    ])
    await launch.launchResult
    await expect(launch.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
    expect(mocks.call).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'server-1' },
      'agentSession.create',
      expect.objectContaining({
        firstMessage: expect.any(Object),
        options: { model: 'host-default' }
      }),
      undefined
    )
    expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual(['agentSession.create'])
    expect(
      getStructuredAgentSessionReadOwner(launch.sessionId, {
        kind: 'environment',
        environmentId: 'server-1'
      }).getSnapshot().state.fence
    ).toBe(1)
    expect(
      getStructuredAgentSessionReadOwner(launch.sessionId, target).getSnapshot().state.fence
    ).toBeNull()
  })

  it('publishes while a later option write still waits for the agent', async () => {
    const create = deferred<unknown>()
    const option = deferred<unknown>()
    mocks.call.mockImplementation((_target, method) =>
      method === 'agentSession.setOption' ? option.promise : create.promise
    )
    const launch = start()
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    holdStructuredAgentSessionLaunchOption(launch.sessionId, 'model', 'later-pick')
    create.resolve(created())
    let published = false
    void launch.launchResult.then(() => {
      published = true
    })
    await vi.waitFor(() => expect(published).toBe(true))
    await launch.launchResult
    await expect(launch.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
    expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual([
      'agentSession.create',
      'agentSession.setOption'
    ])
    option.resolve({ ok: true, value: { selected: 'later-pick' } })
  })

  it('retains a reload outside history until explicit Retry replays the frozen create', async () => {
    const create = deferred<unknown>()
    mocks.call.mockReturnValue(create.promise)
    mocks.supportsMode.mockResolvedValue(false)
    const launch = startStructuredAgentLaunch('workspace-1', 'codex', {
      requestId: newAgentLaunchRequestId(),
      executionHostId: 'local',
      prompt: 'opening text',
      launchOptions: { model: 'gpt-5.6-sol' }
    })
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    const original = createParams()
    expect(original.optionsMode).toBeUndefined()
    expect(original.options?.effort).toBe('medium')
    expect(readStructuredAgentLaunchRecord(launch.sessionId)?.explicitLaunchOptions).toEqual({
      model: 'gpt-5.6-sol'
    })
    mocks.supportsMode.mockResolvedValue(true)
    expect(readStructuredAgentLaunchRecord(launch.sessionId)?.firstMessage).toEqual(
      original.firstMessage
    )
    const originalRecord = readStructuredAgentLaunchRecord(launch.sessionId)
    const response = created()
    const receipt = response.value.page.submissions[0]
    response.value.page.submissions = []
    resetStructuredAgentLaunchRegistryForTests()
    resetStructuredAgentLaunchPersistenceForTests()
    resetStructuredAgentSessionSendsForTests()
    mocks.inventory.mockResolvedValue([
      { worktree: 'workspace-1', tabs: [{ type: 'agent-session', sessionId: launch.sessionId }] }
    ])
    mocks.call.mockImplementation(async (_target, method) => {
      if (method === 'agentSession.history') {
        return { ok: true, page: response.value.page }
      }
      if (method === 'agentSession.create') {
        return { ...response, replayed: true, value: { ...response.value, firstMessage: receipt } }
      }
      throw new Error(`Unexpected mutation during opening-message recovery: ${method}`)
    })
    markStructuredAgentSessionLaunchPublished('workspace-1', launch.sessionId, 'local')
    await vi.waitFor(() =>
      expect(
        mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.history')
      ).toHaveLength(1)
    )
    const restored = getStructuredLaunchStateBySessionId(launch.sessionId)
    if (!restored) {
      throw new Error('Expected publication to retain the unconfirmed launch')
    }
    await expect(restored.promise).rejects.toBeInstanceOf(Error)
    expect(getStructuredAgentSessionLaunchLifecycle('workspace-1', launch.sessionId)).toBe(
      'visibility-unknown'
    )
    expect(readStructuredAgentLaunchRecord(launch.sessionId)).toEqual({
      ...originalRecord,
      lifecycle: 'visibility-unknown'
    })
    expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual([
      'agentSession.create',
      'agentSession.history'
    ])

    expect(retryStructuredAgentSessionLaunch('workspace-1', launch.sessionId)).toBe(true)
    await expect(restored.promise).resolves.toMatchObject({ sessionId: launch.sessionId, fence: 1 })
    await vi.waitFor(() =>
      expect(readStructuredAgentLaunchRecord(launch.sessionId)).toBeUndefined()
    )
    const creates = mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.create')
    expect(creates).toHaveLength(2)
    expect(creates[1]?.[2]).toEqual(original)
    expect(mocks.supports).toHaveBeenCalledOnce()
    expect(mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.send')).toEqual([])
    expect(draft(launch.sessionId)).toBe('')
  })

  it('allows Retry after the deadline while the original create never answers', async () => {
    const create = deferred<unknown>()
    mocks.call.mockReturnValue(create.promise)
    const launch = start()
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    const original = createParams()
    await vi.advanceTimersByTimeAsync(30_000)
    await launch.promptDeliveryResult
    mocks.inventory.mockResolvedValue([])
    mocks.call.mockImplementation(async () => created())
    expect(retryStructuredAgentSessionLaunch('workspace-1', launch.sessionId)).toBe(true)
    await vi.waitFor(() =>
      expect(readStructuredAgentLaunchRecord(launch.sessionId)).toBeUndefined()
    )
    const creates = mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.create')
    expect(creates).toHaveLength(2)
    expect(creates[1]?.[2]).toEqual(original)
    expect(mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.send')).toEqual([])
    expect(draft(launch.sessionId)).toBe('opening text')
  })

  it.each([
    // A window-owned build leaves a cancellation record; this machine's host closes the chat itself.
    ['a window-owned', false, ['agentSession.create']],
    ['a layout-owner', true, ['agentSession.close', 'agentSession.create']]
  ])(
    'does not revive a closed conversation reader when create replies late, in %s build',
    async (_build, isMain, methods) => {
      layoutOwner.isMain = isMain
      const create = deferred<unknown>()
      mocks.call.mockImplementation((_target, method) =>
        method === 'agentSession.create' ? create.promise : Promise.resolve({})
      )
      const launch = start()
      await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
      expect(cancelStructuredAgentLaunch('workspace-1', launch.sessionId)).toBe(true)
      create.resolve(created())
      await expect(launch.launchResult).rejects.toThrow('structured session launch cancelled')
      expect(findStructuredAgentSessionReadOwner(launch.sessionId, target)).toBeUndefined()
      expect(mocks.call.mock.calls.map(([, method]) => method).sort()).toEqual(methods)
    }
  )

  it('keeps Retry actionable when a published tab starts an unanswered message confirmation', async () => {
    mocks.call.mockReturnValue(new Promise(() => {}))
    const launch = start()
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(30_000)
    await launch.promptDeliveryResult
    mocks.inventory.mockResolvedValue([
      {
        worktree: 'workspace-1',
        tabs: [{ type: 'agent-session', sessionId: launch.sessionId }]
      }
    ])
    expect(
      markStructuredAgentSessionLaunchPublished('workspace-1', launch.sessionId, 'local')
    ).toBe(false)
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(getStructuredAgentSessionLaunchLifecycle('workspace-1', launch.sessionId)).toBe(
      'visibility-unknown'
    )
    expect(draft(launch.sessionId)).toBe('opening text')
    mocks.inventory.mockResolvedValue([])
    mocks.call.mockImplementation(async () => created())
    expect(retryStructuredAgentSessionLaunch('workspace-1', launch.sessionId)).toBe(true)
    await vi.waitFor(() =>
      expect(readStructuredAgentLaunchRecord(launch.sessionId)).toBeUndefined()
    )
    expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual([
      'agentSession.create',
      'agentSession.history',
      'agentSession.create'
    ])
    expect(draft(launch.sessionId)).toBe('opening text')
  })

  it.each(['create', 'history'] as const)(
    'offers Retry again when a second %s attempt never answers, without returning text twice',
    async (method) => {
      mocks.call.mockReturnValue(new Promise(() => {}))
      const launch = start()
      await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
      const original = createParams()
      await vi.advanceTimersByTimeAsync(30_000)
      await launch.promptDeliveryResult
      mocks.inventory.mockResolvedValue(
        method === 'create'
          ? []
          : [
              {
                worktree: 'workspace-1',
                tabs: [{ type: 'agent-session', sessionId: launch.sessionId }]
              }
            ]
      )
      expect(retryStructuredAgentSessionLaunch('workspace-1', launch.sessionId)).toBe(true)
      await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
      await vi.advanceTimersByTimeAsync(30_000)
      expect(getStructuredAgentSessionLaunchLifecycle('workspace-1', launch.sessionId)).toBe(
        'visibility-unknown'
      )
      expect(draft(launch.sessionId)).toBe('opening text')
      mocks.call.mockImplementation(async () =>
        method === 'history' ? { ok: true, page: created().value.page } : created()
      )
      expect(retryStructuredAgentSessionLaunch('workspace-1', launch.sessionId)).toBe(true)
      await vi.waitFor(() =>
        expect(readStructuredAgentLaunchRecord(launch.sessionId)).toBeUndefined()
      )
      expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual([
        'agentSession.create',
        `agentSession.${method}`,
        `agentSession.${method}`
      ])
      expect(
        mocks.call.mock.calls
          .filter(([, name]) => name === 'agentSession.create')
          .map(([, , params]) => params)
      ).toEqual(method === 'create' ? [original, original, original] : [original])
      expect(draft(launch.sessionId)).toBe('opening text')
    }
  )
})
