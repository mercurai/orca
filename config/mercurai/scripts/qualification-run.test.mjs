import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { selectQualificationRun, verifyQualificationRun } from './qualification-run.mjs'

const NOW = Date.parse('2026-10-26T12:00:00Z')
const OWNER = { login: 'synthetic-owner', id: 7 }
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
    series: [`patch/first:${'f'.repeat(40)}`, `patch/second:${'1'.repeat(40)}`],
    upstream: {
      repository: 'stablyai/orca',
      mainSha: '2'.repeat(40),
      stableTag: 'v1.4.239',
      stableCommit: '3'.repeat(40)
    }
  }
}
const policy = {
  schemaVersion: 1,
  promotionEnabled: true,
  workflow: 'fork-qualify-release.yml',
  requiredChecks: ['test / tests node 24 2/5', 'PR checks passed'],
  permittedSkips: [],
  review: {
    workflowPath: '.github/workflows/fork-accept-release-review.yml',
    controllerRef: 'refs/heads/mercurai',
    owners: [OWNER]
  }
}

function reviewContext() {
  return {
    expected: {
      repository: expected.repository,
      workflowId: 91,
      controllerRef: policy.review.controllerRef,
      runId: 101,
      attempt: 2,
      candidate: structuredClone(expected.candidate)
    },
    run: {
      id: 101,
      workflow_id: 91,
      repository: { full_name: expected.repository },
      path: policy.review.workflowPath,
      event: 'workflow_dispatch',
      head_branch: expected.branch,
      head_sha: expected.candidate.controllerSha,
      run_attempt: 2,
      status: 'completed',
      conclusion: 'success',
      actor: { ...OWNER },
      triggering_actor: { ...OWNER }
    },
    artifact: {
      id: 303,
      name: 'release-review-101-2',
      expired: false,
      expires_at: '2026-11-01T00:00:00Z',
      size_in_bytes: 4096,
      digest: `sha256:${'4'.repeat(64)}`,
      workflow_run: {
        id: 101,
        head_branch: expected.branch,
        head_sha: expected.candidate.controllerSha
      }
    },
    archiveSha256: '4'.repeat(64)
  }
}

function acceptance() {
  return {
    schemaVersion: 1,
    scope: 'candidate-and-controller',
    verdict: 'approved',
    ownerAccepted: true,
    openBlockers: [],
    candidate: structuredClone(expected.candidate),
    reviewer: {
      identity: 'synthetic-independent-reviewer',
      independent: true,
      evidenceSummary: 'Reviewed full candidate and controller without blockers.',
      evidenceSha256: '5'.repeat(64)
    },
    authentication: {
      repository: expected.repository,
      workflowId: 91,
      workflowPath: policy.review.workflowPath,
      controllerRef: policy.review.controllerRef,
      controllerSha: expected.candidate.controllerSha,
      runId: 101,
      attempt: 2,
      actor: { ...OWNER },
      triggeringActor: { ...OWNER }
    }
  }
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
    review: acceptance()
  }
}

function pages(...runs) {
  return [{ total_count: runs.length, workflow_runs: runs }]
}

function verify(changes = {}) {
  return verifyQualificationRun(
    { receipt: receipt(), run: run(), expected, reviewContext: reviewContext(), ...changes },
    policy,
    () => NOW
  )
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

for (const invalid of [
  null,
  'invalid',
  {},
  { id: 0 },
  { id: '81' },
  { id: 81 },
  run({ created_at: 'invalid' })
]) {
  test(`refuses a malformed run row ${JSON.stringify(invalid)}`, () => {
    assert.throws(() => selectQualificationRun(pages(invalid), expected), /invalid|malformed/i)
  })
}

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
  test(`does not select a matching title with the wrong ${String(field)}`, () => {
    assert.equal(selectQualificationRun(pages(run({ [field]: value })), expected), null)
  })
}

test('accepts a successful current run and receipt for the externally expected candidate', () => {
  assert.deepEqual(verify(), { ok: true, reasons: [] })
})

test('refuses qualification without separately fetched owner review context', () => {
  const result = verify({ reviewContext: undefined })
  assertRefused(result)
  assert.match(result.reasons.join('\n'), /review.*external|external.*review/)
})

test('refuses a stale accepted review attempt after a newer review rerun starts', () => {
  const context = reviewContext()
  context.run.run_attempt += 1
  context.run.status = 'in_progress'
  context.run.conclusion = null
  const result = verify({ reviewContext: context })
  assertRefused(result)
  assert.match(result.reasons.join('\n'), /review live run.*latest/)
})

