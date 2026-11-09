import assert from 'node:assert/strict'
import { test } from 'node:test'

import { claimLease, computeTargetDigest, createState, recordEvaluation } from './release-state.mjs'
import { checkEligibility, evaluateGate } from './release-precheck.mjs'

const SHA = 'a'.repeat(40)
const target = {
  upstreamMainSha: SHA,
  stableTag: 'v1.4.239',
  controllerSha: SHA,
  patchHeads: [{ branch: 'patch/current-main-release', commit: SHA }]
}

test('admits a detected candidate when no worker owns its lease', () => {
  assert.deepEqual(checkEligibility(createState(target), { now: 1000 }), {
    eligible: true,
    reason: null
  })
})

test('returns a nonzero-style reason for an empty or completed queue', () => {
  assert.equal(checkEligibility(null, { now: 1000 }).eligible, false)
  assert.equal(
    checkEligibility({ state: 'published', candidate: null }, { now: 1000 }).eligible,
    false
  )
})

test('does not dispatch a candidate with recorded upstream conflicts', () => {
  const state = createState(target)
  state.evidence = { conflictInventory: { status: 'conflict', conflictCount: 2 } }

  assert.deepEqual(checkEligibility(state, { now: 1000 }), {
    eligible: false,
    reason: 'candidate has 2 unresolved upstream conflicts'
  })
})

test('does not dispatch a duplicate worker while the current lease is live', () => {
  const state = claimLease(createState(target), {
    expectedVersion: 0,
    owner: 'worker-a',
    now: 1000,
    leaseMs: 100
  })
  const result = checkEligibility(state, { now: 1050 })

  assert.equal(result.eligible, false)
  assert.match(result.reason, /lease/i)
})

test('reconciles an expired lease instead of treating it as a live worker', () => {
  const state = claimLease(createState(target), {
    expectedVersion: 0,
    owner: 'worker-a',
    now: 1000,
    leaseMs: 100
  })
  const result = checkEligibility(state, { now: 1200 })

  assert.deepEqual(result, { eligible: true, reason: null })
})

test('runs when the candidate identity has never been evaluated', () => {
  const state = createState(target)
  const gate = evaluateGate(state, { now: 1000 })

  assert.equal(gate.decision, 'run')
  assert.equal(gate.changed, true)
  assert.equal(gate.digest, computeTargetDigest(state.candidate))
})

test('skips an hour whose candidate identity was already evaluated', () => {
  const state = recordEvaluation(createState(target), {
    digest: computeTargetDigest(createState(target).candidate),
    changed: true,
    now: 1000
  })
  const gate = evaluateGate(state, { now: 2000 })

  assert.equal(gate.decision, 'skip')
  assert.equal(gate.changed, false)
  assert.match(gate.reason, /unchanged since the last evaluation/)
  assert.equal(gate.skipped, 0)
})

test('force re-runs an unchanged candidate without inventing a change', () => {
  const state = recordEvaluation(createState(target), {
    digest: computeTargetDigest(createState(target).candidate),
    changed: true,
    now: 1000
  })

  assert.equal(evaluateGate(state, { now: 2000, force: true }).decision, 'run')
})

test('refuses rather than skips when the queue itself is blocked', () => {
  const state = createState(target)
  state.evidence = { conflictInventory: { status: 'conflict', conflictCount: 3 } }
  const gate = evaluateGate(state, { now: 1000 })

  assert.equal(gate.decision, 'refuse')
  assert.equal(gate.eligible, false)
  assert.match(gate.reason, /3 unresolved upstream conflicts/)
})

test('refuses an unknown state schema and unreadable state', () => {
  const unknown = { ...createState(target), schemaVersion: 99 }

  assert.equal(evaluateGate(unknown, { now: 1000 }).decision, 'refuse')
  assert.match(evaluateGate(unknown, { now: 1000 }).reason, /schemaVersion 99/)
  assert.equal(evaluateGate(null, { now: 1000 }).decision, 'refuse')
})
