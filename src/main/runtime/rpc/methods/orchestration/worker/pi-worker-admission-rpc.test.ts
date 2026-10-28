import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../../../orchestration/db'
import type { TaskRow } from '../../../../orchestration/types'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'
import { releaseStructuredWorkerSession } from '../../orchestration-structured-worker-session'
import { structuredWorkerIdentities } from '../../../../structured-worker-identity'
import * as chatAdmission from '../chat-assignee-admission'
import { ADDRESS_X, SESSION_X, sessionRecord } from '../../../orchestration-session-caller-test-fixture'
import { localWorkerAuthorityFixture } from '../../../../orchestration/pi-worker-package-test-fixture'

const packagePrepare = vi.hoisted(() => vi.fn(async (args: {
  db: { getWorkerDispatch: (dispatchId: string) => { start_options: string } | undefined }
  dispatchId: string
}) => {
  const worker = args.db.getWorkerDispatch(args.dispatchId)
  if (!worker) throw new Error('Pi package fixture did not receive a reserved Dispatch.')
  const admission = JSON.parse(worker.start_options).piAdmission as Record<string, unknown>
  if (typeof admission.templatePath !== 'string' || !admission.artifacts) {
    throw new Error('Pi package fixture requires coordinator-owned template and artifacts.')
  }
  return { fixture: true }
}))

const lowerCreate = vi.hoisted(() => vi.fn())
const structuredHost = vi.hoisted(() => ({ current: null as unknown }))
const structuredWorker = vi.hoisted(() => ({
  preamble: vi.fn(async (_args: { preamble: string; sessionId?: string; dispatchId?: string }) => 'accepted' as const),
  discard: vi.fn(async () => {})
}))

vi.mock('../../../../orchestration/pi-worker-package', () => ({
  preparePiWorkerPackage: (args: Parameters<typeof packagePrepare>[0]) => packagePrepare(args),
  bindPiWorkerPackageToSession: vi.fn()
}))

vi.mock('../../../../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => structuredHost.current
}))

vi.mock('../../structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: (args: Record<string, unknown>) => lowerCreate(args)
}))

vi.mock('../../orchestration-structured-worker-session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendStructuredWorkerPreamble: (args: { preamble: string; sessionId: string; dispatchId: string }) => structuredWorker.preamble(args),
  discardStructuredWorkerSession: (...args: Parameters<typeof structuredWorker.discard>) => structuredWorker.discard(...args)
}))

