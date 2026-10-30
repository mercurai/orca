import { describe, expect, it, vi } from 'vitest'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { optionSession } from './codex-structured-option-session.test-fixture'
import { CodexAppliedSettings } from './codex-structured-applied-settings'
import {
  readCodexAppliedInputOptions,
  resolvedCodexMessageOptions
} from './codex-structured-message-options'
import { applyCodexStructuredSessionOption } from './codex-structured-session-options'
import { dispatchCodexTurn, startCodexTurn } from './codex-structured-turn-start'
import { CodexAppServerRequestError } from './app-server/codex-app-server-request-error'
import type { CodexSession } from './codex-structured-session-state'
import {
  acquireReadyCodexForTest,
  USER_MESSAGE,
  adapterFor,
  fakeCodex,
  identityFor
} from './codex-structured-session-adapter-fixture'

function seedMessageDefaults(session: CodexSession): void {
  const store = new AgentModelCatalogStore()
  const fingerprint = 'codex-message-defaults'
  store.recordSuccess(
    fingerprint,
    'codex',
    {
      origin: 'probe',
      models: [
        {
          id: 'model-a',
          label: 'Model A',
          isDefault: false,
          defaultEffort: 'low',
          serviceTiers: [
            { value: 'priority', label: 'Priority' },
            { value: 'flex', label: 'Flex' }
          ],
          efforts: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' }
          ]
        },
        {
          id: 'model-b',
          label: 'Model B',
          serviceTiers: [{ value: 'flex', label: 'Flex' }],
          isDefault: true,
          defaultEffort: 'medium',
          efforts: [
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' }
          ]
        }
      ]
    },
    'discovery'
  )
  session.catalogAccess = { store, fingerprint, accountHomePath: '/test-account' }
}

