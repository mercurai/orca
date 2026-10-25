import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  StateConflictError,
  activateQueuedTarget,
  claimLease,
  createState,
  enqueueTarget,
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
    state = transitionState(state, { expectedVersion: state.version, to, owner: 'release-owner', evidence })
  }

  assert.equal(state.state, 'published')
  assert.equal(state.version, 7)
  assert.equal(state.evidence.qualified, true)
  assert.equal(state.evidence.channel, 'mercurai')
})

test('rejects skipping a lifecycle stage or advancing without required evidence', () => {
  const state = createState(target())

  assert.throws(() => transitionState(state, { expectedVersion: 0, to: 'qualified', owner: 'owner' }), /invalid transition/i)
  const frozen = transitionState(state, { expectedVersion: 0, to: 'frozen', owner: 'owner' })
  assert.throws(
    () => transitionState(frozen, { expectedVersion: frozen.version, to: 'qualified', owner: 'owner' }),
    /invalid transition/i
  )
})

test('leases one generation and refuses a second owner until the lease expires', () => {
  const state = createState(target())
  const claimed = claimLease(state, { expectedVersion: 0, owner: 'worker-a', now: 1000, leaseMs: 100 })

  assert.equal(claimed.lease.owner, 'worker-a')
  assert.throws(
    () => claimLease(claimed, { expectedVersion: claimed.version, owner: 'worker-b', now: 1050, leaseMs: 100 }),
    /lease/i
  )
  const reclaimed = claimLease(claimed, { expectedVersion: claimed.version, owner: 'worker-b', now: 1200, leaseMs: 100 })
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
  state = enqueueTarget(state, target({ upstreamMainSha: 'b'.repeat(40) }), { now: '2026-10-24T20:01:00.000Z' })
  assert.throws(
    () => activateQueuedTarget(state, { expectedVersion: state.version }),
    /cannot activate.*detected/i
  )
  state = transitionState(state, { expectedVersion: state.version, to: 'frozen', owner: 'owner' })
  state = transitionState(state, { expectedVersion: state.version, to: 'integrating', owner: 'owner' })
  state = transitionState(state, { expectedVersion: state.version, to: 'qualifying', owner: 'owner' })
  state = transitionState(state, { expectedVersion: state.version, to: 'qualified', owner: 'owner', evidence: { qualified: true } })
  state = transitionState(state, { expectedVersion: state.version, to: 'tagged', owner: 'owner', evidence: { tagSha: SHA } })
  state = transitionState(state, { expectedVersion: state.version, to: 'packaged', owner: 'owner', evidence: { artifactDigest: SHA } })
  state = transitionState(state, { expectedVersion: state.version, to: 'published', owner: 'owner', evidence: { channel: 'mercurai' } })
  const next = activateQueuedTarget(state, { expectedVersion: state.version, now: '2026-10-24T20:02:00.000Z' })
  assert.equal(next.state, 'detected')
  assert.equal(next.generation, 2)
  assert.equal(next.candidate.upstreamMainSha, 'b'.repeat(40))
  assert.equal(next.queuedTarget, null)
})