describe('Pi admission through the registered orchestration RPC methods', () => {
  const harness = createOrchestrationWorkerReleaseHarness()
  let durableDirectory: string | undefined
  let durableDb: OrchestrationDb | undefined
  let hostClose: ReturnType<typeof vi.fn>
  const structuredDispatches = new Set<string>()
  const successfulStructuredSessions = new Set<string>()
  const structuredSessionRecords = new Map<string, ReturnType<typeof sessionRecord>>()
  beforeEach(() => {
    harness.setup()
    structuredWorkerIdentities.clear()
    successfulStructuredSessions.clear()
    structuredSessionRecords.clear()
    vi.spyOn(harness.runtime, 'getClientSettings').mockReturnValue({ experimentalNativeChat: true } as never)
    vi.spyOn(harness.runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({ supported: true })
    vi.spyOn(harness.runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
    vi.spyOn(harness.runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      structuredWorkerIdentities.get(handle)?.paneKey ??
      (handle === 'term_coord' ? harness.coordinatorPaneKey : handle === 'term_worker' || handle === 'term_reminted' ? harness.workerPaneKey : null)
    )
    vi.spyOn(harness.runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      structuredWorkerIdentities.get(handle)?.processIncarnation ??
      (handle === 'term_worker' || handle === 'term_reminted' ? 'runtime_test:term_worker:1' : null)
    )
    vi.spyOn(harness.runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) => {
      const identity = structuredWorkerIdentities.get(handle)
      if (identity) {
        return {
          runtimeId: 'runtime_test',
          terminalHandle: identity.handle,
          ptyId: '',
          worktreeId: identity.worktreeId,
          paneKey: identity.paneKey,
          processIncarnation: identity.processIncarnation,
          launchTokenHash: null,
          hostScope: identity.hostScope
        }
      }
      return handle === 'term_worker' || handle === 'term_reminted'
          ? {
              runtimeId: 'runtime_test',
              terminalHandle: handle,
              ptyId: '',
              worktreeId: 'repo::worktree',
              paneKey: harness.workerPaneKey,
              processIncarnation: 'runtime_test:term_worker:1',
              launchTokenHash: null,
              hostScope: { kind: 'local', hostId: 'local' }
            }
          : null
    })
    hostClose = vi.fn(async (_sessionId: string, _reason: string) => {})
    const dispose = vi.fn()
    structuredHost.current = {
      setSessionTabVisibility: vi.fn(async () => {}),
      close: hostClose,
      deps: {
        store: {
          getRecord: (sessionId: string) => structuredSessionRecords.get(sessionId) ?? (
            structuredWorkerIdentities.getBySessionId(sessionId)
              && successfulStructuredSessions.has(sessionId)
              ? {
                  location: { executionHostId: 'local', wslDistro: null },
                  lease: { runtimeFence: 1, runtimeKind: 'native', claimStatus: 'live' }
                }
              : null
          ),
          listRecords: () => [...structuredSessionRecords.values()]
        }
      },
      subscribe: vi.fn(async (_sessionId: string) => dispose)
    }
    packagePrepare.mockClear()
    lowerCreate.mockReset()
    lowerCreate.mockImplementation(async (args: {
      ensureHost: () => Promise<unknown>
      envelope: { sessionId: string }
    }) => {
      await args.ensureHost()
      successfulStructuredSessions.add(args.envelope.sessionId)
      return {
        ok: true,
        value: { sessionId: args.envelope.sessionId, fence: 1 }
      }
    })
    structuredWorker.preamble.mockClear()
    structuredWorker.discard.mockClear()
    structuredWorker.preamble.mockResolvedValue('accepted')
  })
  afterEach(() => {
    for (const dispatchId of structuredDispatches) {
      releaseStructuredWorkerSession(dispatchId, harness.runtime)
    }
    structuredDispatches.clear()
    if (durableDb) {
      harness.runtime.setOrchestrationDb(harness.db)
      durableDb.close()
      durableDb = undefined
    }
    if (durableDirectory) {
      rmSync(durableDirectory, { recursive: true, force: true })
      durableDirectory = undefined
    }
    structuredHost.current = null
    structuredWorkerIdentities.clear()
    harness.cleanup()
  })

  function policy(
    db = harness.db,
    runId = harness.activeRunId,
    taskCount = 1,
    options: { causal?: boolean } = { causal: true }
  ) {
    const task = db.createTask({ runId, spec: 'Implement bounded Pi task' })
    const exportTask = options.causal
      ? db.createTask({ runId, spec: 'Coordinator-owned source export', deps: [task.id] })
      : undefined
    const review = db.createTask({
      runId,
      spec: 'Independent Sol review',
      deps: exportTask ? [task.id, exportTask.id] : [task.id]
    })
    const ciTask = db.createTask({ runId, spec: 'CI capacity admission' })
    const ciGate = db.createGate({ taskId: ciTask.id, question: 'Admit CI work?' })
    db.resolveGate(ciGate.id, 'approved')
    const profileSha256 = 'a'.repeat(64)
    type PolicyTask = {
      taskId: string
      reviewTaskId: string
      profileSha256: string
      [key: string]: unknown
    }
    const config: {
      schema: string
      maxWorkers: number
      ciGateId: string
      artifacts: { sharedSource: { repo: string; commit: string }; broker: { path: string; sha256: string } }
      tasks: PolicyTask[]
    } = {
      schema: 'orca.pi-worker-admission.v1',
      maxWorkers: 2,
      ciGateId: ciGate.id,
      artifacts: {
        sharedSource: { repo: process.cwd(), commit: 'c'.repeat(40) },
        broker: { path: process.execPath, sha256: 'd'.repeat(64) }
      },
      tasks: [{
        taskId: task.id,
        reviewTaskId: review.id,
        ...(exportTask ? { exportTaskId: exportTask.id } : {}),
        templatePath: process.execPath,
        profileSha256,
        maxTokens: 10000,
        maxOutputTokens: 1000,
        maxCostMicrousd: 2000000,
        deadlineUnixMs: Number.MAX_SAFE_INTEGER,
        endpoint: { id: 'qualified-endpoint', inputMicrousdPerMillion: 1000, outputMicrousdPerMillion: 2000 }
      }]
    }
    for (let index = 1; index < taskCount; index += 1) {
      const extraTask = db.createTask({ runId, spec: `Implement bounded Pi task ${index}` })
      const extraExport = options.causal
        ? db.createTask({
            runId,
            spec: `Coordinator-owned source export ${index}`,
            deps: [extraTask.id]
          })
        : undefined
      const extraReview = db.createTask({
        runId,
        spec: `Independent Sol review ${index}`,
        deps: extraExport ? [extraTask.id, extraExport.id] : [extraTask.id]
      })
      config.tasks.push({
        ...config.tasks[0],
        taskId: extraTask.id,
        reviewTaskId: extraReview.id,
        profileSha256: String(index + 1).repeat(64),
        ...(extraExport ? { exportTaskId: extraExport.id } : {})
      })
    }
    const params = {
      run: runId,
      from: 'term_coord',
      consumerGeneration: db.getRun(runId)!.consumer_generation,
      config
    }
    return { task, exportTask, review, profileSha256, params, tasks: config.tasks }
  }

  function rememberStructuredDispatch(result: unknown): void {
    if (typeof result !== 'object' || result === null || Array.isArray(result)) return
    if (!('dispatchId' in result) || typeof result.dispatchId !== 'string') return
    structuredDispatches.add(result.dispatchId)
  }

  it('persists the coordinator policy through the typed registered endpoint', async () => {
    const f = policy()
    const accepted = await harness.call('orchestration.piWorkerAdmissionConfigure', f.params)
    expect(accepted).toMatchObject({ configSha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
    const started = harness.db.createStartingWorkerDispatch({
      taskId: f.task.id,
      creator: { kind: 'system' },
      maxDepth: 3,
      startOptions: {
        agent: 'pi',
        mode: { mode: 'structured', preferred: 'structured', reason: 'user_default', detail: 'Host selected.' },
        piProfileSha256: f.profileSha256
      }
    })
    const bound = JSON.parse(started.worker.start_options)
    expect(accepted).toEqual({ configSha256: bound.piAdmission.configSha256 })
    expect(bound).toMatchObject({
      piAdmission: { dispatchId: started.dispatch.id, profileSha256: f.profileSha256 }
    })
  })

  it('rejects a worker claiming the coordinator configuration endpoint', async () => {
    const f = policy()
    await expect(harness.call('orchestration.piWorkerAdmissionConfigure', {
      ...f.params, from: 'term_worker'
    })).rejects.toMatchObject({ code: 'consumer_fenced' })
    expect(harness.runtime.createTerminal).not.toHaveBeenCalled()
  })

  it('fences a stale coordinator generation through the endpoint', async () => {
    const f = policy()
    await expect(harness.call('orchestration.piWorkerAdmissionConfigure', {
      ...f.params, consumerGeneration: f.params.consumerGeneration + 1
    })).rejects.toMatchObject({ code: 'consumer_fenced' })
  })

  it('propagates the profile reference and refuses an unverified terminal route before launch', async () => {
    const f = policy()
    await harness.call('orchestration.piWorkerAdmissionConfigure', f.params)
    vi.spyOn(harness.runtime, 'getClientSettings').mockReturnValue({ experimentalNativeChat: false } as never)
    await expect(harness.call('orchestration.workerStart', {
      task: f.task.id,
      run: harness.activeRunId,
      from: 'term_coord',
      agent: 'pi',
      piProfileSha256: f.profileSha256
    })).rejects.toMatchObject({
      code: 'pi_admission_invalid',
      message: expect.stringContaining('structured surface')
    })
    expect(harness.db.getDispatchContext(f.task.id)).toBeUndefined()
    expect(harness.runtime.createTerminal).not.toHaveBeenCalled()
    expect(harness.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('refuses adopting a Pi PTY without creating a Dispatch or sending its task', async () => {
    const task = harness.db.createTask({ runId: harness.activeRunId, spec: 'Attempt Pi terminal adoption' })
    vi.spyOn(harness.runtime, 'showTerminal').mockImplementation(async (handle) => ({
      handle, worktreeId: 'repo::worktree', status: 'running',
      agentIdentity: handle === 'term_worker' ? 'pi' : 'codex'
    }) as never)
    await expect(harness.call('orchestration.workerStart', {
      task: task.id, from: 'term_coord', terminal: 'term_worker'
    })).rejects.toMatchObject({ code: 'pi_admission_required' })
    expect(harness.db.getDispatchContext(task.id)).toBeUndefined()
    expect(harness.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('refuses adopting an existing Pi chat without creating a Dispatch or sending its task', async () => {
    const task = harness.db.createTask({ runId: harness.activeRunId, spec: 'Attempt Pi chat adoption' })
    const piSession = {
      ...sessionRecord(SESSION_X, { location: { workspaceId: 'repo::worktree' } }),
      provider: 'pi'
    }
    structuredSessionRecords.set(SESSION_X, piSession)
    vi.spyOn(chatAdmission, 'admitChatAssignee').mockResolvedValue(piSession)
    await expect(harness.call('orchestration.workerStart', {
      task: task.id, from: 'term_coord', terminal: ADDRESS_X
    })).rejects.toMatchObject({ code: 'pi_admission_required' })
    expect(harness.db.getDispatchContext(task.id)).toBeUndefined()
    expect(harness.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('preserves reuse of an existing Codex terminal without Pi admission', async () => {
    vi.spyOn(harness.runtime, 'showTerminal').mockImplementation(async (handle) => ({
      handle, worktreeId: 'repo::worktree', status: 'running', agentIdentity: 'codex'
    }) as never)
    const started = await harness.startWorker({ terminal: 'term_worker' })
    expect(harness.db.getWorkerDispatch(started.dispatchId)?.state).toBe('ready')
    expect(harness.runtime.sendTerminalAgentPrompt).toHaveBeenCalled()
  })

  it('retains a settled Pi slot until workerRelease proves the exact owned resource closed', async () => {
    const f = policy(harness.db, harness.activeRunId, 3)
    await harness.call('orchestration.piWorkerAdmissionConfigure', f.params)
    const start = (index: number) => harness.db.createStartingWorkerDispatch({
      taskId: f.params.config.tasks[index].taskId, creator: { kind: 'system' }, maxDepth: 3,
      startOptions: {
        agent: 'pi', piProfileSha256: f.params.config.tasks[index].profileSha256,
        mode: { mode: 'structured', preferred: 'structured', reason: 'user_default', detail: 'Host selected.' }
      }
    })
    const first = start(0)
    start(1)
    harness.db.prepareStartingWorkerAuthority({
      dispatchId: first.dispatch.id, handle: 'term_worker', paneKey: harness.workerPaneKey,
      processIncarnation: 'runtime_test:term_worker:1', worktreeId: 'repo::worktree',
      ...localWorkerAuthorityFixture(),
      effects: [], setupState: 'not_applicable', terminalOwnership: 'created'
    })
    harness.db.markWorkerDispatchReady(first.dispatch.id)
    expect(harness.db.settleWorkerReport({
      taskId: first.task.id, dispatchId: first.dispatch.id, outcome: 'succeeded', result: 'implementation ready'
    })).toMatchObject({ action: 'settled' })
    expect(() => start(2)).toThrow(expect.objectContaining({ code: 'pi_admission_capacity' }))
    expect(harness.db.getWorkerTerminalResourceByOwner(first.dispatch.id)?.release_state).toBe('not_requested')
    await expect(harness.call('orchestration.workerRelease', { dispatch: first.dispatch.id })).resolves.toMatchObject({
      state: 'released', processAction: 'closed_agent_terminal'
    })
    expect(harness.runtime.closeTerminal).toHaveBeenCalledWith('term_worker')
    expect(harness.db.getWorkerTerminalResourceByOwner(first.dispatch.id)).toMatchObject({
      ownership_state: 'released', release_state: 'released'
    })
    expect(start(2).worker.state).toBe('starting')
  })

  it('persists the real pre-child refusal and replaces its exact durable reservation after reopen', async () => {
    durableDirectory = mkdtempSync(join(tmpdir(), 'orca-pi-admission-rpc-'))
    durableDb = new OrchestrationDb(join(durableDirectory, 'orchestration.db'))
    const durableRun = durableDb.createRun({
      objective: 'Durable Pi admission RPC fixture',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: harness.coordinatorPaneKey
    })
    harness.runtime.setOrchestrationDb(durableDb)
    const first = policy(durableDb, durableRun.id, 3, { causal: true })
    await harness.call('orchestration.piWorkerAdmissionConfigure', first.params)

    const refusal = {
      code: 'structured_agent_session_unsupported' as const,
      message: 'Orca cannot open a structured agent chat for this workspace.',
      details: { reason: 'hostUnsupported' as const }
    }
    let observedEnvelope: { sessionId: string; clientOperationId: string } | undefined
    const lowerEntered = harness.deferred<void>()
    const releaseLower = harness.deferred<{ ok: false; refusal: typeof refusal }>()
    lowerCreate.mockImplementationOnce(async (args: {
      ensureHost: () => Promise<unknown>
      envelope: { sessionId: string; clientOperationId: string }
    }) => {
      await args.ensureHost()
      observedEnvelope = args.envelope
      lowerEntered.resolve()
      return releaseLower.promise
    })
    const firstStart = harness.call('orchestration.workerStart', {
      task: first.task.id, run: durableRun.id, from: 'term_coord', agent: 'pi',
      piProfileSha256: first.profileSha256
    })
    await lowerEntered.promise
    expect(packagePrepare).toHaveBeenCalledTimes(1)
    expect(lowerCreate).toHaveBeenCalledTimes(1)
    expect(observedEnvelope).toMatchObject({
      sessionId: expect.any(String),
      clientOperationId: expect.any(String)
    })
    expect(harness.runtime.createTerminal).not.toHaveBeenCalled()

    const firstDispatch = durableDb.getDispatchContext(first.task.id)
    if (!firstDispatch) throw new Error('The real worker-start boundary did not create a Dispatch.')
    const firstWorker = durableDb.getWorkerDispatch(firstDispatch.id)
    if (!firstWorker) throw new Error('The real worker-start boundary did not create a worker row.')
    const effectsBeforeReopen: unknown[] = JSON.parse(firstWorker.effects)
    expect(effectsBeforeReopen).toEqual(expect.arrayContaining([
      { kind: 'worktree', action: 'reused', id: 'repo::worktree' },
      { kind: 'setup', action: 'not_applicable', state: 'not_applicable' }
    ]))
    const attemptEpoch = firstWorker.runtime_epoch
    expect(firstWorker.state).toBe('starting')
    expect(firstWorker.stage).toBe('terminal_creating')
    expect(structuredWorker.preamble).not.toHaveBeenCalled()

    const second = first.tasks[1]
    const secondResult = await harness.call('orchestration.workerStart', {
      task: second.taskId, run: durableRun.id, from: 'term_coord', agent: 'pi',
      piProfileSha256: second.profileSha256
    })
    rememberStructuredDispatch(secondResult)
    expect(secondResult).toMatchObject({ state: 'ready' })
    const secondEnvelope = lowerCreate.mock.calls[1]?.[0]?.envelope as {
      sessionId: string
      clientOperationId: string
    }
    expect(secondEnvelope).toMatchObject({
      sessionId: expect.any(String),
      clientOperationId: expect.any(String)
    })
    expect(secondEnvelope.sessionId).not.toBe(observedEnvelope?.sessionId)
    expect(secondEnvelope.clientOperationId).not.toBe(observedEnvelope?.clientOperationId)
    const secondDispatch = durableDb.getDispatchContext(second.taskId)
    if (!secondDispatch) throw new Error('The independent ready worker did not create a Dispatch.')
    expect(structuredWorker.preamble).toHaveBeenCalledTimes(1)
    expect(structuredWorker.preamble.mock.calls[0]?.[0]).toMatchObject({
      sessionId: secondEnvelope.sessionId,
      dispatchId: secondDispatch.id
    })
    await expect(harness.call('orchestration.workerStart', {
      task: first.tasks[2].taskId, run: durableRun.id, from: 'term_coord', agent: 'pi',
      piProfileSha256: first.tasks[2].profileSha256
    })).rejects.toMatchObject({ code: 'pi_admission_capacity' })
    expect(lowerCreate).toHaveBeenCalledTimes(2)

    releaseLower.resolve({ ok: false, refusal })
    const firstResult = await firstStart
    rememberStructuredDispatch(firstResult)
    expect(firstResult).toMatchObject({
      state: 'failed',
      failedStage: 'terminal_create'
    })
    expect(packagePrepare).toHaveBeenCalledTimes(2)
    expect(structuredWorker.preamble).toHaveBeenCalledTimes(1)
    expect(structuredWorker.preamble.mock.calls[0]?.[0]).toMatchObject({
      sessionId: secondEnvelope.sessionId,
      dispatchId: secondDispatch.id
    })
    expect(hostClose).not.toHaveBeenCalled()

    const failedWorker = durableDb.getWorkerDispatch(firstDispatch.id)
    if (!failedWorker) throw new Error('The failed worker row disappeared after refusal.')
    expect(failedWorker).toMatchObject({
      state: 'failed',
      stage: 'terminal_create',
      runtime_epoch: attemptEpoch
    })
    const failedEffects: unknown[] = JSON.parse(failedWorker.effects)
    expect(failedEffects).toEqual(expect.arrayContaining(effectsBeforeReopen))
    const refusalProofs = failedEffects.filter(
      (effect): effect is Record<string, unknown> =>
        typeof effect === 'object' && effect !== null &&
        'kind' in effect && effect.kind === 'structured_create_refusal'
    )
    expect(refusalProofs).toHaveLength(1)
    expect(refusalProofs[0]).toMatchObject({
      schema: 'orca.worker-create-refusal.v1',
      refusalCode: refusal.code,
      runId: durableRun.id,
      taskId: first.task.id,
      dispatchId: firstDispatch.id,
      sessionId: observedEnvelope?.sessionId,
      clientOperationId: observedEnvelope?.clientOperationId,
      runtimeEpoch: attemptEpoch
    })
    expect(failedEffects.some((effect) =>
      typeof effect === 'object' && effect !== null &&
      'kind' in effect && (effect.kind === 'terminal' || effect.kind === 'preamble' || effect.kind === 'close')
    )).toBe(false)
    expect(durableDb.getWorkerTerminalResourceByOwner(firstDispatch.id)).toBeUndefined()
    expect(structuredWorkerIdentities.getBySessionId(observedEnvelope!.sessionId)).toBeUndefined()

    const protectedState = {
      state: failedWorker.state,
      stage: failedWorker.stage,
      runtimeEpoch: failedWorker.runtime_epoch,
      effects: failedWorker.effects
    }
    const overwriteAttempt = [
      ...failedEffects,
      {
        kind: 'structured_create_refusal',
        schema: 'orca.worker-create-refusal.v1',
        refusalCode: 'forged_overwrite'
      }
    ]
    try {
      durableDb.recordWorkerStage({
        dispatchId: firstDispatch.id,
        stage: 'terminal_create',
        effects: overwriteAttempt
      })
    } catch {
      // Rejection is an accepted protected-writer outcome.
    }
    const protectedAfterStage = durableDb.getWorkerDispatch(firstDispatch.id)
    expect(protectedAfterStage).toMatchObject({
      state: protectedState.state,
      stage: protectedState.stage,
      runtime_epoch: protectedState.runtimeEpoch,
      effects: protectedState.effects
    })
    try {
      durableDb.updateWorkerSetupEvidence({
        dispatchId: firstDispatch.id,
        setupState: 'failed',
        effects: overwriteAttempt
      })
    } catch {
      // Rejection is an accepted protected-writer outcome.
    }
    const protectedAfterSetup = durableDb.getWorkerDispatch(firstDispatch.id)
    expect(protectedAfterSetup).toMatchObject({
      state: protectedState.state,
      stage: protectedState.stage,
      runtime_epoch: protectedState.runtimeEpoch,
      effects: protectedState.effects
    })

    if (!durableDb) throw new Error('Durable DB fixture was not initialized.')
    harness.runtime.setOrchestrationDb(harness.db)
    durableDb.close()
    durableDb = new OrchestrationDb(join(durableDirectory, 'orchestration.db'))
    harness.runtime.setOrchestrationDb(durableDb)
    vi.spyOn(harness.runtime, 'getRuntimeId').mockReturnValue('runtime_after_reopen')
    const reopenedWorker = durableDb.getWorkerDispatch(firstDispatch.id)
    expect(reopenedWorker).toMatchObject({
      state: 'failed',
      stage: 'terminal_create',
      runtime_epoch: attemptEpoch
    })
    const reopenedEffects: unknown[] = JSON.parse(reopenedWorker?.effects ?? '[]')
    expect(reopenedEffects).toEqual(failedEffects)
    expect(reopenedEffects.filter((effect) =>
      typeof effect === 'object' && effect !== null &&
      'kind' in effect && effect.kind === 'structured_create_refusal'
    )).toHaveLength(1)

    const replacement = await harness.call('orchestration.workerStart', {
      task: first.tasks[2].taskId, run: durableRun.id, from: 'term_coord', agent: 'pi',
      piProfileSha256: first.tasks[2].profileSha256
    })
    rememberStructuredDispatch(replacement)
    expect(replacement).toMatchObject({ state: 'ready' })
    expect(lowerCreate).toHaveBeenCalledTimes(3)
    const replacementEnvelope = lowerCreate.mock.calls[2]?.[0]?.envelope as {
      sessionId: string
      clientOperationId: string
    }
    expect(replacementEnvelope).toMatchObject({
      sessionId: expect.any(String),
      clientOperationId: expect.any(String)
    })
    expect(replacementEnvelope.sessionId).not.toBe(observedEnvelope?.sessionId)
    expect(replacementEnvelope.sessionId).not.toBe(secondEnvelope.sessionId)
    expect(replacementEnvelope.clientOperationId).not.toBe(observedEnvelope?.clientOperationId)
    expect(replacementEnvelope.clientOperationId).not.toBe(secondEnvelope.clientOperationId)
    expect(structuredWorkerIdentities.getBySessionId(secondEnvelope.sessionId)).toBeDefined()
    expect(structuredWorkerIdentities.getBySessionId(replacementEnvelope.sessionId)).toBeDefined()
    expect(hostClose).not.toHaveBeenCalled()
  })

  it('retains authentic refusal proof and owned custody precedence after reopen', async () => {
    durableDirectory = mkdtempSync(join(tmpdir(), 'orca-pi-admission-custody-'))
    durableDb = new OrchestrationDb(join(durableDirectory, 'orchestration.db'))
    const durableRun = durableDb.createRun({
      objective: 'Durable Pi owned-custody precedence',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: harness.coordinatorPaneKey
    })
    harness.runtime.setOrchestrationDb(durableDb)
    const first = policy(durableDb, durableRun.id, 3, { causal: true })
    await harness.call('orchestration.piWorkerAdmissionConfigure', first.params)
    const refusal = {
      code: 'structured_agent_session_unsupported' as const,
      message: 'Orca cannot open a structured agent chat for this workspace.',
      details: { reason: 'hostUnsupported' as const }
    }
    let custodyEnvelope: { sessionId: string; clientOperationId: string } | undefined
    let custodyEpoch: string | null | undefined
    let custodyEffects: unknown[] | undefined
    lowerCreate.mockImplementationOnce(async (args: {
      ensureHost: () => Promise<unknown>
      envelope: { sessionId: string; clientOperationId: string }
    }) => {
      await args.ensureHost()
      const dispatch = durableDb?.getDispatchContext(first.task.id)
      const worker = dispatch ? durableDb?.getWorkerDispatch(dispatch.id) : undefined
      if (!dispatch || !worker) throw new Error('The lower boundary did not expose custody snapshots.')
      custodyEnvelope = args.envelope
      custodyEpoch = worker.runtime_epoch
      custodyEffects = JSON.parse(worker.effects)
      return { ok: false, refusal }
    })
    const firstResult = await harness.call('orchestration.workerStart', {
      task: first.task.id, run: durableRun.id, from: 'term_coord', agent: 'pi',
      piProfileSha256: first.profileSha256
    })
    rememberStructuredDispatch(firstResult)
    const firstDispatch = durableDb.getDispatchContext(first.task.id)
    if (!firstDispatch) throw new Error('The real worker-start boundary did not create a Dispatch.')
    const firstWorker = durableDb.getWorkerDispatch(firstDispatch.id)
    if (!firstWorker) throw new Error('The failed worker row disappeared after refusal.')
    if (!custodyEnvelope || custodyEpoch === undefined || !custodyEffects) {
      throw new Error('The lower custody snapshots were not captured.')
    }
    expect(firstResult).toMatchObject({ state: 'failed', failedStage: 'terminal_create' })
    expect(firstWorker.runtime_epoch).toBe(custodyEpoch)
    const proofEffects: unknown[] = JSON.parse(firstWorker.effects)
    expect(proofEffects).toEqual(expect.arrayContaining(custodyEffects))
    const refusalProofs = proofEffects.filter(
      (effect): effect is Record<string, unknown> =>
        typeof effect === 'object' && effect !== null &&
        'kind' in effect && effect.kind === 'structured_create_refusal'
    )
    expect(refusalProofs).toHaveLength(1)
    expect(refusalProofs[0]).toMatchObject({
      schema: 'orca.worker-create-refusal.v1',
      refusalCode: refusal.code,
      runId: durableRun.id,
      taskId: first.task.id,
      dispatchId: firstDispatch.id,
      sessionId: custodyEnvelope.sessionId,
      clientOperationId: custodyEnvelope.clientOperationId,
      runtimeEpoch: custodyEpoch
    })

    const second = first.tasks[1]
    const secondResult = await harness.call('orchestration.workerStart', {
      task: second.taskId, run: durableRun.id, from: 'term_coord', agent: 'pi',
      piProfileSha256: second.profileSha256
    })
    rememberStructuredDispatch(secondResult)
    expect(secondResult).toMatchObject({ state: 'ready' })
    expect(durableDb.getWorkerTerminalResourceByOwner(firstDispatch.id)).toBeUndefined()
    const custody = durableDb.createWorkerTerminalResourceStatement({
      dispatchId: firstDispatch.id,
      worktreeId: 'repo::worktree',
      terminalHandle: 'term_owned_custody',
      paneKey: 'tab_owned_custody:cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      processIncarnation: 'runtime_test:owned_custody:1',
      hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
      ownership: 'owned'
    })
    expect(custody).toMatchObject({
      origin_dispatch_id: firstDispatch.id,
      owner_dispatch_id: firstDispatch.id,
      ownership_state: 'owned',
      release_state: 'not_requested'
    })
    await expect(harness.call('orchestration.workerStart', {
      task: first.tasks[2].taskId, run: durableRun.id, from: 'term_coord', agent: 'pi',
      piProfileSha256: first.tasks[2].profileSha256
    })).rejects.toMatchObject({ code: 'pi_admission_capacity' })

    if (!durableDb) throw new Error('Durable DB fixture was not initialized.')
    harness.runtime.setOrchestrationDb(harness.db)
    durableDb.close()
    durableDb = new OrchestrationDb(join(durableDirectory, 'orchestration.db'))
    harness.runtime.setOrchestrationDb(durableDb)
    expect(durableDb.getWorkerTerminalResourceByOwner(firstDispatch.id)).toMatchObject({
      id: custody.id,
      origin_dispatch_id: firstDispatch.id,
      owner_dispatch_id: firstDispatch.id,
      terminal_handle: custody.terminal_handle,
      process_incarnation: custody.process_incarnation,
      ownership_state: 'owned',
      release_state: 'not_requested'
    })
    const reopenedWorker = durableDb.getWorkerDispatch(firstDispatch.id)
    expect(reopenedWorker).toMatchObject({
      state: 'failed',
      stage: 'terminal_create',
      runtime_epoch: custodyEpoch
    })
    expect(JSON.parse(reopenedWorker?.effects ?? '[]')).toEqual(proofEffects)
    expect(JSON.parse(reopenedWorker?.effects ?? '[]')).toEqual(expect.arrayContaining(custodyEffects))
    await expect(harness.call('orchestration.workerStart', {
      task: first.tasks[2].taskId, run: durableRun.id, from: 'term_coord', agent: 'pi',
      piProfileSha256: first.tasks[2].profileSha256
    })).rejects.toMatchObject({ code: 'pi_admission_capacity' })
  })

  it('rolls back a genuine refusal transaction without changing durable capacity', async () => {
    durableDirectory = mkdtempSync(join(tmpdir(), 'orca-pi-admission-atomicity-'))
    durableDb = new OrchestrationDb(join(durableDirectory, 'orchestration.db'))
    const durableRun = durableDb.createRun({
      objective: 'Durable Pi atomic refusal',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: harness.coordinatorPaneKey
    })
    harness.runtime.setOrchestrationDb(durableDb)
    const first = policy(durableDb, durableRun.id, 3, { causal: true })
    await harness.call('orchestration.piWorkerAdmissionConfigure', first.params)

    let armCommitFault = false
    let insideFailWorkerStart = false
    let commitFaultHits = 0
    let firstDispatchId: string | undefined
    let observedEnvelope: { sessionId: string; clientOperationId: string } | undefined
    let preFailureTask: TaskRow | undefined
    let preFailureDispatch: ReturnType<OrchestrationDb['getDispatchContextById']>
    let preFailureWorker: ReturnType<OrchestrationDb['getWorkerDispatch']>
    const realExec = durableDb.db.exec.bind(durableDb.db)
    vi.spyOn(durableDb.db, 'exec').mockImplementation((sql) => {
      if (sql === 'COMMIT' && armCommitFault && insideFailWorkerStart) {
        armCommitFault = false
        commitFaultHits += 1
        throw new Error('injected proof commit failure')
      }
      return realExec(sql)
    })
    const realFailWorkerStart = durableDb.failWorkerStart.bind(durableDb)
    vi.spyOn(durableDb, 'failWorkerStart').mockImplementation((...args) => {
      const [dispatchId, stage] = args
      insideFailWorkerStart = dispatchId === firstDispatchId && stage === 'terminal_create'
      try {
        return realFailWorkerStart(...args)
      } finally {
        insideFailWorkerStart = false
      }
    })
    const refusal = {
      code: 'structured_agent_session_unsupported' as const,
      message: 'Orca cannot open a structured agent chat for this workspace.',
      details: { reason: 'hostUnsupported' as const }
    }
    lowerCreate.mockImplementationOnce(async (args: {
      ensureHost: () => Promise<unknown>
      envelope: { sessionId: string; clientOperationId: string }
    }) => {
      await args.ensureHost()
      firstDispatchId = durableDb?.getDispatchContext(first.task.id)?.id
      if (!firstDispatchId) throw new Error('The genuine worker-start boundary did not create a Dispatch.')
      observedEnvelope = args.envelope
      preFailureTask = durableDb?.getTask(first.task.id)
      preFailureDispatch = durableDb?.getDispatchContextById(firstDispatchId)
      preFailureWorker = durableDb?.getWorkerDispatch(firstDispatchId)
      if (!preFailureTask || !preFailureDispatch || !preFailureWorker) {
        throw new Error('The lower boundary did not expose complete pre-failure rows.')
      }
      expect(preFailureWorker.state).toBe('starting')
      expect(preFailureWorker.stage).toBe('terminal_creating')
      expect(durableDb?.getWorkerTerminalResourceByOwner(firstDispatchId)).toBeUndefined()
      expect(JSON.parse(preFailureWorker.effects)).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'structured_create_refusal' })])
      )
      armCommitFault = true
      return { ok: false, refusal }
    })

    let workerStartError: unknown
    try {
      await harness.call('orchestration.workerStart', {
        task: first.task.id, run: durableRun.id, from: 'term_coord', agent: 'pi',
        piProfileSha256: first.profileSha256
      })
    } catch (error) {
      workerStartError = error
    }
    expect(workerStartError).toHaveProperty('message', 'injected proof commit failure')
    expect(commitFaultHits).toBe(1)
    expect(observedEnvelope).toMatchObject({
      sessionId: expect.any(String),
      clientOperationId: expect.any(String)
    })
    expect(preFailureTask).toBeDefined()
    expect(preFailureDispatch).toBeDefined()
    expect(preFailureWorker).toBeDefined()
    const preFailureEffects = JSON.parse(preFailureWorker?.effects ?? '[]') as unknown[]
    expect(preFailureEffects).toEqual(expect.arrayContaining([
      { kind: 'worktree', action: 'reused', id: 'repo::worktree' },
      { kind: 'setup', action: 'not_applicable', state: 'not_applicable' }
    ]))
    expect(durableDb.getWorkerTerminalResourceByOwner(firstDispatchId!)).toBeUndefined()
    expect(JSON.parse(durableDb.getWorkerDispatch(firstDispatchId!)?.effects ?? '[]')).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'structured_create_refusal' })])
    )

    const second = first.tasks[1]
    const secondResult = await harness.call('orchestration.workerStart', {
      task: second.taskId, run: durableRun.id, from: 'term_coord', agent: 'pi',
      piProfileSha256: second.profileSha256
    })
    rememberStructuredDispatch(secondResult)
    expect(secondResult).toMatchObject({ state: 'ready' })
    await expect(harness.call('orchestration.workerStart', {
      task: first.tasks[2].taskId, run: durableRun.id, from: 'term_coord', agent: 'pi',
      piProfileSha256: first.tasks[2].profileSha256
    })).rejects.toMatchObject({ code: 'pi_admission_capacity' })

    if (!durableDb) throw new Error('Durable DB fixture was not initialized.')
    harness.runtime.setOrchestrationDb(harness.db)
    durableDb.close()
    durableDb = new OrchestrationDb(join(durableDirectory, 'orchestration.db'))
    harness.runtime.setOrchestrationDb(durableDb)
    expect(durableDb.getTask(first.task.id)).toEqual(preFailureTask)
    expect(durableDb.getDispatchContextById(firstDispatchId!)).toEqual(preFailureDispatch)
    expect(durableDb.getTask(first.task.id)).toMatchObject({ status: 'dispatched' })
    expect(durableDb.getDispatchContextById(firstDispatchId!)).toMatchObject({ status: 'pending' })
    expect(durableDb.getWorkerDispatch(firstDispatchId!)).toEqual(preFailureWorker)
    expect(JSON.parse(durableDb.getWorkerDispatch(firstDispatchId!)?.effects ?? '[]')).toEqual(preFailureEffects)
    await expect(harness.call('orchestration.workerStart', {
      task: first.tasks[2].taskId, run: durableRun.id, from: 'term_coord', agent: 'pi',
      piProfileSha256: first.tasks[2].profileSha256
    })).rejects.toMatchObject({ code: 'pi_admission_capacity' })
  })

  it.each([
    {
      name: 'typed operation_unknown after attach',
      lowerResult: {
        ok: false,
        refusal: {
          code: 'agent_session_operation_unknown',
          message: 'The chat may have been created, but its tab could not be confirmed.'
        }
      },
      state: 'outcome_unknown',
      workerState: 'start_unknown',
      closeExpected: true
    },
    {
      name: 'typed ownership_unknown after attach',
      lowerResult: {
        ok: false,
        refusal: {
          code: 'agent_session_ownership_unknown',
          message: 'The structured worker owner could not be confirmed.'
        }
      },
      state: 'failed',
      workerState: 'failed',
      closeExpected: true
    },
    {
      name: 'legacy operation_unknown after attach',
      error: Object.assign(new Error('The chat may have been created, but its tab could not be confirmed.'), {
        code: 'operation_unknown'
      }),
      state: 'outcome_unknown',
      workerState: 'start_unknown',
      closeExpected: true
    },
    {
      name: 'commit transport throw',
      error: new Error('commit transport throw'),
      state: 'failed',
      workerState: 'failed',
      closeExpected: true
    },
    {
      name: 'generic Error',
      error: new Error('generic structured create failure'),
      state: 'failed',
      workerState: 'failed',
      closeExpected: true
    }
  ])('retains capacity after the lower create boundary reports %s', async ({ error, lowerResult, state, workerState, closeExpected }) => {
    durableDirectory = mkdtempSync(join(tmpdir(), 'orca-pi-admission-matrix-'))
    durableDb = new OrchestrationDb(join(durableDirectory, 'orchestration.db'))
    const durableRun = durableDb.createRun({
      objective: 'Durable Pi lower-boundary uncertainty matrix',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: harness.coordinatorPaneKey
    })
    harness.runtime.setOrchestrationDb(durableDb)
    const first = policy(durableDb, durableRun.id, 3, { causal: true })
    await harness.call('orchestration.piWorkerAdmissionConfigure', first.params)
    let lowerSessionId: string | undefined
    let lowerOperationId: string | undefined
    let preFailureEpoch: string | null | undefined
    let preFailureEffects: unknown[] | undefined
    lowerCreate.mockImplementationOnce(async (args: {
      ensureHost: () => Promise<unknown>
      envelope: { sessionId: string; clientOperationId: string }
    }) => {
      await args.ensureHost()
      lowerSessionId = args.envelope.sessionId
      lowerOperationId = args.envelope.clientOperationId
      const dispatch = durableDb?.getDispatchContext(first.task.id)
      const worker = dispatch ? durableDb?.getWorkerDispatch(dispatch.id) : undefined
      if (!dispatch || !worker) throw new Error('The lower boundary did not expose matrix snapshots.')
      preFailureEpoch = worker.runtime_epoch
      preFailureEffects = JSON.parse(worker.effects)
      if (lowerResult) return lowerResult
      throw error
    })

    const result = await harness.call('orchestration.workerStart', {
      task: first.task.id, run: durableRun.id, from: 'term_coord', agent: 'pi',
      piProfileSha256: first.profileSha256
    })
    rememberStructuredDispatch(result)
    expect(result).toMatchObject({ state, failedStage: 'terminal_create' })
    expect(packagePrepare).toHaveBeenCalledTimes(1)
    expect(lowerCreate).toHaveBeenCalledTimes(1)
    expect(structuredWorker.preamble).not.toHaveBeenCalled()
    if (closeExpected) {
      expect(hostClose).toHaveBeenCalledTimes(1)
      expect(hostClose).toHaveBeenCalledWith(lowerSessionId, 'evict')
    } else {
      expect(hostClose).not.toHaveBeenCalled()
    }
    const dispatch = durableDb.getDispatchContext(first.task.id)
    expect(dispatch).toBeDefined()
    const firstWorker = durableDb.getWorkerDispatch(dispatch!.id)
    expect(firstWorker).toMatchObject({ state: workerState, stage: 'terminal_create' })
    expect(lowerSessionId).toEqual(expect.any(String))
    expect(lowerOperationId).toEqual(expect.any(String))
    if (preFailureEpoch === undefined || !preFailureEffects) {
      throw new Error('The lower matrix snapshots were not captured.')
    }
    expect(firstWorker?.runtime_epoch).toBe(preFailureEpoch)
    expect(JSON.parse(firstWorker?.effects ?? '[]')).toEqual(preFailureEffects)
    expect(durableDb.getWorkerTerminalResourceByOwner(dispatch!.id)).toBeUndefined()
    expect(preFailureEffects).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'structured_create_refusal' })])
    )

    const second = first.tasks[1]
    const secondResult = await harness.call('orchestration.workerStart', {
      task: second.taskId, run: durableRun.id, from: 'term_coord', agent: 'pi',
      piProfileSha256: second.profileSha256
    })
    rememberStructuredDispatch(secondResult)
    expect(secondResult).toMatchObject({ state: 'ready' })
    const secondDispatch = durableDb.getDispatchContext(second.taskId)
    expect(secondDispatch).toBeDefined()
    expect(durableDb.getWorkerDispatch(secondDispatch!.id)).toMatchObject({ state: 'ready' })
    await expect(harness.call('orchestration.workerStart', {
      task: first.tasks[2].taskId, run: durableRun.id, from: 'term_coord', agent: 'pi',
      piProfileSha256: first.tasks[2].profileSha256
    })).rejects.toMatchObject({ code: 'pi_admission_capacity' })

    if (!durableDb) throw new Error('Durable DB fixture was not initialized.')
    harness.runtime.setOrchestrationDb(harness.db)
    durableDb.close()
    durableDb = new OrchestrationDb(join(durableDirectory, 'orchestration.db'))
    harness.runtime.setOrchestrationDb(durableDb)
    const reopenedWorker = durableDb.getWorkerDispatch(dispatch!.id)
    expect(reopenedWorker).toMatchObject({
      state: workerState,
      stage: 'terminal_create',
      runtime_epoch: preFailureEpoch
    })
    expect(JSON.parse(reopenedWorker?.effects ?? '[]')).toEqual(preFailureEffects)
    expect(durableDb.getWorkerTerminalResourceByOwner(dispatch!.id)).toBeUndefined()
    await expect(harness.call('orchestration.workerStart', {
      task: first.tasks[2].taskId, run: durableRun.id, from: 'term_coord', agent: 'pi',
      piProfileSha256: first.tasks[2].profileSha256
    })).rejects.toMatchObject({ code: 'pi_admission_capacity' })
    expect(lowerCreate).toHaveBeenCalledTimes(2)
  })

  it('preserves postspawn preamble uncertainty as a separate control', async () => {
    const first = policy()
    await harness.call('orchestration.piWorkerAdmissionConfigure', first.params)
    structuredWorker.preamble.mockRejectedValueOnce(Object.assign(
      new Error('The chat may have been created, but its tab could not be confirmed.'),
      { code: 'operation_unknown' }
    ))

    const result = await harness.call('orchestration.workerStart', {
      task: first.task.id, run: harness.activeRunId, from: 'term_coord', agent: 'pi',
      piProfileSha256: first.profileSha256
    })
    rememberStructuredDispatch(result)
    expect(result).toMatchObject({ state: 'outcome_unknown', failedStage: 'dispatch_input' })
    expect(lowerCreate).toHaveBeenCalledTimes(1)
    expect(structuredWorker.preamble).toHaveBeenCalledTimes(1)
    expect(structuredWorker.discard).toHaveBeenCalledTimes(1)
    expect(hostClose).not.toHaveBeenCalled()
    const dispatch = harness.db.getDispatchContext(first.task.id)
    expect(dispatch).toBeDefined()
    expect(harness.db.getWorkerDispatch(dispatch!.id)).toMatchObject({
      state: 'start_unknown',
      stage: 'dispatch_input'
    })
    await expect(harness.call('orchestration.piWorkerAdmissionConfigure', policy().params)).rejects.toMatchObject({
      code: 'pi_admission_invalid'
    })
  })

  it('observes the actual structured Pi first turn through concrete harness_report operations', async () => {
    const f = policy()
    await harness.call('orchestration.piWorkerAdmissionConfigure', f.params)
    const result = await harness.call('orchestration.workerStart', {
      task: f.task.id, run: harness.activeRunId, from: 'term_coord', agent: 'pi',
      piProfileSha256: f.profileSha256
    })
    rememberStructuredDispatch(result)
    expect(result).toMatchObject({ state: 'ready', mode: { mode: 'structured' } })
    expect(structuredWorker.preamble).toHaveBeenCalledTimes(1)
    const prompt = structuredWorker.preamble.mock.calls[0]?.[0].preamble
    expect(prompt).toBeDefined()
    for (const operation of ['status', 'heartbeat', 'ask', 'resume', 'inbox', 'complete']) {
      expect(prompt).toContain(`"operation":"${operation}"`)
    }
    expect(prompt).not.toContain('```sh')
    expect(prompt).not.toContain('orca orchestration send')
    expect(prompt).not.toContain('shell recipe')
    expect(harness.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('refuses an implementation-only review graph before persisting Pi admission or launching', async () => {
    const f = policy()
    harness.db.db.prepare('UPDATE tasks SET deps = ? WHERE id = ?').run(
      JSON.stringify([f.task.id]),
      f.review.id
    )

    await expect(harness.call('orchestration.piWorkerAdmissionConfigure', f.params)).rejects.toMatchObject({
      code: 'pi_admission_invalid',
      message: expect.stringContaining('export prerequisite')
    })
    expect(harness.db.db.prepare('SELECT 1 FROM run_pi_worker_admission WHERE run_id = ?').get(harness.activeRunId)).toBeUndefined()
    expect(harness.db.getDispatchContext(f.task.id)).toBeUndefined()
    expect(harness.runtime.createTerminal).not.toHaveBeenCalled()
    expect(packagePrepare).not.toHaveBeenCalled()
    expect(lowerCreate).not.toHaveBeenCalled()
  })

  it('binds the intended export contract through registered endpoints and gates review on delivery', async () => {
    const f = policy()
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
    const requireRpcEntity = (result: unknown, key: 'task' | 'gate'): { id: string } => {
      if (!isRecord(result) || !isRecord(result[key]) || typeof result[key].id !== 'string') {
        throw new Error(`Registered RPC result did not contain a ${key} id.`)
      }
      return { id: result[key].id }
    }
    const requireConfigSha256 = (result: unknown): string => {
      if (!isRecord(result) || typeof result.configSha256 !== 'string') {
        throw new Error('Registered admission RPC result did not contain configSha256.')
      }
      return result.configSha256
    }
    const createTask = async (spec: string, deps: string[] = []) => {
      const result = await harness.call('orchestration.taskCreate', {
        spec,
        run: harness.activeRunId,
        callerTerminalHandle: 'term_coord',
        ...(deps.length > 0 ? { deps: JSON.stringify(deps) } : {})
      })
      return requireRpcEntity(result, 'task')
    }
    const createGate = async (task: string, question: string) => {
      const result = await harness.call('orchestration.gateCreate', {
        task,
        question,
        run: harness.activeRunId,
        from: 'term_coord'
      })
      return requireRpcEntity(result, 'gate')
    }
    const implementation = await createTask('Registered implementation task')
    const exportTask = await createTask('Coordinator-owned source export', [implementation.id])
    const review = await createTask('Independent Sol review', [implementation.id, exportTask.id])
    const ciTask = await createTask('CI capacity admission')
    const ciGate = await createGate(ciTask.id, 'Admit CI work?')
    await harness.call('orchestration.gateResolve', {
      id: ciGate.id,
      resolution: 'approved',
      run: harness.activeRunId,
      from: 'term_coord'
    })
    const sourceGate = await createGate(exportTask.id, 'Source delivered?')
    const taskEntry = {
      ...f.params.config.tasks[0],
      taskId: implementation.id,
      reviewTaskId: review.id,
      exportTaskId: exportTask.id
    }
    const intendedConfig = {
      ...f.params.config,
      ciGateId: ciGate.id,
      tasks: [taskEntry]
    }

    const wrongExport = await createTask('Export without implementation dependency')
    const wrongReview = await createTask('Review paired to export without implementation dependency', [implementation.id, wrongExport.id])
    const reviewWithoutExport = await createTask('Review without export dependency', [implementation.id])
    const foreignRun = harness.db.createRun({
      objective: 'Foreign export Run',
      coordinatorHandle: 'term_foreign_export',
      coordinatorPaneKey: 'foreign_export:pane'
    })
    const foreignExport = harness.db.createTask({ runId: foreignRun.id, spec: 'Foreign source export' })
    for (const invalidLink of [
      { exportTaskId: wrongExport.id, reviewTaskId: wrongReview.id },
      { exportTaskId: exportTask.id, reviewTaskId: reviewWithoutExport.id },
      { exportTaskId: implementation.id, reviewTaskId: review.id },
      { exportTaskId: review.id, reviewTaskId: review.id },
      { exportTaskId: foreignExport.id, reviewTaskId: review.id }
    ]) {
      await expect(harness.call('orchestration.piWorkerAdmissionConfigure', {
        ...f.params,
        config: { ...intendedConfig, tasks: [{ ...taskEntry, ...invalidLink }] }
      })).rejects.toMatchObject({ code: 'pi_admission_invalid' })
    }

    const accepted = await harness.call('orchestration.piWorkerAdmissionConfigure', {
      ...f.params,
      config: intendedConfig
    })
    const acceptedConfigSha256 = requireConfigSha256(accepted)
    expect(accepted).toMatchObject({ configSha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
    const result = await harness.call('orchestration.workerStart', {
      task: implementation.id,
      run: harness.activeRunId,
      from: 'term_coord',
      agent: 'pi',
      piProfileSha256: taskEntry.profileSha256
    })
    rememberStructuredDispatch(result)
    expect(result).toMatchObject({ state: 'ready', mode: { mode: 'structured' } })
    const dispatch = harness.db.getDispatchContext(implementation.id)
    expect(dispatch).toBeDefined()
    const worker = harness.db.getWorkerDispatch(dispatch!.id)
    expect(worker).toBeDefined()
    expect(JSON.parse(worker!.start_options).piAdmission).toMatchObject({
      taskId: implementation.id,
      exportTaskId: exportTask.id,
      reviewTaskId: review.id,
      configSha256: acceptedConfigSha256
    })
    expect(lowerCreate).toHaveBeenCalledTimes(1)
    expect(packagePrepare).toHaveBeenCalledTimes(1)

    expect(harness.db.settleWorkerReport({
      taskId: implementation.id, dispatchId: dispatch!.id, outcome: 'succeeded', result: 'implementation ready'
    })).toMatchObject({ action: 'settled' })
    expect(harness.db.getTask(implementation.id)?.status).toBe('completed')
    expect(harness.db.getTask(exportTask.id)?.status).toBe('blocked')
    expect(harness.db.getTask(review.id)?.status).toBe('pending')
    expect(harness.db.getGate(sourceGate.id)?.status).toBe('pending')

    await harness.call('orchestration.gateResolve', {
      id: sourceGate.id,
      resolution: 'approved',
      run: harness.activeRunId,
      from: 'term_coord'
    })
    expect(harness.db.getTask(exportTask.id)?.status).toBe('ready')
    expect(harness.db.getTask(review.id)?.status).toBe('pending')
    await harness.call('orchestration.taskUpdate', {
      id: exportTask.id,
      status: 'completed',
      result: 'source export succeeded',
      run: harness.activeRunId,
      callerTerminalHandle: 'term_coord'
    })
    expect(harness.db.getTask(review.id)?.status).toBe('ready')
  })
})
