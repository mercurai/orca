import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './orchestration-db'

const NOW = Date.UTC(2026, 9, 26, 20)
const COORDINATOR = {
  terminalHandle: 'term_pi_coordinator',
  paneKey: 'tab_pi:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  orcaSessionId: null
}
const MODEL = 'openrouter/deepseek/deepseek-v4.1-flash-1017'
const opened: OrchestrationDb[] = []
let directory: string

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  directory = mkdtempSync(join(tmpdir(), 'orca-pi-admission-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const db of opened.splice(0)) db.close()
  rmSync(directory, { recursive: true, force: true })
  vi.useRealTimers()
})

function open(path = join(directory, 'orchestration.db')) {
  const db = new OrchestrationDb(path)
  opened.push(db)
  return db
}

function fixture() {
  const db = open()
  const run = db.createRun({
    objective: 'Pi admission regression',
    coordinatorHandle: COORDINATOR.terminalHandle,
    coordinatorPaneKey: COORDINATOR.paneKey
  })
  const tasks = Array.from({ length: 6 }, (_, index) =>
    db.createTask({ runId: run.id, spec: `Implement isolated task ${index}` })
  )
  const reviews = tasks.map((task) =>
    db.createTask({ runId: run.id, spec: `Review ${task.id}`, deps: [task.id] })
  )
  const ciTask = db.createTask({ runId: run.id, spec: 'Confirm CI admission' })
  const ciGate = db.createGate({ taskId: ciTask.id, question: 'CI capacity available?' })
  db.resolveGate(ciGate.id, 'approved')
  const config = {
    schema: 'orca.pi-worker-admission.v1',
    maxWorkers: 2,
    ciGateId: ciGate.id,
    tasks: tasks.map((task, index) => ({
      taskId: task.id,
      profileSha256: String(index + 1).repeat(64),
      reviewTaskId: reviews[index].id,
      maxTokens: 10000,
      maxOutputTokens: 1000,
      maxCostMicrousd: 2000000,
      deadlineUnixMs: NOW + 60000,
      endpoint: {
        id: 'qualified-fixture',
        inputMicrousdPerMillion: 1000000,
        outputMicrousdPerMillion: 2000000
      }
    }))
  }
  function configure(overrides = {}) {
    return db.configurePiWorkerAdmission({
      runId: run.id,
      consumerGeneration: run.consumer_generation,
      coordinator: COORDINATOR,
      config: { ...config, ...overrides }
    })
  }
  function start(index: number, target = db, extras: Record<string, unknown> = {}) {
    return target.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 3,
      taskId: tasks[index].id,
      ...(extras.on ? {
        federation: {
          environmentId: 'env_fixture',
          environmentName: 'Qualified server',
          peerFingerprint: 'peer_fixture',
          protocolVersion: 1
        }
      } : {}),
      startOptions: {
        agent: 'pi',
        mode: {
          mode: 'structured',
          preferred: 'structured',
          reason: 'user_default',
          detail: 'Structured worker selected by the execution host.'
        },
        piProfileSha256: config.tasks[index].profileSha256,
        launch: { requested: { agent: 'pi', model: MODEL, effort: null } },
        ...extras
      }
    })
  }
  return { db, run, tasks, reviews, ciGate, config, configure, start }
}

