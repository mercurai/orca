// @vitest-environment happy-dom
import {
  mocks,
  resetCreateMessageFixture,
  cleanupCreateMessageFixture,
  createParams,
  submission,
  created,
  target
} from './structured-agent-session-launch-create-message.test-fixture'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SendParams } from '../../../shared/rpc-contract/structured-agent-session-params'
import { startStructuredAgentLaunch } from './agent-session/launch/structured-agent-session-launch'
import {
  getStructuredAgentSessionLaunchHeldOptions,
  holdStructuredAgentSessionLaunchOption
} from './agent-session/launch/structured-agent-session-launch-options'
import {
  recordHostModelCatalogSnapshot,
  resetHostModelCatalogSnapshotsForTests
} from '@/runtime/host-model-catalog-snapshots'
import { getStructuredLaunchStateBySessionId } from './agent-session/launch/structured-agent-session-launch-registry'
import { readStructuredAgentLaunchRecord } from './agent-session/launch/structured-agent-session-launch-persistence'
import { newAgentLaunchRequestId } from './agent-launch-request-id'

let restoreCatalogStore: (() => void) | undefined

describe('create launch options and saved selections', () => {
  beforeEach(() => {
    restoreCatalogStore = resetCreateMessageFixture()
  })
  afterEach(() => {
    cleanupCreateMessageFixture(restoreCatalogStore)
  })

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
        expect(getStructuredAgentSessionLaunchHeldOptions(launch.sessionId)).toEqual({})
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

  it.each([
    { createMessage: true, savedTier: 'default' },
    { createMessage: true, savedTier: undefined },
    { createMessage: false, savedTier: 'default' },
    { createMessage: false, savedTier: undefined }
  ])(
    'keeps an unlisted saved model for tier-only Standard (create-message=$createMessage, saved-tier=$savedTier)',
    async ({ createMessage, savedTier }) => {
      const savedModel = 'synthetic-saved-model-not-listed'
      const listedDefault = 'synthetic-different-catalog-default'
      const priorSettings = mocks.settings
      mocks.settings = {
        nativeChatSessionOptions: {
          codex: {
            model: savedModel,
            ...(savedTier === undefined
              ? {}
              : { valuesByModel: { [savedModel]: { serviceTier: savedTier } } })
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
          fetchedAt: 1,
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
          ...(savedTier === undefined ? {} : { serviceTier: savedTier })
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
        fetchedAt: 1,
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
