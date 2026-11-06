import assert from 'node:assert/strict'
import { test } from 'node:test'

import { claimLease, createState } from './release-state.mjs'
import {
  DispatchUnknownError,
  buildDispatchPlan,
  executeDispatch,
  executionVerdict,
  taskSpecDigest
} from './release-agent-dispatch.mjs'

const SHA = 'a'.repeat(40)
const TASK_SPEC = 'Reconcile the conflict in src/main/git/remote-name-listing.test.ts and report.'
const SLOT = 'coord:host:20261103T1700'
const target = {
  upstreamMainSha: SHA,
  stableTag: 'v1.4.239',
  controllerSha: SHA,
  patchHeads: [{ branch: 'patch/current-main-release', commit: SHA }]
}

test('builds structured Orca commands bound to the active generation', () => {
  const leased = claimLease(createState(target), {
    expectedVersion: 0,
    owner: 'coordinator',
    now: 1000
  })
  const plan = buildDispatchPlan(leased, {
    owner: 'coordinator',
    objective: 'Reconcile the frozen candidate',
    taskTitle: 'Reconcile candidate conflicts',
    taskSpec: TASK_SPEC,
    slotId: SLOT
  })

  assert.equal(plan.generation, 1)
  assert.deepEqual(plan.runArgs.slice(0, 3), ['orchestration', 'run-create', '--objective'])
  assert.deepEqual(plan.taskArgs.slice(0, 3), ['orchestration', 'task-create', '--run'])
  assert.equal(
    plan.runArgs.some((value) => value.includes('&&') || value.includes('|')),
    false
  )
})

test('executes bounded run/task/worker commands and persists returned IDs', async () => {
  const leased = claimLease(createState(target), {
    expectedVersion: 0,
    owner: 'coordinator',
    now: 1000
  })
  const calls = []
  const checkpoints = []
  const result = await executeDispatch({
    state: leased,
    expectedVersion: leased.version,
    owner: 'coordinator',
    objective: 'Reconcile the frozen candidate',
    taskTitle: 'Reconcile candidate conflicts',
    taskSpec: TASK_SPEC,
    slotId: SLOT,
    persist: async (next) => checkpoints.push(next),
    run: async (argv) => {
      calls.push(argv)
      if (argv[1] === 'run-create') {
        return { runId: 'run-1' }
      }
      if (argv[1] === 'task-create') {
        return { taskId: 'task-1' }
      }
      return { dispatchId: 'dispatch-1' }
    }
  })

  assert.equal(calls.every(Array.isArray), true)
  assert.deepEqual(result.state.dispatch, {
    generation: 1,
    owner: 'coordinator',
    runId: 'run-1',
    taskId: 'task-1',
    dispatchId: 'dispatch-1'
  })
  assert.equal(result.state.version, leased.version + 3)
  assert.deepEqual(
    checkpoints.map(({ dispatch }) => dispatch),
    [
      { generation: 1, owner: 'coordinator', runId: 'run-1' },
      { generation: 1, owner: 'coordinator', runId: 'run-1', taskId: 'task-1' },
      {
        generation: 1,
        owner: 'coordinator',
        runId: 'run-1',
        taskId: 'task-1',
        dispatchId: 'dispatch-1'
      }
    ]
  )
})

test('resumes a partial dispatch without recreating the run or task', async () => {
  const leased = claimLease(createState(target), {
    expectedVersion: 0,
    owner: 'coordinator',
    now: 1000
  })
  const partial = {
    ...leased,
    dispatch: {
      generation: 1,
      owner: 'coordinator',
      runId: 'run-existing',
      taskId: 'task-existing'
    },
    evidence: {
      dispatch: {
        generation: 1,
        owner: 'coordinator',
        runId: 'run-existing',
        taskId: 'task-existing'
      }
    }
  }
  const calls = []
  const checkpoints = []
  const result = await executeDispatch({
    state: partial,
    expectedVersion: partial.version,
    owner: 'coordinator',
    objective: 'Reconcile the frozen candidate',
    taskTitle: 'Reconcile candidate conflicts',
    taskSpec: TASK_SPEC,
    slotId: SLOT,
    persist: async (next) => checkpoints.push(next),
    run: async (argv) => {
      calls.push(argv)
      return { dispatchId: 'dispatch-resumed' }
    }
  })

  assert.deepEqual(
    calls.map((argv) => argv[1]),
    ['worker-start']
  )
  assert.deepEqual(result.dispatch, {
    generation: 1,
    owner: 'coordinator',
    runId: 'run-existing',
    taskId: 'task-existing',
    dispatchId: 'dispatch-resumed'
  })
  assert.equal(checkpoints.length, 1)
})

