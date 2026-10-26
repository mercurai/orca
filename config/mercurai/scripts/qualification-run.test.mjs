import assert from 'node:assert/strict'
import { test } from 'node:test'

import { selectQualificationRun, verifyQualificationRun } from './qualification-run.mjs'

const expected = {
  repository: 'mercurai/orca',
  workflowId: 41,
  workflowPath: '.github/workflows/fork-qualify-release.yml',
  branch: 'mercurai',
  dispatchId: 'assembly-77-1',
  startedAt: '2026-10-26T12:00:00Z',
  runId: 81,
  candidate: {
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    controllerSha: 'c'.repeat(40),
    manifestSha: 'd'.repeat(40),
    policySha: 'e'.repeat(64),
    version: '1.4.239-mercurai.3',
    series: [`patch/first:${'f'.repeat(40)}`, `patch/second:${'1'.repeat(40)}`]
  }
}
const policy = {
  promotionEnabled: true,
  workflow: 'fork-qualify-release.yml',
  requiredChecks: ['test / tests node 24 2/5', 'PR checks passed'],
  permittedSkips: []
}

function run(overrides = {}) {
  return {
    id: expected.runId,
    repository: { full_name: expected.repository },
    workflow_id: expected.workflowId,
    path: expected.workflowPath,
    event: 'workflow_dispatch',
    head_branch: expected.branch,
    head_sha: expected.candidate.controllerSha,
    display_title: `qualify ${expected.dispatchId}`,
    created_at: '2026-10-26T12:00:01Z',
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    ...overrides
  }
}

function receipt() {
  return {
    candidate: structuredClone(expected.candidate),
    qualification: {
      workflow: policy.workflow,
      dispatchId: expected.dispatchId,
      runId: expected.runId,
      attempt: 1,
      latestAttempt: 1,
      checkoutSha: expected.candidate.commit,
      checkoutTree: expected.candidate.tree,
      controllerSha: expected.candidate.controllerSha,
      manifestSha: expected.candidate.manifestSha,
      policySha: expected.candidate.policySha,
      mode: 'full',
      conclusion: 'success',
      series: [...expected.candidate.series],
      checks: policy.requiredChecks.map((name) => ({ name, conclusion: 'success' }))
    },
    review: {
      verdict: 'approved',
      reviewedSha: expected.candidate.commit,
      controllerSha: expected.candidate.controllerSha,
      reviewer: 'synthetic-reviewer'
    }
  }
}

function pages(...runs) {
  return [{ total_count: runs.length, workflow_runs: runs }]
}

function verify(changes = {}) {
  return verifyQualificationRun({ receipt: receipt(), run: run(), expected, ...changes }, policy)
}

function assertRefused(result) {
  assert.equal(result.ok, false)
  assert.ok(result.reasons.length > 0)
}

test('selects the qualification run with the exact dispatch identity', () => {
  assert.equal(selectQualificationRun(pages(run()), expected), expected.runId)
})

test('ignores a newer qualification for another dispatch under the same controller', () => {
  const unrelated = run({
    id: 82,
    display_title: 'qualify another-dispatch',
    created_at: '2026-10-26T12:00:02Z'
  })

  assert.equal(selectQualificationRun(pages(run(), unrelated), expected), expected.runId)
})

test('finds the exact qualification beyond the first page', () => {
  const unrelated = Array.from({ length: 10 }, (_, index) =>
    run({
      id: 100 + index,
      display_title: `qualify unrelated-${index}`
    })
  )
  const paginated = [
    { total_count: 11, workflow_runs: unrelated },
    { total_count: 11, workflow_runs: [run()] }
  ]

  assert.equal(selectQualificationRun(paginated, expected), expected.runId)
})

test('returns no match while this dispatch is not yet visible', () => {
  assert.equal(
    selectQualificationRun(pages(run({ display_title: 'qualify unrelated' })), expected),
    null
  )
})

test('refuses two runs claiming the same dispatch identity', () => {
  assert.throws(() => selectQualificationRun(pages(run(), run({ id: 82 })), expected), /ambiguous/i)
})

test('refuses an incomplete page collection', () => {
  const incomplete = [{ total_count: 2, workflow_runs: [run()] }]

  assert.throws(() => selectQualificationRun(incomplete, expected), /incomplete/i)
})

test('refuses a malformed page rather than treating it as an empty result', () => {
  assert.throws(
    () => selectQualificationRun([{ workflow_runs: [] }], expected),
    /invalid|malformed/i
  )
})

test('refuses a filtered API result beyond the documented search limit', () => {
  assert.throws(
    () => selectQualificationRun([{ total_count: 1001, workflow_runs: [run()] }], expected),
    /truncat|limit|incomplete/i
  )
})

for (const [field, value] of [
  ['repository', { full_name: 'another/repo' }],
  ['workflow_id', 42],
  ['path', '.github/workflows/another.yml'],
  ['event', 'push'],
  ['head_branch', 'another-branch'],
  ['head_sha', '2'.repeat(40)]
]) {
  test(`does not select a matching title with the wrong ${field}`, () => {
    assert.equal(selectQualificationRun(pages(run({ [field]: value })), expected), null)
  })
}

test('accepts a successful current run and receipt for the externally expected candidate', () => {
  assert.deepEqual(verify(), { ok: true, reasons: [] })
})

for (const field of [
  'commit',
  'tree',
  'controllerSha',
  'manifestSha',
  'policySha',
  'version',
  'series'
]) {
  test(`refuses an internally consistent receipt for an unexpected candidate ${field}`, () => {
    const changed = receipt()
    const replacement =
      field === 'series'
        ? expected.candidate.series.toReversed()
        : field === 'version'
          ? '1.4.239-mercurai.4'
          : '3'.repeat(field === 'policySha' ? 64 : 40)
    changed.candidate[field] = replacement
    const qualificationFields = {
      commit: 'checkoutSha',
      tree: 'checkoutTree',
      controllerSha: 'controllerSha',
      manifestSha: 'manifestSha',
      policySha: 'policySha',
      series: 'series'
    }
    if (qualificationFields[field]) {
      changed.qualification[qualificationFields[field]] = replacement
    }
    if (field === 'commit') {
      changed.review.reviewedSha = replacement
    }
    if (field === 'controllerSha') {
      changed.review.controllerSha = replacement
    }

    assertRefused(verify({ receipt: changed }))
  })
}

for (const [field, value] of [
  ['id', 82],
  ['repository', { full_name: 'another/repo' }],
  ['workflow_id', 42],
  ['path', '.github/workflows/another.yml'],
  ['event', 'push'],
  ['head_branch', 'another-branch'],
  ['head_sha', '2'.repeat(40)],
  ['display_title', 'qualify another-dispatch'],
  ['status', 'in_progress'],
  ['conclusion', 'failure'],
  ['run_attempt', 2]
]) {
  test(`refuses promotion when current run ${field} does not match its receipt and expectation`, () => {
    assertRefused(verify({ run: run({ [field]: value }) }))
  })
}

test('refuses a receipt bearing another dispatch identity', () => {
  const changed = receipt()
  changed.qualification.dispatchId = 'assembly-78-1'

  assertRefused(verify({ receipt: changed }))
})

test('refuses absent receipt evidence even when the watched run succeeded', () => {
  assertRefused(verify({ receipt: null }))
})

test('preserves the disabled production promotion policy', () => {
  const result = verifyQualificationRun(
    { receipt: receipt(), run: run(), expected },
    { ...policy, promotionEnabled: false }
  )

  assertRefused(result)
})