describe('Pi admission at the durable worker-start boundary', () => {
  it('refuses Pi without Run admission even when worker options claim readiness', () => {
    const f = fixture()
    expect(() => f.start(0, f.db, {
      piAdmission: { ciReady: true, maxWorkers: 100, budgetReady: true },
      maxWorkers: 100
    })).toThrow(/Pi.*admission/i)
    expect(f.db.getDispatchContext(f.tasks[0].id)).toBeUndefined()
    expect(f.db.getTask(f.tasks[0].id)?.status).toBe('ready')
  })

  it('preserves non-Pi starts without Pi configuration', () => {
    const f = fixture()
    const started = f.start(0, f.db, { agent: 'codex', piProfileSha256: undefined })
    expect(started.worker.state).toBe('starting')
  })

  it('binds accepted configuration to the generated exact Dispatch', () => {
    const f = fixture()
    const accepted = f.configure()
    const first = f.start(0)
    expect(JSON.parse(first.worker.start_options)).toMatchObject({
      piAdmission: {
        runId: f.run.id,
        taskId: f.tasks[0].id,
        dispatchId: first.dispatch.id,
        profileSha256: f.config.tasks[0].profileSha256,
        configSha256: accepted.configSha256
      }
    })
    expect(f.db.getWorkerDispatch(first.dispatch.id)?.stage).toBe('accepted')
  })

  it('shares the two slots between local and federated starts', () => {
    const f = fixture()
    f.configure()
    f.start(0)
    f.start(1, f.db, { on: 'server-fixture', serverName: 'Qualified server' })
    expect(() => f.start(2, f.db, { maxWorkers: 4 })).toThrow(/capacity/i)
    expect(f.db.getDispatchContext(f.tasks[2].id)).toBeUndefined()
  })

  it('retains uncertain reservations across a database reopen', () => {
    const f = fixture()
    f.configure()
    const first = f.start(0)
    f.start(1)
    f.db.markWorkerStartUnknown(first.dispatch.id, 'provider_contact', 'contact unavailable')
    const reopened = open()
    expect(() => f.start(2, reopened)).toThrow(/capacity/i)
    expect(reopened.getWorkerDispatch(first.dispatch.id)?.state).toBe('start_unknown')
  })

  it('releases only the exact settled attempt and ignores duplicate exit evidence', () => {
    const f = fixture()
    f.configure()
    const first = f.start(0)
    const second = f.start(1)
    expect(() => f.db.failDispatch(first.dispatch.id, 'cancel requested')).toThrow(/active|stop|settle/i)
    expect(() => f.start(2)).toThrow(/capacity/i)
    f.db.failDispatch(first.dispatch.id, 'exit observed', { workerProcessExited: true })
    const replacement = f.start(2)
    f.db.failDispatch(first.dispatch.id, 'duplicate exit', { workerProcessExited: true })
    expect(() => f.start(3)).toThrow(/capacity/i)
    expect(f.db.getWorkerDispatch(second.dispatch.id)?.state).toBe('starting')
    expect(f.db.getWorkerDispatch(replacement.dispatch.id)?.state).toBe('starting')
  })

  it('refuses a task whose configured deadline expires before reservation', () => {
    const f = fixture()
    f.configure()
    vi.setSystemTime(NOW + 60001)
    expect(() => f.start(0)).toThrow(/deadline|expired/i)
    expect(f.db.getDispatchContext(f.tasks[0].id)).toBeUndefined()
  })

  it('checks capacity after taking the writer lock when another connection wins', () => {
    const f = fixture()
    f.configure()
    f.start(0)
    const concurrent = open()
    const exec = f.db.db.exec.bind(f.db.db)
    let raced = false
    vi.spyOn(f.db.db, 'exec').mockImplementation((sql) => {
      if (!raced && sql === 'BEGIN IMMEDIATE') {
        raced = true
        f.start(1, concurrent)
      }
      return exec(sql)
    })
    expect(() => f.start(2)).toThrow(/capacity/i)
    expect(raced).toBe(true)
    expect(f.db.getDispatchContext(f.tasks[2].id)).toBeUndefined()
  })

  it('requires exact configured task profile identity', () => {
    const f = fixture()
    f.configure()
    expect(() => f.start(0, f.db, {
      piProfileSha256: f.config.tasks[1].profileSha256
    })).toThrow(/profile/i)
    expect(f.db.getDispatchContext(f.tasks[0].id)).toBeUndefined()
  })

  it('does not let configuration replacement change a live attempt', () => {
    const f = fixture()
    f.configure()
    const started = f.start(0)
    const before = f.db.getWorkerDispatch(started.dispatch.id)?.start_options
    expect(() => f.configure({ maxWorkers: 4 })).toThrow(/active|qualification/i)
    expect(f.db.getWorkerDispatch(started.dispatch.id)?.start_options).toBe(before)
  })

  it('counts completed implementations waiting on review, not supplied backlog numbers', () => {
    const f = fixture()
    f.configure()
    for (const index of [0, 1]) {
      const started = f.start(index)
      f.db.markWorkerDispatchReady(started.dispatch.id)
      expect(f.db.settleWorkerReport({
        taskId: f.tasks[index].id,
        dispatchId: started.dispatch.id,
        outcome: 'succeeded',
        result: 'patch ready for independent review'
      })).toMatchObject({ action: 'settled', duplicate: false })
    }
    expect(() => f.start(2, f.db, { pendingReviews: 0 })).toThrow(/review/i)
    f.db.updateTaskStatus(f.reviews[0].id, 'completed', 'independent review accepted')
    expect(f.start(2).worker.state).toBe('starting')
  })

  it('refuses a terminal route that cannot attest model, package and tools', () => {
    const f = fixture()
    f.configure()
    expect(() => f.start(0, f.db, {
      mode: {
        mode: 'terminal',
        preferred: 'terminal',
        reason: 'user_default',
        detail: 'Terminal worker selected by the execution host.'
      }
    })).toThrow(/structured|surface/i)
    expect(f.db.getDispatchContext(f.tasks[0].id)).toBeUndefined()
  })
})

