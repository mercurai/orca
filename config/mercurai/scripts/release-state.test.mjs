import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  STATE_SCHEMA_VERSION,
  StateConflictError,
  activateQueuedTarget,
  assertStateSchema,
  claimLease,
  clearParked,
  computeTargetDigest,
  createState,
  enqueueTarget,
  findApproval,
  findParked,
  parkItem,
  recordApproval,
  recordEvaluation,
  summarizeQueue,
  transitionState
} from './release-state.mjs'

const SHA = 'a'.repeat(40)

function target(overrides = {}) {
  return {
    upstreamMainSha: SHA,
    stableTag: 'v1.4.239',
    stableTagSha: SHA,
    controllerSha: SHA,
    patchHeads: [{ branch: 'patch/current-main-release', commit: SHA }],
    ...overrides
  }
}

test('creates a durable candidate state with an explicit generation and no secrets', () => {
  const state = createState(target(), { now: '2026-10-24T20:00:00.000Z' })

  assert.equal(state.state, 'detected')
  assert.equal(state.version, 0)
  assert.equal(state.generation, 1)
  assert.deepEqual(state.candidate, target())
  assert.doesNotMatch(JSON.stringify(state), /token|password|secret|transcript|credential/i)
})

test('rejects stale compare-and-swap updates and retains the original state', () => {
  const state = createState(target())

  assert.throws(
    () => transitionState(state, { expectedVersion: 1, to: 'frozen', owner: 'coordinator' }),
    StateConflictError
  )
  assert.equal(state.state, 'detected')
  assert.equal(state.version, 0)
})

test('accepts a resolved stable tag commit and treats controller changes as a new target', () => {
  const state = createState(target())
  const next = enqueueTarget(
    state,
    target({ controllerSha: 'b'.repeat(40), stableTagSha: 'c'.repeat(40) })
  )

  assert.equal(next.queuedTarget.controllerSha, 'b'.repeat(40))
  assert.equal(next.queuedTarget.stableTagSha, 'c'.repeat(40))
})

test('validates an optional patch base when candidate identity includes it', () => {
  assert.doesNotThrow(() =>
    createState(
      target({ patchHeads: [{ branch: 'patch/current-main-release', commit: SHA, base: SHA }] })
    )
  )
  assert.throws(
    () =>
      createState(
        target({
          patchHeads: [{ branch: 'patch/current-main-release', commit: SHA, base: 'not-a-sha' }]
        })
      ),
    /base must be a lowercase 40-character sha/
  )
})

test('accepts the ordered candidate lifecycle and records evidence at each boundary', () => {
  let state = createState(target())
  for (const [to, evidence] of [
    ['frozen', { frozen: true }],
    ['integrating', { patchHeads: target().patchHeads }],
    ['qualifying', { candidateSha: SHA }],
    ['qualified', { qualified: true }],
    ['tagged', { tagSha: SHA }],
    ['packaged', { artifactDigest: SHA }],
    ['published', { channel: 'mercurai' }]
  ]) {
    state = transitionState(state, {
      expectedVersion: state.version,
      to,
      owner: 'release-owner',
      evidence
    })
  }

  assert.equal(state.state, 'published')
  assert.equal(state.version, 7)
  assert.equal(state.evidence.qualified, true)
  assert.equal(state.evidence.channel, 'mercurai')
})

test('rejects skipping a lifecycle stage or advancing without required evidence', () => {
  const state = createState(target())

  assert.throws(
    () => transitionState(state, { expectedVersion: 0, to: 'qualified', owner: 'owner' }),
    /invalid transition/i
  )
  const frozen = transitionState(state, { expectedVersion: 0, to: 'frozen', owner: 'owner' })
  assert.throws(
    () =>
      transitionState(frozen, { expectedVersion: frozen.version, to: 'qualified', owner: 'owner' }),
    /invalid transition/i
  )
})