test('does not spawn a duplicate worker when dispatch receipt is complete', async () => {
  const leased = claimLease(createState(target), {
    expectedVersion: 0,
    owner: 'coordinator',
    now: 1000
  })
  const complete = {
    ...leased,
    dispatch: {
      generation: 1,
      owner: 'coordinator',
      runId: 'run-existing',
      taskId: 'task-existing',
      dispatchId: 'dispatch-existing'
    }
  }
  let calls = 0
  const result = await executeDispatch({
    state: complete,
    expectedVersion: complete.version,
    owner: 'coordinator',
    objective: 'Reconcile the frozen candidate',
    taskTitle: 'Reconcile candidate conflicts',
    taskSpec: TASK_SPEC,
    slotId: SLOT,
    run: async () => {
      calls += 1
      return {}
    }
  })

  assert.equal(calls, 0)
  assert.equal(result.resumed, true)
  assert.deepEqual(result.dispatch, complete.dispatch)
})

test('distinguishes live, unverifiable and exited execution hosts', () => {
  assert.equal(executionVerdict({ connected: true, process: 'known' }), 'live')
  assert.equal(executionVerdict({ connected: false, process: 'unknown' }), 'unverifiable')
  assert.equal(executionVerdict({ connected: true, process: 'exited' }), 'exited')
})

function leasedState() {
  return claimLease(createState(target), { expectedVersion: 0, owner: 'coordinator', now: 1000 })
}

test('carries the task spec and one persisted retry id per mutation', () => {
  const plan = buildDispatchPlan(leasedState(), {
    owner: 'coordinator',
    objective: 'Reconcile the frozen candidate',
    taskTitle: 'Reconcile candidate conflicts',
    taskSpec: TASK_SPEC,
    slotId: SLOT
  })

  assert.equal(plan.taskArgs[plan.taskArgs.indexOf('--spec') + 1], TASK_SPEC)
  assert.equal(plan.runArgs[plan.runArgs.indexOf('--retry-request') + 1], `${SLOT}:run`)
  assert.equal(plan.taskArgs[plan.taskArgs.indexOf('--retry-request') + 1], `${SLOT}:task`)
  assert.equal(plan.workerArgs[plan.workerArgs.indexOf('--retry-request') + 1], `${SLOT}:worker`)
  assert.equal(plan.workerArgs[plan.workerArgs.indexOf('--run') + 1], '<runId>')
})

test('refuses a placeholder task spec before any mutation', () => {
  assert.throws(
    () =>
      buildDispatchPlan(leasedState(), {
        owner: 'coordinator',
        objective: 'Reconcile',
        taskTitle: 'Reconcile',
        taskSpec: 'Reconcile the <files> in the candidate',
        slotId: SLOT
      }),
    /must not contain <placeholder>/
  )
  assert.throws(
    () =>
      buildDispatchPlan(leasedState(), {
        owner: 'coordinator',
        objective: 'Reconcile',
        taskTitle: 'Reconcile',
        taskSpec: '',
        slotId: SLOT
      }),
    /taskSpec is required/
  )
})

test('refuses an invalid request id instead of dispatching it', () => {
  assert.throws(
    () =>
      buildDispatchPlan(leasedState(), {
        owner: 'coordinator',
        objective: 'Reconcile',
        taskTitle: 'Reconcile',
        taskSpec: TASK_SPEC,
        slotId: 'not a valid slot'
      }),
    /not a valid orchestration request id/
  )
})