describe('coordinator-owned Pi admission configuration', () => {
  it('fences a stale or non-owning coordinator', () => {
    const f = fixture()
    for (const identity of [
      { coordinator: COORDINATOR, consumerGeneration: f.run.consumer_generation - 1 },
      { coordinator: { ...COORDINATOR, terminalHandle: 'term_worker' }, consumerGeneration: f.run.consumer_generation }
    ]) {
      expect(() => f.db.configurePiWorkerAdmission({
        runId: f.run.id,
        config: f.config,
        ...identity
      })).toThrow(/coordinator|generation|fenced/i)
    }
  })

  it('requires an accepted same-Run CI gate, not a caller readiness boolean', () => {
    const f = fixture()
    expect(() => f.configure({ ciGateId: 'gate_missing', ciReady: true })).toThrow(/CI|gate|field/i)
    const foreign = f.db.createRun({
      objective: 'unrelated Run', coordinatorHandle: 'term_foreign', coordinatorPaneKey: 'foreign:pane'
    })
    const task = f.db.createTask({ runId: foreign.id, spec: 'unrelated CI' })
    const gate = f.db.createGate({ taskId: task.id, question: 'Unrelated CI ready?' })
    f.db.resolveGate(gate.id, 'approved')
    expect(() => f.configure({ ciGateId: gate.id })).toThrow(/Run|gate/i)
    const pendingTask = f.db.createTask({ runId: f.run.id, spec: 'CI still pending' })
    const pendingGate = f.db.createGate({ taskId: pendingTask.id, question: 'CI available?' })
    expect(() => f.configure({ ciGateId: pendingGate.id })).toThrow(/CI|gate/i)
    f.db.resolveGate(pendingGate.id, 'rejected')
    expect(() => f.configure({ ciGateId: pendingGate.id })).toThrow(/CI|gate/i)
  })

  it('invalidates a previous coordinator grant after Run ownership changes', () => {
    const f = fixture()
    f.configure()
    f.db.bindRun({
      runId: f.run.id,
      coordinatorHandle: 'term_replacement',
      coordinatorPaneKey: 'tab_replacement:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    })
    expect(() => f.start(0)).toThrow(/coordinator|generation|fenced|admission/i)
    expect(f.db.getDispatchContext(f.tasks[0].id)).toBeUndefined()
  })

  it('refuses four workers without accepted pilot evidence', () => {
    const f = fixture()
    expect(() => f.configure({ maxWorkers: 4 })).toThrow(/pilot|qualification/i)
    expect(() => f.configure({ maxWorkers: 4, pilotGateId: 'gate_invented' })).toThrow(/pilot|gate|qualification/i)
  })

  it('admits four only after accepted pilot evidence is persisted by the coordinator', () => {
    const f = fixture()
    f.configure()
    for (const index of [0, 1]) {
      const started = f.start(index)
      f.db.markWorkerDispatchReady(started.dispatch.id)
      expect(f.db.settleWorkerReport({
        taskId: f.tasks[index].id,
        dispatchId: started.dispatch.id,
        outcome: 'succeeded',
        result: 'pilot patch ready'
      })).toMatchObject({ action: 'settled', duplicate: false })
      f.db.updateTaskStatus(f.reviews[index].id, 'completed', 'independent pilot review accepted')
    }
    const pilotTask = f.db.createTask({
      runId: f.run.id,
      spec: 'Accept measured two-worker pilot',
      deps: [f.reviews[0].id, f.reviews[1].id]
    })
    const pilotGate = f.db.createGate({ taskId: pilotTask.id, question: 'Qualify four workers?' })
    expect(() => f.configure({ maxWorkers: 4, pilotGateId: pilotGate.id })).toThrow(/pilot|gate|qualification/i)
    f.db.resolveGate(pilotGate.id, 'approved')
    const accepted = f.configure({ maxWorkers: 4, pilotGateId: pilotGate.id })
    for (const index of [2, 3, 4, 5]) {
      expect(JSON.parse(f.start(index).worker.start_options)).toMatchObject({
        piAdmission: { configSha256: accepted.configSha256 }
      })
    }
  })

  it.each([
    { maxTokens: 0 },
    { maxOutputTokens: 0 },
    { maxOutputTokens: 10001 },
    { maxCostMicrousd: Number.MAX_SAFE_INTEGER + 1 },
    { deadlineUnixMs: NOW - 1 },
    { deadlineUnixMs: Number.MAX_SAFE_INTEGER + 1 },
    { profileSha256: 'not-a-hash' },
    { endpoint: { id: 'fixture', inputMicrousdPerMillion: -1, outputMicrousdPerMillion: 1000 } },
    { endpoint: { id: 'fixture', inputMicrousdPerMillion: 0, outputMicrousdPerMillion: 0 } }
  ])('refuses invalid or missing priced budget configuration: %j', (invalid) => {
    const f = fixture()
    expect(() => f.configure({
      tasks: [{ ...f.config.tasks[0], ...invalid }]
    })).toThrow()
  })
})