test('leases one generation and refuses a second owner until the lease expires', () => {
  const state = createState(target())
  const claimed = claimLease(state, {
    expectedVersion: 0,
    owner: 'worker-a',
    now: 1000,
    leaseMs: 100
  })

  assert.equal(claimed.lease.owner, 'worker-a')
  assert.throws(
    () =>
      claimLease(claimed, {
        expectedVersion: claimed.version,
        owner: 'worker-b',
        now: 1050,
        leaseMs: 100
      }),
    /lease/i
  )
  const reclaimed = claimLease(claimed, {
    expectedVersion: claimed.version,
    owner: 'worker-b',
    now: 1200,
    leaseMs: 100
  })
  assert.equal(reclaimed.lease.owner, 'worker-b')
})

test('coalesces later upstream targets while an active candidate remains frozen', () => {
  const first = createState(target())
  const queued = enqueueTarget(first, target({ upstreamMainSha: 'b'.repeat(40) }))
  const replaced = enqueueTarget(queued, target({ upstreamMainSha: 'c'.repeat(40) }))

  assert.equal(replaced.candidate.upstreamMainSha, SHA)
  assert.equal(replaced.queuedTarget.upstreamMainSha, 'c'.repeat(40))
  assert.equal(replaced.version, 2)
})

test('activates the newest queued target only after the prior candidate is terminal', () => {
  let state = createState(target())
  state = enqueueTarget(state, target({ upstreamMainSha: 'b'.repeat(40) }), {
    now: '2026-10-24T20:01:00.000Z'
  })
  assert.throws(
    () => activateQueuedTarget(state, { expectedVersion: state.version }),
    /cannot activate.*detected/i
  )
  state = transitionState(state, { expectedVersion: state.version, to: 'frozen', owner: 'owner' })
  state = transitionState(state, {
    expectedVersion: state.version,
    to: 'integrating',
    owner: 'owner'
  })
  state = transitionState(state, {
    expectedVersion: state.version,
    to: 'qualifying',
    owner: 'owner'
  })
  state = transitionState(state, {
    expectedVersion: state.version,
    to: 'qualified',
    owner: 'owner',
    evidence: { qualified: true }
  })
  state = transitionState(state, {
    expectedVersion: state.version,
    to: 'tagged',
    owner: 'owner',
    evidence: { tagSha: SHA }
  })
  state = transitionState(state, {
    expectedVersion: state.version,
    to: 'packaged',
    owner: 'owner',
    evidence: { artifactDigest: SHA }
  })
  state = transitionState(state, {
    expectedVersion: state.version,
    to: 'published',
    owner: 'owner',
    evidence: { channel: 'mercurai' }
  })
  const next = activateQueuedTarget(state, {
    expectedVersion: state.version,
    now: '2026-10-24T20:02:00.000Z'
  })
  assert.equal(next.state, 'detected')
  assert.equal(next.generation, 2)
  assert.equal(next.candidate.upstreamMainSha, 'b'.repeat(40))
  assert.equal(next.queuedTarget, null)
})

test('refuses state written by a different schema instead of guessing its fields', () => {
  const state = createState(target())

  assert.equal(assertStateSchema(state).schemaVersion, STATE_SCHEMA_VERSION)
  assert.throws(
    () => assertStateSchema({ ...state, schemaVersion: STATE_SCHEMA_VERSION + 1 }),
    /schemaVersion .* is not supported/
  )
  assert.throws(() => assertStateSchema(null), /state is required/)
})

test('derives one canonical digest per candidate identity and ignores field order', () => {
  const digest = computeTargetDigest(target())
  const reordered = {
    controllerSha: target().controllerSha,
    patchHeads: target().patchHeads,
    stableTag: target().stableTag,
    stableTagSha: target().stableTagSha,
    upstreamMainSha: target().upstreamMainSha
  }

  assert.equal(computeTargetDigest(reordered), digest)
  assert.notEqual(computeTargetDigest(target({ upstreamMainSha: 'b'.repeat(40) })), digest)
  assert.match(digest, /^[0-9a-f]{64}$/)
})

test('does not re-queue an identical target, so an idle hour costs no version', () => {
  const state = createState(target())
  const queued = enqueueTarget(state, target({ upstreamMainSha: 'b'.repeat(40) }))
  const again = enqueueTarget(queued, target({ upstreamMainSha: 'b'.repeat(40) }))

  assert.equal(again.version, queued.version)
  assert.deepEqual(again.queuedTarget, queued.queuedTarget)
})

