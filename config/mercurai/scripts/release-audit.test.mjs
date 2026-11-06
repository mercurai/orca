import assert from 'node:assert/strict'
import { test } from 'node:test'

import { auditCandidate, compareVersions, reconcilePublication, verifyPromotion } from './release-audit.mjs'
import { createState, transitionState } from './release-state.mjs'

const SHA = 'a'.repeat(40)
const target = {
  upstreamMainSha: SHA,
  stableTag: 'v1.4.242',
  stableTagSha: SHA,
  controllerSha: SHA,
  patchHeads: [{ branch: 'patch/current-main-release', commit: SHA }]
}

function qualifiedState() {
  let state = createState(target)
  for (const [to, evidence] of [
    ['frozen', { frozen: true }],
    ['integrating', { patchHeads: target.patchHeads, dispatchReceipt: { dispatchId: 'ctx_1' } }],
    ['qualifying', { candidateSha: SHA }],
    ['qualified', { qualified: true }]
  ]) {
    state = transitionState(state, { expectedVersion: state.version, to, owner: 'owner', evidence })
  }
  return state
}

test('audits a qualified candidate against the receipts it claims', () => {
  const audit = auditCandidate(qualifiedState())

  assert.deepEqual(audit.missing, [])
  assert.equal(audit.expected.length, 4)
  assert.equal(audit.digest.length, 64)
})

test('names the missing step instead of failing anonymously', () => {
  const state = qualifiedState()
  state.evidence = { ...state.evidence, qualified: undefined }
  const audit = auditCandidate(state)

  assert.deepEqual(audit.missing, ['candidate qualified'])
  assert.equal(verifyPromotion(state).ok, false)
  assert.match(verifyPromotion(state).reason, /audit is missing candidate qualified/)
})

test('refuses promotion when a worker never produced a dispatch receipt', () => {
  const state = qualifiedState()
  delete state.evidence.dispatchReceipt

  assert.deepEqual(auditCandidate(state).missing, ['worker dispatch receipt'])
  assert.equal(verifyPromotion(state).ok, false)
})

test('refuses promotion from a state that is not promotable', () => {
  assert.equal(verifyPromotion(createState(target)).ok, false)
  assert.match(verifyPromotion(createState(target)).reason, /not promotable/)
  assert.equal(verifyPromotion(null).ok, false)
})

test('refuses promotion when the recorded audit itself is incomplete', () => {
  const state = qualifiedState()
  state.evidence = { ...state.evidence, audit: { missing: ['installer packaged'] } }

  assert.equal(verifyPromotion(state).ok, false)
  assert.match(verifyPromotion(state).reason, /recorded audit is missing installer packaged/)
})

test('adopts an artifact that is already on the channel instead of uploading it twice', () => {
  const state = qualifiedState()
  state.evidence = { ...state.evidence, version: 'v1.4.242-mercurai.3', artifactDigest: 'digest-1' }

  assert.equal(reconcilePublication(state, { assets: [] }).action, 'upload')
  assert.equal(
    reconcilePublication(state, { assets: [{ version: 'v1.4.242-mercurai.3' }] }).action,
    'adopt'
  )
  assert.equal(
    reconcilePublication(state, {
      assets: [{ version: 'v1.4.242-mercurai.3', digest: 'digest-1' }]
    }).action,
    'adopt'
  )
})

test('never overwrites a published version with a different artifact', () => {
  const state = qualifiedState()
  state.evidence = { ...state.evidence, version: 'v1.4.242-mercurai.3', artifactDigest: 'digest-1' }
  const result = reconcilePublication(state, {
    assets: [{ version: 'v1.4.242-mercurai.3', digest: 'digest-2' }]
  })

  assert.equal(result.action, 'refuse')
  assert.match(result.reason, /different artifact/)
})

test('never moves the channel backwards', () => {
  const state = qualifiedState()
  state.evidence = { ...state.evidence, version: 'v1.4.242-mercurai.3', artifactDigest: 'digest-1' }
  const result = reconcilePublication(state, {
    assets: [{ version: 'v1.4.242-mercurai.4' }]
  })

  assert.equal(result.action, 'refuse')
  assert.match(result.reason, /newer/)
})

test('refuses publication without a reserved version or a mismatched candidate', () => {
  const state = qualifiedState()

  assert.equal(reconcilePublication(state, { assets: [] }).action, 'refuse')

  state.evidence = { ...state.evidence, version: 'v1.4.242-mercurai.3', artifactDigest: 'digest-1' }
  assert.match(
    reconcilePublication(state, { expectedVersion: 'v1.4.242-mercurai.9' }).reason,
    /not v1\.4\.242-mercurai\.9/
  )
  assert.match(
    reconcilePublication(state, { expectedDigest: 'other' }).reason,
    /artifact digest does not match/
  )
})

test('orders fork versions numerically, not lexicographically', () => {
  assert.equal(compareVersions('v1.4.242-mercurai.10', 'v1.4.242-mercurai.9'), 1)
  assert.equal(compareVersions('v1.4.243-mercurai.1', 'v1.4.242-mercurai.10'), 1)
  assert.ok(compareVersions('v1.4.242', 'v1.4.242-mercurai.1') < 0)
  assert.equal(compareVersions('nonsense', 'v1.4.242'), 0)
})
