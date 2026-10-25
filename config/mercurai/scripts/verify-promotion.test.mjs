import assert from 'node:assert/strict'
import { test } from 'node:test'

import { verifyPromotion } from './verify-promotion.mjs'

const SHA = 'a'.repeat(40)
const TREE = 'b'.repeat(40)
const CONTROLLER = 'c'.repeat(40)
const MANIFEST = 'd'.repeat(40)
const POLICY = 'e'.repeat(64)

const policy = {
  schemaVersion: 1,
  workflow: 'fork-qualify-release.yml',
  requiredChecks: ['test / tests node 24 2/5', 'PR checks passed'],
  permittedSkips: []
}

function evidence(overrides = {}) {
  return {
    candidate: {
      commit: SHA,
      tree: TREE,
      controllerSha: CONTROLLER,
      manifestSha: MANIFEST,
      policySha: POLICY,
      version: '1.4.239-mercurai.3',
      upstreamMainSha: SHA,
      series: [{ branch: 'patch/current-main-release', commit: SHA }]
    },
    qualification: {
      workflow: 'fork-qualify-release.yml',
      runId: 40123456789,
      attempt: 2,
      latestAttempt: 2,
      checkoutSha: SHA,
      checkoutTree: TREE,
      controllerSha: CONTROLLER,
      manifestSha: MANIFEST,
      policySha: POLICY,
      mode: 'full',
      series: [{ branch: 'patch/current-main-release', commit: SHA }],
      conclusion: 'success',
      checks: [
        { name: 'test / tests node 24 2/5', conclusion: 'success' },
        { name: 'PR checks passed', conclusion: 'success' }
      ]
    },
    review: {
      verdict: 'approved',
      reviewedSha: SHA,
      controllerSha: CONTROLLER,
      reviewer: 'independent-reviewer'
    },
    ...overrides
  }
}

test('accepts complete full qualification at the exact candidate revision', () => {
  const result = verifyPromotion(evidence(), policy)

  assert.deepEqual(result, { ok: true, reasons: [] })
})

test('rejects a failed required shard even when targeted checks passed', () => {
  const input = evidence()
  input.qualification.checks[0].conclusion = 'failure'

  const result = verifyPromotion(input, policy)

  assert.equal(result.ok, false)
  assert.match(result.reasons.join('\n'), /test \/ tests node 24 2\/5.*failure/i)
})

test('rejects a missing or forged aggregate check', () => {
  const input = evidence()
  input.qualification.checks = [{ name: 'test / tests node 24 2/5', conclusion: 'success' }]

  const result = verifyPromotion(input, policy)

  assert.equal(result.ok, false)
  assert.match(result.reasons.join('\n'), /PR checks passed.*missing/i)
})

test('rejects selected-test or draft qualification presented as full CI', () => {
  const input = evidence()
  input.qualification.mode = 'selected'
  input.qualification.event = 'pull_request'

  const result = verifyPromotion(input, policy)

  assert.equal(result.ok, false)
  assert.match(result.reasons.join('\n'), /full/i)
})

test('rejects stale reviews and a pending latest rerun', () => {
  const input = evidence({
    qualification: {
      ...evidence().qualification,
      attempt: 1,
      latestAttempt: 2,
      conclusion: 'pending'
    },
    review: { verdict: 'approved', reviewedSha: 'f'.repeat(40), controllerSha: CONTROLLER, reviewer: 'reviewer' }
  })

  const result = verifyPromotion(input, policy)

  assert.equal(result.ok, false)
  assert.match(result.reasons.join('\n'), /latest attempt|review.*candidate/i)
})

test('rejects a different commit with the same tree', () => {
  const input = evidence()
  input.qualification.checkoutSha = 'f'.repeat(40)

  const result = verifyPromotion(input, policy)

  assert.equal(result.ok, false)
  assert.match(result.reasons.join('\n'), /commit/i)
})

test('rejects controller, manifest, or policy drift after review', () => {
  const input = evidence()
  input.qualification.controllerSha = 'f'.repeat(40)
  input.qualification.manifestSha = 'f'.repeat(40)
  input.qualification.policySha = 'f'.repeat(64)

  const result = verifyPromotion(input, policy)

  assert.equal(result.ok, false)
  assert.match(result.reasons.join('\n'), /controller|manifest|policy/i)
})

test('rejects unexpected skipped checks and permits only policy-listed skips', () => {
  const input = evidence()
  input.qualification.checks[1].conclusion = 'skipped'

  const blocked = verifyPromotion(input, policy)
  assert.equal(blocked.ok, false)
  assert.match(blocked.reasons.join('\n'), /skipped/i)

  const permitted = verifyPromotion(input, { ...policy, permittedSkips: ['PR checks passed'] })
  assert.equal(permitted.ok, true)
})
