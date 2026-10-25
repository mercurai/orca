import assert from 'node:assert/strict'
import { test } from 'node:test'

import { claimLease, createState } from './release-state.mjs'
import {
  buildDispatchPlan,
  executeDispatch,
  executionVerdict
} from './release-agent-dispatch.mjs'

const SHA = 'a'.repeat(40)
const target = {
  upstreamMainSha: SHA,
  stableTag: 'v1.4.239',
  controllerSha: SHA,
  patchHeads: [{ branch: 'patch/current-main-release', commit: SHA }]
}

test('builds structured Orca commands bound to the active generation', () => {
  const leased = claimLease(createState(target), { expectedVersion: 0, owner: 'coordinator', now: 1000 })
  const plan = buildDispatchPlan(leased, {
    owner: 'coordinator',
    objective: 'Reconcile the frozen candidate',
    taskTitle: 'Reconcile candidate conflicts'
  })

  assert.equal(plan.generation, 1)
  assert.deepEqual(plan.runArgs.slice(0, 3), ['orchestration', 'run-create', '--objective'])
  assert.deepEqual(plan.taskArgs.slice(0, 3), ['orchestration', 'task-create', '--run'])
  assert.equal(plan.runArgs.some((value) => value.includes('&&') || value.includes('|')), false)
})

test('executes bounded run/task/worker commands and persists returned IDs', async () => {
  const leased = claimLease(createState(target), { expectedVersion: 0, owner: 'coordinator', now: 1000 })
  const calls = []
  const checkpoints = []
  const result = await executeDispatch({
    state: leased,
    expectedVersion: leased.version,
    owner: 'coordinator',
    objective: 'Reconcile the frozen candidate',
    taskTitle: 'Reconcile candidate conflicts',
    persist: async (next) => checkpoints.push(next),
    run: async (argv) => {
      calls.push(argv)
      if (argv[1] === 'run-create') return { runId: 'run-1' }
      if (argv[1] === 'task-create') return { taskId: 'task-1' }
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
  assert.deepEqual(checkpoints.map(({ dispatch }) => dispatch), [
    { generation: 1, owner: 'coordinator', runId: 'run-1' },
    { generation: 1, owner: 'coordinator', runId: 'run-1', taskId: 'task-1' },
    { generation: 1, owner: 'coordinator', runId: 'run-1', taskId: 'task-1', dispatchId: 'dispatch-1' }
  ])
})

test('resumes a partial dispatch without recreating the run or task', async () => {
  const leased = claimLease(createState(target), { expectedVersion: 0, owner: 'coordinator', now: 1000 })
  const partial = {
    ...leased,
    dispatch: { generation: 1, owner: 'coordinator', runId: 'run-existing', taskId: 'task-existing' },
    evidence: { dispatch: { generation: 1, owner: 'coordinator', runId: 'run-existing', taskId: 'task-existing' } }
  }
  const calls = []
  const checkpoints = []
  const result = await executeDispatch({
    state: partial,
    expectedVersion: partial.version,
    owner: 'coordinator',
    objective: 'Reconcile the frozen candidate',
    taskTitle: 'Reconcile candidate conflicts',
    persist: async (next) => checkpoints.push(next),
    run: async (argv) => {
      calls.push(argv)
      return { dispatchId: 'dispatch-resumed' }
    }
  })

  assert.deepEqual(calls.map((argv) => argv[1]), ['worker-start'])
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
  const leased = claimLease(createState(target), { expectedVersion: 0, owner: 'coordinator', now: 1000 })
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