test('counts consecutive no-change evaluations and resets the counter on real work', () => {
  let state = createState(target())
  state = recordEvaluation(state, { digest: 'd1', changed: false, now: 1000 })
  state = recordEvaluation(state, { digest: 'd1', changed: false, now: 2000 })

  assert.equal(state.skipped, 2)
  assert.equal(state.lastEvaluatedDigest, 'd1')
  assert.equal(summarizeQueue(state, { now: 2000 }).skipped, 2)

  state = recordEvaluation(state, { digest: 'd2', changed: true, now: 3000 })
  assert.equal(state.skipped, 0)
  assert.equal(state.lastEvaluatedDigest, 'd2')
})

test('parks a blocked item once, keeps the rest of the queue moving, and clears it by identity', () => {
  let state = createState(target())
  state = parkItem(
    state,
    { kind: 'tag-approval', key: 'v1.4.247', reason: 'owner review pending' },
    { now: 1000 }
  )
  state = parkItem(
    state,
    { kind: 'tag-approval', key: 'v1.4.247', reason: 'owner review pending (updated)' },
    { now: 2000 }
  )

  assert.equal(state.parked.length, 1)
  assert.equal(state.parked[0].reason, 'owner review pending (updated)')
  assert.equal(findParked(state, { kind: 'tag-approval', key: 'v1.4.247' }).key, 'v1.4.247')

  const summary = summarizeQueue(state, { now: 2000 })
  assert.equal(summary.parkedCount, 1)
  assert.equal(summary.eligible, true)

  const cleared = clearParked(state, { kind: 'tag-approval', key: 'v1.4.247' })
  assert.equal(cleared.parked.length, 0)
  assert.equal(clearParked(cleared, { kind: 'tag-approval', key: 'v1.4.247' }).version, cleared.version)
})

test('remembers an approval for exactly one reviewed range and asks again when the range moves', () => {
  let state = createState(target())
  state = recordApproval(
    state,
    {
      kind: 'guarded-merge',
      key: 'guarded-merge',
      approver: 'owner',
      sha: SHA,
      rangeDigest: 'range-1'
    },
    { now: 1000 }
  )

  assert.equal(
    findApproval(state, { key: 'guarded-merge', approver: 'owner', rangeDigest: 'range-1' }).sha,
    SHA
  )
  assert.equal(
    findApproval(state, { key: 'guarded-merge', approver: 'owner', rangeDigest: 'range-2' }),
    null
  )
  assert.equal(
    findApproval(state, { key: 'guarded-merge', approver: 'lane', rangeDigest: 'range-1' }),
    null
  )
  assert.throws(
    () =>
      recordApproval(state, {
        kind: 'guarded-merge',
        key: 'guarded-merge',
        approver: 'owner',
        sha: 'not-a-sha',
        rangeDigest: 'range-1'
      }),
    /sha must be a lowercase 40-character sha/
  )
})

test('re-recording the same approval keeps one entry', () => {
  const args = {
    kind: 'guarded-merge',
    key: 'guarded-merge',
    approver: 'owner',
    sha: SHA,
    rangeDigest: 'range-1'
  }
  const once = recordApproval(createState(target()), args, { now: 1000 })
  const twice = recordApproval(once, args, { now: 2000 })

  assert.equal(twice.approvalMemo['guarded-merge'].length, 1)
})

test('reports the live lease owner and the queued digest to an operator', () => {
  let state = claimLease(createState(target()), { expectedVersion: 0, owner: 'worker-a', now: 1000, leaseMs: 100 })
  state = enqueueTarget(state, target({ upstreamMainSha: 'b'.repeat(40) }))

  assert.equal(summarizeQueue(state, { now: 1050 }).lease, 'worker-a')
  assert.equal(summarizeQueue(state, { now: 1200 }).lease, null)
  assert.equal(summarizeQueue(state, { now: 1200 }).queued, computeTargetDigest(state.queuedTarget))
  assert.equal(summarizeQueue(state, { now: 1200 }).digest, computeTargetDigest(state.candidate))
})
