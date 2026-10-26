import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'
import * as chatAdmission from '../chat-assignee-admission'
import { ADDRESS_X, SESSION_X, sessionRecord } from '../../../orchestration-session-caller-test-fixture'

describe('Pi admission through the registered orchestration RPC methods', () => {
  const harness = createOrchestrationWorkerReleaseHarness()
  beforeEach(() => harness.setup())
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
      tasks: [{
        taskId: task.id,
        reviewTaskId: review.id,
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
    return { task, profileSha256, params }
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
})
