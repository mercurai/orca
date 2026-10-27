import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'
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

const structuredWorker = vi.hoisted(() => ({
  create: vi.fn(async (args: { effects: Array<Record<string, unknown>> }) => {
    args.effects.push({ kind: 'terminal', role: 'agent', action: 'created', id: 'term_worker', surface: 'background' })
    return {
      identity: { handle: 'term_worker', sessionId: 'pi-session-fixture', agent: 'pi' },
      host: {},
      fence: 1
    }
  }),
  preamble: vi.fn(async (_args: { preamble: string }) => 'accepted' as const),
  release: vi.fn(),
  discard: vi.fn(async () => {})
}))

vi.mock('../../../../orchestration/pi-worker-package', () => ({
  preparePiWorkerPackage: (args: Parameters<typeof packagePrepare>[0]) => packagePrepare(args),
  bindPiWorkerPackageToSession: vi.fn()
}))

vi.mock('./worker-topology', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createStructuredWorkerSessionForWorktree: (args: Parameters<typeof structuredWorker.create>[0]) => structuredWorker.create(args)
}))

vi.mock('../../orchestration-structured-worker-session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendStructuredWorkerPreamble: (args: { preamble: string }) => structuredWorker.preamble(args),
  releaseStructuredWorkerSession: (...args: Parameters<typeof structuredWorker.release>) => structuredWorker.release(...args),
  discardStructuredWorkerSession: (...args: Parameters<typeof structuredWorker.discard>) => structuredWorker.discard(...args)
}))

