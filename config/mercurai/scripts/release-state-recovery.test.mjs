/**
 * Recovery proof for the two boundaries where a crash is unrecoverable if the code guesses:
 *
 *   1. after the tag push, before the build dispatch   -> the tag must be reused, never re-allocated
 *   2. after the publish receipt, before the state commit -> the channel must be adopted, never re-uploaded
 *
 * A durability claim without this file is a promise. The assertions are the receipt counts: exactly one
 * of each effect across the crash and the retry.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { auditCandidate, reconcilePublication, verifyPromotion } from './release-audit.mjs'
import { DispatchUnknownError, executeDispatch } from './release-agent-dispatch.mjs'
import { claimLease, createState, transitionState } from './release-state.mjs'
import { resolveCandidateVersion } from './release-version.mjs'

const SHA = 'a'.repeat(40)
const TASK_SPEC = 'Reconcile the frozen candidate and report the patch heads.'
const SLOT = 'coord:host:20261103T1700'

function target() {
  return {
    upstreamMainSha: SHA,
    stableTag: 'v1.4.242',
    stableTagSha: SHA,
    controllerSha: SHA,
    patchHeads: [{ branch: 'patch/current-main-release', commit: SHA }]
  }
}

function crashOn(step) {
  return async (argv) => {
    if (argv[1] === step) {
      throw new Error(`host died during ${step}`)
    }
  }
}

test('a crash between worker mutations creates exactly one run, one task and one worker', async () => {
  const created = { run: 0, task: 0, worker: 0 }
  let state = claimLease(createState(target()), {
    expectedVersion: 0,
    owner: 'coordinator',
    now: 1000
  })
  const persist = async (next) => {
    state = next
  }

  await assert.rejects(
    () =>
      executeDispatch({
        state,
        expectedVersion: state.version,
        owner: 'coordinator',
        objective: 'Reconcile the frozen candidate',
        taskTitle: 'Reconcile candidate conflicts',
        taskSpec: TASK_SPEC,
        slotId: SLOT,
        persist,
        run: async (argv) => {
          if (argv[1] === 'run-create') {
            created.run += 1
            return { code: 0, stdout: JSON.stringify({ result: { run: { id: 'run-1' } } }) }
          }
          if (argv[1] === 'task-create') {
            created.task += 1
            return { code: 0, stdout: JSON.stringify({ result: { task: { id: 'task-1' } } }) }
          }
          return crashOn('worker-start')(argv)
        }
      }),
    /host died during worker-start/
  )

  assert.deepEqual(created, { run: 1, task: 1, worker: 0 })
  assert.equal(state.dispatch.runId, 'run-1')
  assert.equal(state.dispatch.taskId, 'task-1')

  // Retry: only the worker mutation runs again, under the same persisted request id.
  const retried = []
  const result = await executeDispatch({
    state,
    expectedVersion: state.version,
    owner: 'coordinator',
    objective: 'Reconcile the frozen candidate',
    taskTitle: 'Reconcile candidate conflicts',
    taskSpec: TASK_SPEC,
    slotId: SLOT,
    persist,
    run: async (argv) => {
      retried.push(argv[1])
      return { code: 0, stdout: JSON.stringify({ result: { dispatchId: 'ctx_1', state: 'ready' } }) }
    }
  })

  assert.deepEqual(retried, ['worker-start'])
  assert.equal(result.dispatch.dispatchId, 'ctx_1')
  assert.equal(created.run, 1)
  assert.equal(created.task, 1)
})

test('a worker whose result is unknown keeps its ids and is never launched twice', async () => {
  let state = claimLease(createState(target()), {
    expectedVersion: 0,
    owner: 'coordinator',
    now: 1000
  })
  let launches = 0

  await assert.rejects(
    () =>
      executeDispatch({
        state,
        expectedVersion: state.version,
        owner: 'coordinator',
        objective: 'Reconcile the frozen candidate',
        taskTitle: 'Reconcile candidate conflicts',
        taskSpec: TASK_SPEC,
        slotId: SLOT,
        persist: async (next) => {
          state = next
        },
        run: async (argv) => {
          if (argv[1] === 'run-create') {
            return { runId: 'run-1' }
          }
          if (argv[1] === 'task-create') {
            return { taskId: 'task-1' }
          }
          launches += 1
          return { code: 1, stdout: '', stderr: 'transport closed' }
        }
      }),
    DispatchUnknownError
  )

  assert.equal(launches, 1)
  assert.equal(state.dispatch.taskId, 'task-1')
  assert.equal(state.dispatch.dispatchId, undefined)
})

test('a crash after the tag push reuses the tag instead of allocating a new version', () => {
  const existingTags = ['v1.4.242-mercurai.1', 'v1.4.242-mercurai.2']
  // The tag exists and the candidate recorded it before the build dispatch was lost.
  const resumed = resolveCandidateVersion({
    baseVersion: 'v1.4.242',
    existingTags,
    candidateTag: 'v1.4.242-mercurai.2'
  })
  // The unsafe path (no recorded tag) would publish the same candidate as a second version.
  const unsafe = resolveCandidateVersion({ baseVersion: 'v1.4.242', existingTags })

  assert.deepEqual(resumed, { version: 'v1.4.242-mercurai.2', reused: true })
  assert.equal(unsafe.version, 'v1.4.242-mercurai.3')
  assert.equal(unsafe.reused, false)
})

test('a crash after the publish receipt adopts the channel instead of uploading again', () => {
  let state = createState(target())
  for (const [to, evidence] of [
    ['frozen', { frozen: true }],
    ['integrating', { patchHeads: target().patchHeads, dispatchReceipt: { dispatchId: 'ctx_1' } }],
    ['qualifying', { candidateSha: SHA }],
    ['qualified', { qualified: true }],
    ['tagged', { tagSha: SHA }],
    ['packaged', { artifactDigest: 'digest-1', version: 'v1.4.242-mercurai.2' }]
  ]) {
    state = transitionState(state, { expectedVersion: state.version, to, owner: 'owner', evidence })
  }

  const channel = [{ version: 'v1.4.242-mercurai.2', digest: 'digest-1' }]
  const recovered = reconcilePublication(state, { assets: channel })

  assert.equal(recovered.action, 'adopt')
  assert.equal(reconcilePublication(state, { assets: [] }).action, 'upload')

  // Only an adopted receipt may complete the publish transition.
  const published = transitionState(state, {
    expectedVersion: state.version,
    to: 'published',
    owner: 'owner',
    evidence: { channel: 'mercurai', publicationReceipt: recovered.action }
  })
  assert.equal(published.state, 'published')
  assert.deepEqual(auditCandidate(published).missing, [])
  assert.equal(verifyPromotion(published).ok, false)
})

test('a partially recorded lifecycle never claims a step it has no receipt for', () => {
  let state = createState(target())
  state = transitionState(state, {
    expectedVersion: state.version,
    to: 'frozen',
    owner: 'owner',
    evidence: { frozen: true }
  })

  assert.deepEqual(auditCandidate(state).missing, [])
  assert.equal(verifyPromotion(state).ok, false)

  const blocked = transitionState(state, {
    expectedVersion: state.version,
    to: 'blocked',
    owner: 'owner',
    evidence: { reason: 'guard refused the range', reachedState: 'frozen' }
  })

  assert.deepEqual(auditCandidate(blocked).missing, [])
  assert.equal(verifyPromotion(blocked).ok, false)
})
