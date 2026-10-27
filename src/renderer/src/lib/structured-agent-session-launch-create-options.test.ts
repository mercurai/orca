// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CreateIntentParams,
  SendParams
} from '../../../shared/rpc-contract/structured-agent-session-params'
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

import { startStructuredAgentLaunch } from './structured-agent-session-launch'
import { holdStructuredAgentSessionLaunchOption } from './structured-agent-session-launch-options'
import {
  recordHostModelCatalogSnapshot,
  resetHostModelCatalogSnapshotsForTests
} from '@/runtime/host-model-catalog-snapshots'
import { getStructuredLaunchStateBySessionId } from './agent-session/launch/structured-agent-session-launch-registry'
import { readStructuredAgentLaunchRecord } from './agent-session/launch/structured-agent-session-launch-persistence'
import { newAgentLaunchRequestId } from './agent-launch-request-id'
import {
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

describe('create launch options and saved selections', () => {
  beforeEach(() => {
    layoutOwner.isMain = false
    resetCreateMessageTestState(mocks)
  })
  afterEach(disposeCreateMessageTestState)

  it.each(['codex', 'claude'] as const)(
    'creates %s on an unlisted explicit model without importing saved effort',
    async (agent) => {
      mocks.settings = {
        nativeChatSessionOptions: {
          [agent]: { model: 'saved-model', valuesByModel: { 'saved-model': { effort: 'low' } } }
        }
      }
      mocks.call.mockImplementation(async () => created())
      try {
        const launch = startStructuredAgentLaunch('workspace-1', agent, {
          requestId: newAgentLaunchRequestId(),
          executionHostId: 'local',
          prompt: 'opening text',
          launchOptions: { model: 'unlisted-action-model' }
        })
        expect(readStructuredAgentLaunchRecord(launch.sessionId)?.explicitLaunchOptions).toEqual({
          model: 'unlisted-action-model'
        })
        expect(getStructuredLaunchStateBySessionId(launch.sessionId)?.selection.held).toEqual({})
        await launch.launchResult
        expect(createParams().optionsMode).toBe('replace-model-selection')
        expect(createParams().options).toEqual({
          model: 'unlisted-action-model',
          permissionMode: 'ask'
        })
      } finally {
        mocks.settings = {}
      }
    }
  )

  it.each([
    ['a permission-only action leaves the remembered model', undefined, undefined],
    [
      'a model picked during launch keeps the action mode',
      'picked-model',
      'replace-model-selection'
    ]
  ])('%s', async (_name, picked, optionsMode) => {
    mocks.call.mockImplementation(async () => created())
    const launch = startStructuredAgentLaunch('workspace-1', 'codex', {
      requestId: newAgentLaunchRequestId(),
      executionHostId: 'local',
      prompt: 'opening text',
      launchOptions: picked
        ? { model: 'action-model', effort: 'high', permissionMode: 'full-access' }
        : { permissionMode: 'full-access' }
    })
    if (picked) {
      holdStructuredAgentSessionLaunchOption(launch.sessionId, 'model', picked)
    }
    await launch.launchResult
    expect(createParams().optionsMode).toBe(optionsMode)
    expect(createParams().options).toEqual({
      permissionMode: 'full-access',
      ...(picked ? { model: picked } : {})
    })
  })

  it.each([true, false])(
    'keeps an unlisted saved model above the catalog default for tier-only Standard (create-message=%s)',
    async (createMessage) => {
      const savedModel = 'synthetic-saved-model-not-listed'
      const listedDefault = 'synthetic-different-catalog-default'
      const priorSettings = mocks.settings
      mocks.settings = {
        nativeChatSessionOptions: {
          codex: {
            model: savedModel,
            valuesByModel: { [savedModel]: { serviceTier: 'default' } }
          }
        }
      }
      resetHostModelCatalogSnapshotsForTests()
      mocks.supports.mockResolvedValue(createMessage)
      mocks.call.mockImplementation(async (_target, method, params) => {
        if (method === 'agentSession.create') {
          return created()
        }
        if (
          method === 'agentSession.setOption' &&
          params &&
          typeof params === 'object' &&
          'key' in params &&
          typeof params.key === 'string' &&
          'value' in params
        ) {
          return { ok: true, value: { options: { model: savedModel, [params.key]: params.value } } }
        }
        const send = SendParams.parse(params)
        const clientMessageId = send.envelope.clientOperationId
        return { ok: true, value: { clientMessageId, submission: submission(clientMessageId) } }
      })
      try {
        recordHostModelCatalogSnapshot(target, 'codex', null, {
          origin: 'probe',
          catalogState: 'available',
          fetchedAt: Date.now(),
          listingNamesConfiguredModel: true,
          defaultHoldsInEveryWorkspace: true,
          models: [
            {
              id: listedDefault,
              label: listedDefault,
              isDefault: true,
              efforts: [],
              serviceTiers: [{ value: 'default', label: 'Standard' }]
            }
          ]
        })
        const launch = startStructuredAgentLaunch('workspace-1', 'codex', {
          requestId: newAgentLaunchRequestId(),
          executionHostId: 'local',
          prompt: 'opening text',
          launchOptions: { serviceTier: 'default' }
        })
        expect(
          getStructuredLaunchStateBySessionId(launch.sessionId)?.intent.seedOptions
        ).toMatchObject({
          model: savedModel,
          serviceTier: 'default'
        })
        mocks.inventory.mockResolvedValue([
          {
            worktree: 'workspace-1',
            tabs: [{ type: 'agent-session', sessionId: launch.sessionId }]
          }
        ])
        await launch.launchResult
        await expect(launch.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
        if (createMessage) {
          expect(createParams().options).toMatchObject({
            model: savedModel,
            serviceTier: 'default'
          })
          expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual(['agentSession.create'])
        } else {
          expect(createParams().options).toBeUndefined()
          const writes = mocks.call.mock.calls.filter(
            ([, method]) => method === 'agentSession.setOption'
          )
          expect(writes.map(([, , params]) => params)).toEqual([
            expect.objectContaining({ key: 'serviceTier', value: 'default' })
          ])
          const calls = mocks.call.mock.calls.map(([, method]) => method)
          expect(calls.indexOf('agentSession.setOption')).toBeLessThan(
            calls.indexOf('agentSession.send')
          )
        }
      } finally {
        mocks.settings = priorSettings
        resetHostModelCatalogSnapshotsForTests()
      }
    }
  )

  it.each([
    { host: 'modern', createMessage: true, saved: 'paid-speed-request-17', requested: 'default' },
    { host: 'modern', createMessage: true, saved: 'default', requested: 'paid-speed-request-17' },
    { host: 'legacy', createMessage: false, saved: 'paid-speed-request-17', requested: 'default' },
    { host: 'legacy', createMessage: false, saved: 'default', requested: 'paid-speed-request-17' }
  ])(
    '$host opening message uses tier-only explicit $requested above saved $saved',
    async ({ createMessage, saved, requested }) => {
      const model = 'synthetic-tier-only-model'
      const priorSettings = mocks.settings
      mocks.settings = {
        nativeChatSessionOptions: {
          codex: { model, valuesByModel: { [model]: { serviceTier: saved } } }
        }
      }
      resetHostModelCatalogSnapshotsForTests()
      recordHostModelCatalogSnapshot(target, 'codex', null, {
        origin: 'probe',
        catalogState: 'available',
        fetchedAt: Date.now(),
        listingNamesConfiguredModel: true,
        defaultHoldsInEveryWorkspace: true,
        models: [
          {
            id: model,
            label: model,
            isDefault: true,
            efforts: [],
            serviceTiers: [{ value: 'paid-speed-request-17', label: 'Fast' }]
          }
        ]
      })
      mocks.supports.mockResolvedValue(createMessage)
      mocks.call.mockImplementation(async (_target, method, params) => {
        if (method === 'agentSession.create') {
          return created()
        }
        if (
          method === 'agentSession.setOption' &&
          params &&
          typeof params === 'object' &&
          'key' in params &&
          typeof params.key === 'string' &&
          'value' in params
        ) {
          return { ok: true, value: { options: { model, [params.key]: params.value } } }
        }
        const send = SendParams.parse(params)
        const clientMessageId = send.envelope.clientOperationId
        return { ok: true, value: { clientMessageId, submission: submission(clientMessageId) } }
      })
      try {
        const launch = startStructuredAgentLaunch('workspace-1', 'codex', {
          requestId: newAgentLaunchRequestId(),
          executionHostId: 'local',
          prompt: 'opening text',
          launchOptions: { serviceTier: requested }
        })
        mocks.inventory.mockResolvedValue([
          {
            worktree: 'workspace-1',
            tabs: [{ type: 'agent-session', sessionId: launch.sessionId }]
          }
        ])
        await launch.launchResult
        await expect(launch.promptDeliveryResult).resolves.toMatchObject({ delivered: true })
        if (createMessage) {
          expect(createParams().firstMessage?.body.blocks).toEqual([
            { type: 'text', text: 'opening text' }
          ])
          expect(createParams().options).toMatchObject({ model, serviceTier: requested })
          expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual(['agentSession.create'])
        } else {
          expect(createParams().firstMessage).toBeUndefined()
          expect(createParams().options).toBeUndefined()
          const writes = mocks.call.mock.calls.filter(
            ([, method]) => method === 'agentSession.setOption'
          )
          expect(writes.map(([, , params]) => params)).toEqual([
            expect.objectContaining({ key: 'serviceTier', value: requested })
          ])
          const calls = mocks.call.mock.calls.map(([, method]) => method)
          expect(calls.indexOf('agentSession.setOption')).toBeLessThan(
            calls.indexOf('agentSession.send')
          )
          expect(
            SendParams.parse(
              mocks.call.mock.calls.find(([, method]) => method === 'agentSession.send')?.[2]
            ).body.blocks
          ).toEqual([{ type: 'text', text: 'opening text' }])
        }
      } finally {
        mocks.settings = priorSettings
        resetHostModelCatalogSnapshotsForTests()
      }
    }
  )
})