test('parses the real orchestration envelope for run, task and worker receipts', async () => {
  const leased = leasedState()
  const result = await executeDispatch({
    state: leased,
    expectedVersion: leased.version,
    owner: 'coordinator',
    objective: 'Reconcile the frozen candidate',
    taskTitle: 'Reconcile candidate conflicts',
    taskSpec: TASK_SPEC,
    slotId: SLOT,
    run: async (argv) => {
      if (argv[1] === 'run-create') {
        return { code: 0, stdout: JSON.stringify({ ok: true, result: { run: { id: 'run-9' } } }) }
      }
      if (argv[1] === 'task-create') {
        return { code: 0, stdout: JSON.stringify({ ok: true, result: { task: { id: 'task-9' } } }) }
      }
      return {
        code: 0,
        stdout: JSON.stringify({ ok: true, result: { dispatchId: 'ctx_9', state: 'ready' } })
      }
    }
  })

  assert.equal(result.dispatch.runId, 'run-9')
  assert.equal(result.dispatch.taskId, 'task-9')
  assert.equal(result.dispatch.dispatchId, 'ctx_9')
  assert.equal(result.state.evidence.dispatchReceipt.acceptedOnNonzeroExit, false)
  assert.equal(result.state.evidence.dispatchRequest.specDigest, taskSpecDigest(TASK_SPEC))
})

test('keeps an accepted dispatch receipt that arrived with a nonzero exit', async () => {
  const leased = leasedState()
  const result = await executeDispatch({
    state: leased,
    expectedVersion: leased.version,
    owner: 'coordinator',
    objective: 'Reconcile the frozen candidate',
    taskTitle: 'Reconcile candidate conflicts',
    taskSpec: TASK_SPEC,
    slotId: SLOT,
    run: async (argv) => {
      if (argv[1] === 'run-create') {
        return { runId: 'run-1' }
      }
      if (argv[1] === 'task-create') {
        return { taskId: 'task-1' }
      }
      // orca sets exit 1 when result.state !== 'ready' and still prints the receipt.
      return {
        code: 1,
        stdout: JSON.stringify({ result: { dispatchId: 'ctx_unknown', state: 'outcome_unknown' } }),
        stderr: ''
      }
    }
  })

  assert.equal(result.dispatch.dispatchId, 'ctx_unknown')
  assert.equal(result.state.evidence.dispatchReceipt.acceptedOnNonzeroExit, true)
  assert.equal(result.state.evidence.dispatchReceipt.state, 'outcome_unknown')
})

test('keeps the run and task ids when the worker result is unknown, and resumes that same request', async () => {
  const leased = leasedState()
  const checkpoints = []
  const calls = []
  await assert.rejects(
    () =>
      executeDispatch({
        state: leased,
        expectedVersion: leased.version,
        owner: 'coordinator',
        objective: 'Reconcile the frozen candidate',
        taskTitle: 'Reconcile candidate conflicts',
        taskSpec: TASK_SPEC,
        slotId: SLOT,
        persist: async (next) => checkpoints.push(next),
        run: async (argv) => {
          calls.push(argv)
          if (argv[1] === 'run-create') {
            return { runId: 'run-1' }
          }
          if (argv[1] === 'task-create') {
            return { taskId: 'task-1' }
          }
          return { code: 1, stdout: '', stderr: 'transport closed' }
        }
      }),
    DispatchUnknownError
  )

  assert.deepEqual(calls.map((argv) => argv[1]), ['run-create', 'task-create', 'worker-start'])
  assert.equal(checkpoints.length, 2)
  assert.deepEqual(checkpoints.at(-1).dispatch, {
    generation: 1,
    owner: 'coordinator',
    runId: 'run-1',
    taskId: 'task-1'
  })

  // The retry replays the worker mutation with the same id and never re-creates run or task.
  const retried = []
  const resumed = await executeDispatch({
    state: checkpoints.at(-1),
    expectedVersion: checkpoints.at(-1).version,
    owner: 'coordinator',
    objective: 'Reconcile the frozen candidate',
    taskTitle: 'Reconcile candidate conflicts',
    taskSpec: TASK_SPEC,
    slotId: SLOT,
    run: async (argv) => {
      retried.push(argv)
      return { code: 0, stdout: JSON.stringify({ result: { dispatchId: 'ctx_1', state: 'ready' } }) }
    }
  })

  assert.deepEqual(retried.map((argv) => argv[1]), ['worker-start'])
  assert.equal(retried[0][retried[0].indexOf('--retry-request') + 1], `${SLOT}:worker`)
  assert.equal(resumed.dispatch.dispatchId, 'ctx_1')
})
