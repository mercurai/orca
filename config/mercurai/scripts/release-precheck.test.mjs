import assert from 'node:assert/strict'
import { test } from 'node:test'

import { claimLease, createState } from './release-state.mjs'
import { checkEligibility } from './release-precheck.mjs'

const SHA = 'a'.repeat(40)
const target = {
  upstreamMainSha: SHA,
  stableTag: 'v1.4.239',
  controllerSha: SHA,
  patchHeads: [{ branch: 'patch/current-main-release', commit: SHA }]
}

test('admits a detected candidate when no worker owns its lease', () => {
  assert.deepEqual(checkEligibility(createState(target), { now: 1000 }), { eligible: true, reason: null })
})

test('returns a nonzero-style reason for an empty or completed queue', () => {
  assert.equal(checkEligibility(null, { now: 1000 }).eligible, false)
  assert.equal(checkEligibility({ state: 'published', candidate: null }, { now: 1000 }).eligible, false)
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
  const state = claimLease(createState(target), { expectedVersion: 0, owner: 'worker-a', now: 1000, leaseMs: 100 })
  const result = checkEligibility(state, { now: 1050 })

  assert.equal(result.eligible, false)
  assert.match(result.reason, /lease/i)
})

test('reconciles an expired lease instead of treating it as a live worker', () => {
  const state = claimLease(createState(target), { expectedVersion: 0, owner: 'worker-a', now: 1000, leaseMs: 100 })
  const result = checkEligibility(state, { now: 1200 })

  assert.deepEqual(result, { eligible: true, reason: null })
})