test('refuses self-consistent review context from another repository', () => {
  const changed = receipt()
  const context = reviewContext()
  context.expected.repository = 'another/orca'
  context.run.repository.full_name = 'another/orca'
  changed.review.authentication.repository = 'another/orca'
  const result = verify({ receipt: changed, reviewContext: context })
  assertRefused(result)
  assert.match(result.reasons.join('\n'), /review context repository/)
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
    changed.review.candidate[field] = structuredClone(replacement)
    const context = reviewContext()
    context.expected.candidate[field] = structuredClone(replacement)
    if (field === 'controllerSha') {
      changed.review.authentication.controllerSha = replacement
      context.run.head_sha = replacement
      context.artifact.workflow_run.head_sha = replacement
    }

    const result = verify({ receipt: changed, reviewContext: context })
    assertRefused(result)
    assert.match(result.reasons.join('\n'), /receipt candidate|receipt ordered series/)
  })
}

test('refuses an internally consistent acceptance for a different external upstream tuple', () => {
  for (const [key, replacement] of [
    ['repository', 'another/orca'],
    ['mainSha', '6'.repeat(40)],
    ['stableTag', 'v1.4.240'],
    ['stableCommit', '7'.repeat(40)]
  ]) {
    const changed = receipt()
    const context = reviewContext()
    changed.candidate.upstream[key] = replacement
    changed.review.candidate.upstream[key] = replacement
    context.expected.candidate.upstream[key] = replacement
    const result = verify({ receipt: changed, reviewContext: context })
    assertRefused(result)
    assert.match(result.reasons.join('\n'), /upstream.*external expectation/)
  }
})

test('refuses missing upstream identity in the externally expected candidate', () => {
  const incomplete = structuredClone(expected)
  delete incomplete.candidate.upstream
  assertRefused(verify({ expected: incomplete }))
})

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
  test(`refuses promotion when current run ${String(field)} does not match its receipt and expectation`, () => {
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
    { receipt: receipt(), run: run(), expected, reviewContext: reviewContext() },
    { ...policy, promotionEnabled: false },
    () => NOW
  )

  assertRefused(result)
})

function cliFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'orca-qualification-run-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const paths = {}
  for (const [name, value] of Object.entries({
    receipt: receipt(),
    policy,
    expected,
    run: run(),
    reviewContext: reviewContext(),
    pages: pages(run())
  })) {
    paths[name] = join(root, `${name}.json`)
    writeFileSync(paths[name], JSON.stringify(value))
  }
  const clockPath = join(root, 'clock.cjs')
  writeFileSync(clockPath, `Date.now = () => ${NOW}\n`)
  const invoke = (command, files) =>
    spawnSync(
      process.execPath,
      [
        '--require',
        clockPath,
        join(import.meta.dirname, 'qualification-run.mjs'),
        command,
        ...files
      ],
      { cwd: root, encoding: 'utf8', windowsHide: true }
    )
  return { paths, invoke }
}

test('selector CLI returns the exact run id', (t) => {
  const { paths, invoke } = cliFixture(t)
  const result = invoke('select', [paths.pages, paths.expected])

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), String(expected.runId))
})

test('selector CLI leaves stdout empty while this dispatch has no visible run', (t) => {
  const { paths, invoke } = cliFixture(t)
  writeFileSync(paths.pages, JSON.stringify(pages(run({ display_title: 'qualify another' }))))
  const result = invoke('select', [paths.pages, paths.expected])

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '')
})

test('verification CLI accepts the matching expected candidate', (t) => {
  const { paths, invoke } = cliFixture(t)
  const result = invoke('verify', [
    paths.receipt,
    paths.policy,
    paths.expected,
    paths.run,
    String(expected.runId),
    paths.reviewContext
  ])

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, reasons: [] })
})

test('verification CLI exits nonzero for a receipt from another dispatch', (t) => {
  const { paths, invoke } = cliFixture(t)
  const changed = receipt()
  changed.qualification.dispatchId = 'assembly-another'
  writeFileSync(paths.receipt, JSON.stringify(changed))
  const result = invoke('verify', [
    paths.receipt,
    paths.policy,
    paths.expected,
    paths.run,
    String(expected.runId),
    paths.reviewContext
  ])

  assert.equal(result.status, 1)
  assertRefused(JSON.parse(result.stdout))
})

test('verification CLI refuses a legacy invocation without external review context', (t) => {
  const { paths, invoke } = cliFixture(t)
  const result = invoke('verify', [
    paths.receipt,
    paths.policy,
    paths.expected,
    paths.run,
    String(expected.runId)
  ])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /review-context/)
})