describe('Pi admission through the registered orchestration RPC methods', () => {
  const harness = createOrchestrationWorkerReleaseHarness()
  beforeEach(() => {
    harness.setup()
    vi.spyOn(harness.runtime, 'getClientSettings').mockReturnValue({ experimentalNativeChat: true } as never)
    vi.spyOn(harness.runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({ supported: true })
    packagePrepare.mockClear()
    structuredWorker.create.mockClear()
    structuredWorker.preamble.mockClear()
    structuredWorker.release.mockClear()
    structuredWorker.discard.mockClear()
    structuredWorker.preamble.mockResolvedValue('accepted')
    structuredWorker.create.mockImplementation(async (args: { effects: Array<Record<string, unknown>> }) => {
      args.effects.push({ kind: 'terminal', role: 'agent', action: 'created', id: 'term_worker', surface: 'background' })
      return {
        identity: { handle: 'term_worker', sessionId: 'pi-session-fixture', agent: 'pi' },
        host: {},
        fence: 1
      }
    })
  })
  afterEach(() => harness.cleanup())

  function policy() {
    const db = harness.db
    const runId = harness.activeRunId
    const task = db.createTask({ runId, spec: 'Implement bounded Pi task' })
    const review = db.createTask({ runId, spec: 'Independent Sol review', deps: [task.id] })
    const ciTask = db.createTask({ runId, spec: 'CI capacity admission' })
    const ciGate = db.createGate({ taskId: ciTask.id, question: 'Admit CI work?' })
    db.resolveGate(ciGate.id, 'approved')
    const profileSha256 = 'a'.repeat(64)
    const config = {
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
        templatePath: process.execPath,
        profileSha256,
        maxTokens: 10000,
        maxOutputTokens: 1000,
        maxCostMicrousd: 2000000,
        deadlineUnixMs: Number.MAX_SAFE_INTEGER,
        endpoint: { id: 'qualified-endpoint', inputMicrousdPerMillion: 1000, outputMicrousdPerMillion: 2000 }
      }]
    }
    const params = {
      run: runId,
      from: 'term_coord',
      consumerGeneration: db.getRun(runId)!.consumer_generation,
      config
    }
    return { task, review, profileSha256, params }
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
    vi.spyOn(chatAdmission, 'admitChatAssignee').mockResolvedValue({
      ...sessionRecord(SESSION_X, { location: { workspaceId: 'repo::worktree' } }),
      provider: 'pi'
    })
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
    const f = policy()
    for (const suffix of ['2', '3']) {
      const task = harness.db.createTask({ runId: harness.activeRunId, spec: `Pi task ${suffix}` })
      const review = harness.db.createTask({ runId: harness.activeRunId, spec: `Review ${suffix}`, deps: [task.id] })
      f.params.config.tasks.push({
        ...f.params.config.tasks[0], taskId: task.id, reviewTaskId: review.id, profileSha256: suffix.repeat(64)
      })
    }
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

  it('releases a pre-child structured Pi reservation only after the package boundary is reached', async () => {
    const first = policy()
    await harness.call('orchestration.piWorkerAdmissionConfigure', first.params)
    structuredWorker.create.mockRejectedValueOnce(new Error('structured spawn rejected before child'))

    const result = await harness.call('orchestration.workerStart', {
      task: first.task.id, run: harness.activeRunId, from: 'term_coord', agent: 'pi',
      piProfileSha256: first.profileSha256
    })
    expect(result).toMatchObject({ state: 'failed', failedStage: 'terminal_create' })
    expect(packagePrepare).toHaveBeenCalledTimes(1)
    expect(structuredWorker.create).toHaveBeenCalledTimes(1)
    expect(harness.runtime.createTerminal).not.toHaveBeenCalled()
    const dispatch = harness.db.getDispatchContext(first.task.id)
    expect(dispatch).toBeDefined()
    expect(harness.db.getWorkerDispatch(dispatch!.id)).toMatchObject({ state: 'failed', stage: 'terminal_create' })

    const replacement = policy()
    await expect(harness.call('orchestration.piWorkerAdmissionConfigure', replacement.params)).resolves.toMatchObject({
      configSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
  })

  it('retains capacity after a postspawn structured delivery uncertainty', async () => {
    const first = policy()
    await harness.call('orchestration.piWorkerAdmissionConfigure', first.params)
    const uncertain = Object.assign(new Error('structured delivery outcome unknown'), {
      code: 'operation_unknown'
    })
    structuredWorker.preamble.mockRejectedValueOnce(uncertain)

    const result = await harness.call('orchestration.workerStart', {
      task: first.task.id, run: harness.activeRunId, from: 'term_coord', agent: 'pi',
      piProfileSha256: first.profileSha256
    })
    expect(result).toMatchObject({ state: 'outcome_unknown', failedStage: 'dispatch_input' })
    expect(packagePrepare).toHaveBeenCalledTimes(1)
    expect(structuredWorker.create).toHaveBeenCalledTimes(1)
    expect(structuredWorker.preamble).toHaveBeenCalledTimes(1)
    const dispatch = harness.db.getDispatchContext(first.task.id)
    expect(dispatch).toBeDefined()
    expect(harness.db.getWorkerDispatch(dispatch!.id)).toMatchObject({ state: 'start_unknown' })

    const replacement = policy()
    await expect(harness.call('orchestration.piWorkerAdmissionConfigure', replacement.params)).rejects.toMatchObject({
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

  it('binds the configured review task and keeps review pending until source export succeeds', async () => {
    const f = policy()
    const exportTask = harness.db.createTask({ runId: harness.activeRunId, spec: 'Coordinator-owned source export' })
    const sourceGate = harness.db.createGate({ taskId: exportTask.id, question: 'Source delivered?' })
    harness.db.db.prepare('UPDATE tasks SET deps = ? WHERE id = ?')
      .run(JSON.stringify([f.task.id, exportTask.id]), f.review.id)
    await harness.call('orchestration.piWorkerAdmissionConfigure', f.params)

    const started = harness.db.createStartingWorkerDispatch({
      taskId: f.task.id, creator: { kind: 'system' }, maxDepth: 3,
      startOptions: {
        agent: 'pi', piProfileSha256: f.profileSha256,
        mode: { mode: 'structured', preferred: 'structured', reason: 'user_default', detail: 'Host selected.' }
      }
    })
    const admission = JSON.parse(started.worker.start_options).piAdmission as Record<string, unknown>
    expect(admission).toMatchObject({ taskId: f.task.id, reviewTaskId: f.review.id })
    expect(admission.reviewTaskId).not.toBe(f.task.id)
    expect(JSON.parse(harness.db.getTask(f.review.id)!.deps)).toEqual([f.task.id, exportTask.id])

    harness.db.markWorkerDispatchReady(started.dispatch.id)
    expect(harness.db.settleWorkerReport({
      taskId: f.task.id, dispatchId: started.dispatch.id, outcome: 'succeeded', result: 'implementation ready'
    })).toMatchObject({ action: 'settled' })
    expect(harness.db.getTask(f.task.id)?.status).toBe('completed')
    expect(harness.db.getTask(f.review.id)?.status).toBe('pending')
    expect(harness.db.getGate(sourceGate.id)?.status).toBe('pending')

    harness.db.resolveGate(sourceGate.id, 'approved')
    expect(harness.db.getTask(exportTask.id)?.status).toBe('ready')
    harness.db.updateTaskStatus(exportTask.id, 'completed', 'source export succeeded')
    expect(harness.db.getTask(f.review.id)?.status).toBe('ready')
  })
})