describe('Codex captured message choices', () => {
  it('tracks a model re-request after an effort readback retires the generic write', () => {
    const settings = new CodexAppliedSettings()
    settings.observe({ model: 'model-a', effort: 'low' })
    settings.attempt({ model: 'model-b', effort: 'high' })
    settings.observe({ model: 'model-a', effort: 'high' })
    settings.attempt({ model: 'model-a' })
    settings.observe({ model: 'model-b', effort: 'high' })
    expect(settings.knownModel()).toBeUndefined()
    settings.observe({ model: 'model-a', effort: 'high' })
    expect(settings.knownModel()).toBe('model-a')
  })

  it('retains an older pending model when a re-request is refused', () => {
    const settings = new CodexAppliedSettings()
    settings.observe({ model: 'model-a', effort: 'low' })
    settings.attempt({ model: 'model-b', effort: 'high' })
    settings.observe({ model: 'model-a', effort: 'high' })
    const refuseA = settings.attempt({ model: 'model-a' })
    refuseA()
    expect(settings.knownModel()).toBeUndefined()
    settings.observe({ model: 'model-b', effort: 'high' })
    expect(settings.knownModel()).toBe('model-b')
  })

  it('does not use an applied model while a model settings write is pending', async () => {
    const session = optionSession(vi.fn(async () => ({ turn: { id: 'confirmed' } })))
    seedMessageDefaults(session)
    session.reportedOptions = { model: 'model-a' }
    session.appliedTurnOptions = { model: 'model-a' }
    session.appliedSettings = new CodexAppliedSettings()
    session.appliedSettings.observe({ model: 'model-a', effort: 'low' })
    session.appliedSettings.attempt({ model: 'model-b' })
    session.appliedSettings.observe({ effort: 'high' })
    await expect(
      startCodexTurn(session, {
        clientMessageId: 'pending-model',
        body: USER_MESSAGE,
        turnOptions: { serviceTier: 'priority' }
      })
    ).rejects.toMatchObject({ kind: 'speedSupportUnknown' })
    expect(session.connection.request).not.toHaveBeenCalled()
    session.appliedSettings.observe({ model: 'model-b' })
    await expect(
      startCodexTurn(session, {
        clientMessageId: 'readback-model',
        body: USER_MESSAGE,
        turnOptions: { serviceTier: 'priority' }
      })
    ).rejects.toMatchObject({ kind: 'speedUnavailable' })
    expect(session.connection.request).not.toHaveBeenCalled()
  })

  it('keeps model unknown through overlapping writes until readback passes them', () => {
    const settings = new CodexAppliedSettings()
    settings.observe({ model: 'model-a' })
    settings.attempt({ model: 'model-b' })
    settings.attempt({ model: 'model-c' })
    settings.observe({ model: 'model-a' })
    expect(settings.knownModel()).toBeUndefined()
    settings.observe({ model: 'model-b' })
    expect(settings.knownModel()).toBeUndefined()
    settings.observe({ model: 'model-c' })
    expect(settings.knownModel()).toBe('model-c')
  })

  it('does not retire an older unknown model write on a later model readback', () => {
    const settings = new CodexAppliedSettings()
    settings.observe({ model: 'model-a' })
    settings.attempt({ model: 'model-b' })
    settings.attempt({ model: 'model-c' })
    settings.observe({ model: 'model-c' })
    expect(settings.knownModel()).toBeUndefined()
    settings.observe({ model: 'model-b' })
    expect(settings.knownModel()).toBe('model-b')
  })

  it('restores model knowledge after a known refusal but not an unresolved older write', () => {
    const settings = new CodexAppliedSettings()
    settings.observe({ model: 'model-a' })
    const rejectB = settings.attempt({ model: 'model-b' })
    const rejectC = settings.attempt({ model: 'model-c' })
    rejectC()
    expect(settings.knownModel()).toBeUndefined()
    rejectB()
    expect(settings.knownModel()).toBe('model-a')
  })

  it.each(['tier-only', 'explicit-a', 'explicit-b', 'readback-b'] as const)(
    'checks the model after an uncertain change: %s',
    async (scenario) => {
      const request = vi.fn(async () => {
        if (request.mock.calls.length === 1) throw new Error('delivery unknown')
        return { turn: { id: 'confirmed' } }
      })
      const session = optionSession(request)
      seedMessageDefaults(session)
      session.reportedOptions = { model: 'model-a' }
      session.appliedTurnOptions = { model: 'model-a' }
      session.appliedSettings = new CodexAppliedSettings()
      session.appliedSettings.observe({ model: 'model-a' })
      await expect(
        startCodexTurn(session, {
          clientMessageId: 'model-unknown',
          body: USER_MESSAGE,
          turnOptions: { model: 'model-b' }
        })
      ).rejects.toThrow('delivery unknown')
      expect(session.appliedTurnOptions).not.toHaveProperty('model')
      if (scenario === 'readback-b') session.appliedSettings.observe({ model: 'model-b' })
      const model =
        scenario === 'explicit-a' ? 'model-a' : scenario === 'explicit-b' ? 'model-b' : undefined
      const attempt = startCodexTurn(session, {
        clientMessageId: 'tier-attempt',
        body: USER_MESSAGE,
        turnOptions: { ...(model ? { model } : {}), serviceTier: 'priority' }
      })
      if (scenario === 'explicit-a') {
        await expect(attempt).resolves.toMatchObject({ via: 'start' })
        expect(request.mock.calls).toHaveLength(2)
      } else {
        await expect(attempt).rejects.toMatchObject({
          kind: scenario === 'tier-only' ? 'speedSupportUnknown' : 'speedUnavailable'
        })
        expect(request.mock.calls).toHaveLength(1)
      }
    }
  )

  it.each(['accepted', 'not delivered'] as const)(
    'keeps a tier request unconfirmed when delivery is unknown: %s',
    async () => {
      const session = optionSession(
        vi.fn(async () => {
          throw new Error('transport lost')
        })
      )
      seedMessageDefaults(session)
      session.reportedOptions.model = 'model-a'
      session.options = new Map([
        ['model', 'model-a'],
        ['serviceTier', 'priority']
      ])
      session.appliedTurnOptions = { model: 'model-a', serviceTier: 'flex', effort: 'low' }
      await expect(
        startCodexTurn(session, {
          clientMessageId: 'unknown-tier',
          body: USER_MESSAGE,
          turnOptions: { serviceTier: 'priority' }
        })
      ).rejects.toThrow('transport lost')
      expect(Object.fromEntries(session.options)).toMatchObject({
        model: 'model-a',
        serviceTier: 'priority'
      })
      expect(session.appliedTurnOptions).toEqual({ model: 'model-a', effort: 'low' })
      expect(session.speedApplied).toBeUndefined()
    }
  )

  it('keeps unknown active tier absent in a later comparison', async () => {
    const session = optionSession(
      vi.fn(async () => {
        throw new Error('transport lost')
      })
    )
    seedMessageDefaults(session)
    session.reportedOptions.model = 'model-a'
    session.options = new Map([
      ['model', 'model-a'],
      ['serviceTier', 'priority']
    ])
    session.appliedTurnOptions = { model: 'model-a', serviceTier: 'flex' }
    await expect(
      startCodexTurn(session, {
        clientMessageId: 'unknown-compare',
        body: USER_MESSAGE,
        turnOptions: { serviceTier: 'priority' }
      })
    ).rejects.toThrow('transport lost')
    const comparison = readCodexAppliedInputOptions(session, {
      sessionId: 'session-1',
      fence: session.fence,
      acquisitionGeneration: session.acquisitionGeneration,
      next: { serviceTier: 'priority' }
    })
    expect(comparison?.active).not.toHaveProperty('serviceTier')
    expect(comparison?.next.serviceTier).toBe('priority')
  })

  it('preserves saved speed without claiming applied speed for an effort-only turn', async () => {
    const session = optionSession(vi.fn(async () => ({ turn: { id: 'effort-turn' } })))
    session.options = new Map([
      ['model', 'model-a'],
      ['serviceTier', 'priority']
    ])
    session.appliedTurnOptions = { model: 'model-a', serviceTier: 'priority' }
    session.speedApplied = { sequence: 1, tierId: 'priority', turnId: 'prior' }
    session.speedDispatchSequence = 1
    session.speedAcknowledgedSequence = 1
    await startCodexTurn(session, {
      clientMessageId: 'effort-only',
      body: USER_MESSAGE,
      turnOptions: { effort: 'high' }
    })
    expect(Object.fromEntries(session.options)).toEqual({
      model: 'model-a',
      serviceTier: 'priority',
      effort: 'high'
    })
    expect(session.appliedTurnOptions).toEqual({
      model: 'model-a',
      serviceTier: 'priority',
      effort: 'high'
    })
    expect(session.connection.request).toHaveBeenCalledWith(
      'turn/start',
      expect.not.objectContaining({ serviceTier: expect.anything() }),
      expect.anything()
    )
    expect(session.connection.request).toHaveBeenCalledWith(
      'turn/start',
      expect.not.objectContaining({ model: expect.anything() }),
      expect.anything()
    )
    expect(session.speedApplied).toBeUndefined()
  })

  it('keeps an active priority tier when only effort is captured', async () => {
    const session = optionSession(vi.fn(async () => ({ turn: { id: 'turn-effort' } })))
    session.appliedTurnOptions = { model: 'model-a', serviceTier: 'priority' }
    session.nativeDefaults = { serviceTier: 'default' }
    const options = await resolvedCodexMessageOptions(session, { effort: 'high' })
    expect(options).toEqual({ effort: 'high' })
    await startCodexTurn(session, {
      clientMessageId: 'effort-only',
      body: USER_MESSAGE,
      turnOptions: options
    })
    expect(session.connection.request).toHaveBeenCalledWith(
      'turn/start',
      expect.not.objectContaining({ serviceTier: expect.anything() }),
      expect.anything()
    )
    expect(session.connection.request).toHaveBeenCalledWith(
      'turn/start',
      expect.not.objectContaining({ model: expect.anything() }),
      expect.anything()
    )
  })

  it('keeps an active personality and effort when only model is captured', async () => {
    const session = optionSession(vi.fn(async () => ({ turn: { id: 'turn-model' } })))
    session.appliedTurnOptions = { model: 'model-a', personality: 'friendly', effort: 'high' }
    session.nativeDefaults = { personality: 'pragmatic' }
    const options = await resolvedCodexMessageOptions(session, { model: 'model-b' })
    expect(options).toEqual({ model: 'model-b' })
    await startCodexTurn(session, {
      clientMessageId: 'model-only',
      body: USER_MESSAGE,
      turnOptions: options
    })
    expect(session.connection.request).toHaveBeenCalledWith(
      'turn/start',
      expect.not.objectContaining({ personality: expect.anything() }),
      expect.anything()
    )
    expect(session.connection.request).toHaveBeenCalledWith(
      'turn/start',
      expect.not.objectContaining({ effort: expect.anything() }),
      expect.anything()
    )
  })

  it('sends an explicitly captured Standard tier', async () => {
    const session = optionSession(vi.fn(async () => ({ turn: { id: 'turn-standard' } })))
    session.appliedTurnOptions = { model: 'model-a', serviceTier: 'priority' }
    const options = await resolvedCodexMessageOptions(session, { serviceTier: 'default' })
    expect(options).toEqual({ serviceTier: 'default' })
    await startCodexTurn(session, {
      clientMessageId: 'standard',
      body: USER_MESSAGE,
      turnOptions: options
    })
    expect(session.connection.request).toHaveBeenCalledWith(
      'turn/start',
      expect.objectContaining({ serviceTier: 'default' }),
      expect.anything()
    )
  })

  it('keeps pending legacy speed distinct from the active tier in input projection', () => {
    const session = optionSession(vi.fn(async () => ({})))
    session.appliedTurnOptions = { model: 'model-a', serviceTier: 'priority' }
    const result = readCodexAppliedInputOptions(session, {
      sessionId: 'session-1',
      fence: session.fence,
      acquisitionGeneration: session.acquisitionGeneration,
      next: { fastMode: 'true' }
    })
    expect(result?.active.serviceTier).toBe('priority')
    expect(result?.next).toMatchObject({ model: 'model-a', fastMode: 'true' })
    expect(result?.next).not.toHaveProperty('serviceTier')
  })

  it.each([
    { knownCatalog: true, serviceTier: 'default' },
    { knownCatalog: false, serviceTier: 'default' },
    { knownCatalog: true, serviceTier: 'priority' },
    { knownCatalog: false, serviceTier: 'priority' }
  ])(
    'canonical $serviceTier overrides legacy Fast with catalog=$knownCatalog',
    async ({ knownCatalog, serviceTier }) => {
      const request = vi.fn(async () => ({}))
      const session = optionSession(request)
      if (knownCatalog) {
        seedMessageDefaults(session)
      }
      session.reportedOptions.model = 'model-a'
      session.nativeDefaults = { serviceTier: 'default' }

      const options = await resolvedCodexMessageOptions(session, {
        serviceTier,
        fastMode: 'true'
      })

      expect(options).toMatchObject({ serviceTier })
      expect(options).not.toHaveProperty('fastMode')
      expect(request).not.toHaveBeenCalled()
    }
  )

  it('admits and acknowledges the captured tier rather than the newer session pick', async () => {
    const request = vi.fn(async () => ({ turn: { id: 'captured-turn' } }))
    const session = optionSession(request)
    seedMessageDefaults(session)
    session.options.set('model', 'model-b')
    session.options.set('serviceTier', 'unavailable-newer-pick')
    await startCodexTurn(session, {
      clientMessageId: 'captured-speed',
      body: USER_MESSAGE,
      turnOptions: { model: 'model-a', serviceTier: 'priority' }
    })
    expect(request).toHaveBeenCalledWith(
      'turn/start',
      expect.objectContaining({
        model: 'model-a',
        serviceTier: 'priority'
      }),
      expect.anything()
    )
    expect(session.speedApplied).toMatchObject({ tierId: 'priority', turnId: 'captured-turn' })
  })

  it('refuses an unavailable captured tier without changing applied or saved options', async () => {
    const request = vi.fn(async () => ({ turn: { id: 'must-not-open' } }))
    const session = optionSession(request)
    seedMessageDefaults(session)
    session.options.set('model', 'model-a')
    session.options.set('serviceTier', 'default')
    session.appliedTurnOptions = { model: 'model-a', serviceTier: 'default' }
    await expect(
      startCodexTurn(session, {
        clientMessageId: 'unavailable-speed',
        body: USER_MESSAGE,
        turnOptions: { model: 'model-a', serviceTier: 'synthetic-ultra-not-advertised' }
      })
    ).rejects.toMatchObject({ kind: 'speedUnavailable' })
    expect(request).not.toHaveBeenCalled()
    expect(session.speedApplied).toBeUndefined()
    expect(session.appliedTurnOptions).toEqual({ model: 'model-a', serviceTier: 'default' })
    expect(Object.fromEntries(session.options)).toEqual({
      model: 'model-a',
      serviceTier: 'default'
    })
  })

  it('does not acknowledge a provider-rejected captured speed and restores the prior options', async () => {
    const request = vi.fn(async () => {
      throw new CodexAppServerRequestError('turn/start', -32602, 'tier rejected')
    })
    const session = optionSession(request)
    seedMessageDefaults(session)
    session.options.set('serviceTier', 'default')
    session.appliedTurnOptions = { serviceTier: 'default' }
    await expect(
      startCodexTurn(session, {
        clientMessageId: 'server-rejected-speed',
        body: USER_MESSAGE,
        turnOptions: { model: 'model-a', serviceTier: 'priority' }
      })
    ).rejects.toThrow('tier rejected')
    expect(session.speedApplied).toBeUndefined()
    expect(session.appliedTurnOptions).toEqual({ serviceTier: 'default' })
    expect(Object.fromEntries(session.options)).toEqual({ serviceTier: 'default' })
  })

  it.each(['picker', 'turn'] as const)(
    'keeps a newer %s selection when an older captured request is rejected',
    async (newer) => {
      const started = Promise.withResolvers<void>()
      const firstReply = Promise.withResolvers<unknown>()
      const request = vi.fn(async () => {
        if (request.mock.calls.length === 1) {
          started.resolve()
          return firstReply.promise
        }
        return { turn: { id: 'newer-turn' } }
      })
      const session = optionSession(request)
      seedMessageDefaults(session)
      session.options.set('model', 'model-a')
      session.options.set('serviceTier', 'default')
      session.appliedTurnOptions = { model: 'model-a', serviceTier: 'default' }
      const older = startCodexTurn(session, {
        clientMessageId: 'rejected-older',
        body: USER_MESSAGE,
        turnOptions: { model: 'model-a', serviceTier: 'priority' }
      })
      const rejected = expect(older).rejects.toThrow('older tier rejected')
      await started.promise
      await (newer === 'picker'
        ? applyCodexStructuredSessionOption(session, 'serviceTier', 'flex')
        : startCodexTurn(session, {
            clientMessageId: 'accepted-newer',
            body: USER_MESSAGE,
            turnOptions: { model: 'model-a', serviceTier: 'flex' }
          }))
      firstReply.reject(new CodexAppServerRequestError('turn/start', -32602, 'older tier rejected'))
      await rejected

      expect(Object.fromEntries(session.options)).toEqual({ model: 'model-a', serviceTier: 'flex' })
      expect(session.appliedTurnOptions).toEqual({
        model: 'model-a',
        serviceTier: newer === 'picker' ? 'default' : 'flex'
      })
      if (newer === 'turn') {
        expect(session.speedApplied).toMatchObject({ tierId: 'flex', turnId: 'newer-turn' })
      }
    }
  )

  it('uses each message’s choices on turn/start and tracks the native attempted choice', async () => {
    const request = vi.fn(async (_method: string, _params?: Record<string, unknown>) => ({
      turn: { id: 'turn-1' }
    }))
    const session = optionSession(request)
    seedMessageDefaults(session)
    session.reportedOptions.model = 'model-a'
    session.options.set('model', 'saved-next')
    session.options.set('effort', 'medium')
    const body = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'go' }]
    }
    for (const [id, model, effort] of [
      ['first', 'model-a', 'high'],
      ['second', 'model-b', 'medium']
    ]) {
      const turnOptions = await resolvedCodexMessageOptions(session, { model, effort })
      await startCodexTurn(session, { clientMessageId: id, body, turnOptions })
    }
    session.activeTurnIds = new Set(['turn-1'])
    await startCodexTurn(session, {
      clientMessageId: 'steer',
      body,
      turnOptions: { personality: 'friendly', serviceTier: 'priority' }
    })
    expect(request.mock.calls.at(-1)?.[0]).toBe('turn/steer')
    expect(request.mock.calls.at(-1)?.[1]).not.toHaveProperty('personality')
    expect(request.mock.calls.at(-1)?.[1]).not.toHaveProperty('serviceTier')
    expect(session.appliedTurnOptions).toEqual({ model: 'model-b', effort: 'medium' })
    session.activeTurnIds = new Set()
    await startCodexTurn(session, {
      clientMessageId: 'next',
      body,
      turnOptions: { personality: 'friendly', serviceTier: 'flex' }
    })
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({
      personality: 'friendly',
      serviceTier: 'flex'
    })
    expect(
      request.mock.calls
        .filter(([method]) => method === 'turn/start')
        .map(([, params]) => [params?.model, params?.effort])
    ).toEqual([
      ['model-a', 'high'],
      ['model-b', 'medium'],
      [undefined, undefined]
    ])
    expect(Object.fromEntries(session.options)).toEqual({
      model: 'model-b',
      effort: 'medium',
      personality: 'friendly',
      serviceTier: 'flex'
    })
  })

  it('sends saved literal model and effort after the installed choices change', async () => {
    const request = vi.fn(async (_method: string, _params?: Record<string, unknown>) => ({
      turn: { id: 'turn-1' }
    }))
    const session = optionSession(request)
    seedMessageDefaults(session)
    for (const model of ['model-b', 'retired-model']) {
      session.activeTurnIds = new Set()
      const turnOptions = await resolvedCodexMessageOptions(session, { model, effort: 'low' })
      await startCodexTurn(session, { clientMessageId: model, body: USER_MESSAGE, turnOptions })
      expect(request.mock.calls.at(-1)?.[0]).toBe('turn/start')
      expect(request.mock.calls.at(-1)?.[1]).toMatchObject({ model, effort: 'low' })
    }
  })

  it('keeps captured omissions sparse after an earlier explicit override', async () => {
    const request = vi.fn(async (method: string, _params?: Record<string, unknown>) =>
      method === 'turn/start'
        ? { turn: { id: 'opened' } }
        : { config: { personality: 'pragmatic', service_tier: 'flex' } }
    )
    const session = optionSession(request)
    session.reportedOptions = {
      model: 'model-a',
      effort: 'high',
      serviceTier: 'flex',
      serviceTierKnown: true
    }
    session.options = new Map([
      ['model', 'model-a'],
      ['effort', 'high'],
      ['personality', 'friendly'],
      ['serviceTier', 'priority']
    ])
    seedMessageDefaults(session)
    const body = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'go' }]
    }

    for (const [id, choices] of [
      [
        'first',
        { model: 'model-a', effort: 'high', personality: 'friendly', serviceTier: 'priority' }
      ],
      ['second', {}],
      ['third', { model: 'model-a' }],
      ['fourth', { effort: 'low' }]
    ] as const) {
      const turnOptions = await resolvedCodexMessageOptions(session, choices)
      await startCodexTurn(session, { clientMessageId: id, body, turnOptions })
    }

    expect(
      request.mock.calls.filter(([method]) => method === 'turn/start').map(([, params]) => params)
    ).toMatchObject([
      { model: 'model-a', effort: 'high', personality: 'friendly', serviceTier: 'priority' },
      {},
      { model: 'model-a' },
      { effort: 'low' }
    ])
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'turn/start',
      'turn/start',
      'turn/start',
      'turn/start'
    ])
    expect(Object.fromEntries(session.options)).toEqual({
      model: 'model-a',
      effort: 'low',
      personality: 'friendly',
      serviceTier: 'priority'
    })
  })

  it('retains legacy Fast until the execution model catalog can resolve it', async () => {
    const request = vi.fn(async () => ({ turn: { id: 'turn-fast' } }))
    const session = optionSession(request)
    const pending = await resolvedCodexMessageOptions(session, { fastMode: 'true' })
    expect(pending).toEqual({ fastMode: 'true' })
    await expect(
      startCodexTurn(session, {
        clientMessageId: 'legacy',
        body: USER_MESSAGE,
        turnOptions: pending
      })
    ).rejects.toMatchObject({ kind: 'speedSupportUnknown' })
    expect(request).not.toHaveBeenCalled()
    const explicit = await resolvedCodexMessageOptions(session, {
      fastMode: 'true',
      serviceTier: 'default'
    })
    expect(explicit).toEqual({ serviceTier: 'default' })
  })

  it('reports what a turn ran: its thread effort, and a steer its turn', async () => {
    const request = vi.fn(async (method: string, _params?: Record<string, unknown>) =>
      method === 'turn/steer' ? { turnId: 'turn-1' } : { turn: { id: 'turn-1' } }
    )
    const session = optionSession(request)
    session.reportedOptions = { model: 'model-a', effort: 'xhigh' }
    session.appliedTurnOptions = { model: 'model-a', effort: 'low' }
    seedMessageDefaults(session)
    const send = async (id: string, choices: Record<string, string>) =>
      dispatchCodexTurn(
        session,
        {
          sessionId: 'session-1',
          clientMessageId: id,
          body: USER_MESSAGE,
          turnOptions: await resolvedCodexMessageOptions(session, choices)
        },
        undefined
      )
    const ran = { model: 'model-a', effort: 'low' }
    expect(await send('first', { model: 'model-a' })).toMatchObject({ ranOptions: ran })
    expect(request.mock.calls[0]?.[1]).toMatchObject({ model: 'model-a' })
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty('effort')
    session.activeTurnIds = new Set(['turn-1'])
    const steered = await send('steer', { model: 'model-a', serviceTier: 'priority' })
    expect(request.mock.calls.at(-1)?.[0]).toBe('turn/steer')
    expect(steered).toMatchObject({ ranOptions: ran })
    expect(steered).not.toHaveProperty('ranOptions.serviceTier')
  })

  it('inherits untouched native tier and personality without a configuration probe', async () => {
    const request = vi.fn(async (_method: string, _params?: Record<string, unknown>) => ({
      turn: { id: 'native' }
    }))
    const session = optionSession(request)
    session.reportedOptions = { model: 'model-a', serviceTier: 'flex', serviceTierKnown: true }
    const turnOptions = await resolvedCodexMessageOptions(session, {})
    await startCodexTurn(session, { clientMessageId: 'native', body: USER_MESSAGE, turnOptions })
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0]?.[0]).toBe('turn/start')
    expect(turnOptions).toEqual({})
  })

  it('opens from the first captured model even when launch resolution saw a newer saved pick', async () => {
    const codex = fakeCodex({ 'turn/start': () => ({ turn: { id: 'opened' } }) })
    const adapter = adapterFor(codex, { model: 'model-b' })
    await acquireReadyCodexForTest(adapter, {
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-1',
      options: { model: 'model-a', effort: 'high' }
    })
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'first',
      body: USER_MESSAGE,
      executionOptions: { model: 'model-a', effort: 'high' },
      fence: 7
    })
    expect(
      codex.connections[0]?.calls.find((call) => call.method === 'thread/start')?.params
    ).toMatchObject({ model: 'model-a' })
    expect(
      codex.connections[0]?.calls.find((call) => call.method === 'turn/start')?.params
    ).toMatchObject({ model: 'model-a', effort: 'high' })
  })

  it('preserves the old host path when no message snapshot was supplied', async () => {
    const request = vi.fn(async (_method: string, _params?: Record<string, unknown>) => ({
      turn: { id: 'legacy' }
    }))
    const session = optionSession(request)
    seedMessageDefaults(session)
    session.reportedOptions.model = 'model-a'
    session.options.set('model', 'saved-next')
    session.options.set('effort', 'high')
    const turnOptions = await resolvedCodexMessageOptions(session, undefined)
    await startCodexTurn(session, {
      clientMessageId: 'legacy',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'go' }] },
      turnOptions
    })
    expect(request.mock.calls[0]?.[1]).toMatchObject({ model: 'saved-next', effort: 'high' })
  })

  it('sends an exact empty snapshot without consulting unknown defaults', async () => {
    const request = vi.fn(async (_method: string, _params?: Record<string, unknown>) => ({
      turn: { id: 'unexpected' }
    }))
    const session = optionSession(request)
    session.reportedOptions = {}
    session.options.set('model', 'old-override')
    session.options.set('effort', 'high')
    const turnOptions = await resolvedCodexMessageOptions(session, {})
    expect(turnOptions).toEqual({})
    await startCodexTurn(session, { clientMessageId: 'sparse', body: USER_MESSAGE, turnOptions })
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty('model')
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty('effort')
  })

  it('restores native options after a known refusal and retains them after an unknown answer', async () => {
    const body = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'go' }]
    }
    const known = optionSession(
      vi.fn(async () => {
        throw new CodexAppServerRequestError('turn/start', -32602, 'invalid model')
      })
    )
    known.options.set('model', 'prior')
    known.appliedTurnOptions = { model: 'prior', effort: 'low', serviceTier: 'flex' }
    await expect(
      startCodexTurn(known, { clientMessageId: 'known', body, turnOptions: { model: 'attempted' } })
    ).rejects.toThrow('invalid model')
    expect(Object.fromEntries(known.options)).toEqual({ model: 'prior' })
    expect(known.appliedTurnOptions).toEqual({ model: 'prior', effort: 'low', serviceTier: 'flex' })
    const unknown = optionSession(
      vi.fn(async () => {
        throw new Error('connection lost after write')
      })
    )
    unknown.options.set('model', 'prior')
    unknown.appliedTurnOptions = { model: 'prior', effort: 'low', serviceTier: 'flex' }
    await expect(
      startCodexTurn(unknown, {
        clientMessageId: 'unknown',
        body,
        turnOptions: { model: 'attempted' }
      })
    ).rejects.toThrow('connection lost after write')
    expect(Object.fromEntries(unknown.options)).toEqual({ model: 'attempted' })
    expect(unknown.appliedTurnOptions).toEqual({
      effort: 'low',
      serviceTier: 'flex'
    })
  })
})
