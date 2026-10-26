import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

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
})
