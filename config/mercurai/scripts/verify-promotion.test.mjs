import assert from 'node:assert/strict'
import { test } from 'node:test'

import { collectQualificationEvidence, verifyPromotion as verify } from './verify-promotion.mjs'

const SHA = 'a'.repeat(40)
const TREE = 'b'.repeat(40)
const CONTROLLER = 'c'.repeat(40)
const MANIFEST = 'd'.repeat(40)
const POLICY = 'e'.repeat(64)
const NOW = Date.parse('2026-10-26T12:00:00Z')
const ACTOR = { login: 'synthetic-release-owner', id: 7 }
const candidate = {
  commit: SHA,
  tree: TREE,
  controllerSha: CONTROLLER,
  manifestSha: MANIFEST,
  policySha: POLICY,
  version: '1.4.239-mercurai.3',
  series: [`patch/current-main-release:${SHA}`],
  upstream: { repository: 'stablyai/orca', mainSha: SHA, stableTag: 'v1.4.239', stableCommit: SHA }
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
    owners: [ACTOR]
  }
}

function acceptance() {
  return {
    schemaVersion: 1,
    scope: 'candidate-and-controller',
    verdict: 'approved',
    ownerAccepted: true,
    openBlockers: [],
    candidate: structuredClone(candidate),
    reviewer: {
      identity: 'independent-reviewer',
      independent: true,
      evidenceSummary: 'Full review accepted.',
      evidenceSha256: POLICY
    },
    authentication: {
      repository: 'mercurai/orca',
      workflowId: 91,
      workflowPath: policy.review.workflowPath,
      controllerRef: policy.review.controllerRef,
      controllerSha: CONTROLLER,
      runId: 101,
      attempt: 2,
      actor: ACTOR,
      triggeringActor: ACTOR
    }
  }
}

function reviewContext() {
  return {
    expected: {
      repository: 'mercurai/orca',
      workflowId: 91,
      controllerRef: policy.review.controllerRef,
      runId: 101,
      attempt: 2,
      candidate: structuredClone(candidate)
    },
    run: {
      id: 101,
      workflow_id: 91,
      repository: { full_name: 'mercurai/orca' },
      path: policy.review.workflowPath,
      event: 'workflow_dispatch',
      head_branch: 'mercurai',
      head_sha: CONTROLLER,
      run_attempt: 2,
      status: 'completed',
      conclusion: 'success',
      actor: ACTOR,
      triggering_actor: ACTOR
    },
    artifact: {
      id: 303,
      name: 'release-review-101-2',
      expired: false,
      expires_at: '2026-11-01T00:00:00Z',
      size_in_bytes: 4096,
      digest: `sha256:${POLICY}`,
      workflow_run: { id: 101, head_branch: 'mercurai', head_sha: CONTROLLER }
    },
    archiveSha256: POLICY
  }
}

const verifyPromotion = (input, releasePolicy, context = reviewContext()) =>
  verify(input, releasePolicy, context, () => NOW)

function evidence(overrides = {}) {
  return {
    candidate: structuredClone(candidate),
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
      series: [...candidate.series],
      conclusion: 'success',
      checks: [
        { name: 'test / tests node 24 2/5', conclusion: 'success' },
        { name: 'PR checks passed', conclusion: 'success' }
      ]
    },
    review: acceptance(),
    ...overrides
  }
}

test('accepts complete full qualification at the exact candidate revision', () => {
  const result = verifyPromotion(evidence(), policy)

  assert.deepEqual(result, { ok: true, reasons: [] })
})

test('rejects reviewer text without authenticated owner acceptance of independent review', () => {
  const result = verifyPromotion(
    evidence({
      review: {
        verdict: 'approved',
        reviewedSha: SHA,
        controllerSha: CONTROLLER,
        reviewer: 'independent-reviewer'
      }
    }),
    policy
  )

  assert.equal(result.ok, false)
  assert.match(result.reasons.join('\n'), /review.*acceptance|owner.*acceptance/i)
})

test('rejects an acceptance record without trusted external API context', () => {
  const result = verify(evidence(), policy)
  assert.equal(result.ok, false)
  assert.match(result.reasons.join('\n'), /external API evidence/)
})

test('rejects self-consistent review evidence for a different external candidate', () => {
  const context = reviewContext()
  context.expected.candidate.commit = 'f'.repeat(40)
  const result = verifyPromotion(evidence(), policy, context)
  assert.equal(result.ok, false)
  assert.match(result.reasons.join('\n'), /exact candidate/)
})

test('refuses promotion when policy has not explicitly admitted publication', () => {
  for (const promotionEnabled of [false, undefined]) {
    const result = verifyPromotion(evidence(), { ...policy, promotionEnabled })

    assert.equal(result.ok, false)
    assert.match(result.reasons.join('\n'), /promotion.*disabled/i)
  }
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
    review: {
      verdict: 'approved',
      reviewedSha: 'f'.repeat(40),
      controllerSha: CONTROLLER,
      reviewer: 'reviewer'
    }
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

const matrixJobIds = [
  'code_paths',
  'preflight',
  'git_compatibility',
  'codex_index_heal_contract',
  'xterm_patch_sync',
  'shell_contracts',
  'test',
  'mobile_web_app',
  'cross-version-wire',
  'managed_hook_node18',
  'package',
  'package_windows',
  'layout_oracle',
  'dependency_isolation'
]
const fixedMatrixChecks = [
  'detect changes and check repository guards',
  'static analysis and typecheck',
  'Git compatibility',
  'Codex index-heal contract',
  'xterm patch sync',
  'shell contracts',
  'mobile web app bundle',
  'cross-version wire compatibility',
  'managed hooks on Node 18',
  'package',
  'package (windows)',
  'dependency isolation under the global virtual store',
  'relay integration node 24',
  'build e2e app',
  'orca serve Electron/orcad mode switch (D7)',
  'PR checks passed'
]
const matrixPolicy = {
  ...policy,
  schemaVersion: 2,
  requiredChecks: fixedMatrixChecks,
  requiredMatrix: {
    jobIds: matrixJobIds,
    nodeVersions: [24],
    jobNamePrefix: 'matrix / ',
    advisoryExclusions: ['e2e', 'terminal_ime_native', 'windows_wsl', 'unit_selection_evidence']
  }
}

function fullMatrixInput() {
  const shards = [
    { index: 1, count: 2 },
    { index: 2, count: 2 }
  ]
  const names = [
    ...fixedMatrixChecks,
    'tests node 24 1/2',
    'tests node 24 2/2',
    'changed e2e specs (1/1)'
  ]
  const jobs = names.map((name, index) => ({
    id: 700 + index,
    run_id: 40123456789,
    run_attempt: 2,
    head_sha: CONTROLLER,
    name: `matrix / ${name}`,
    status: 'completed',
    conclusion: 'success'
  }))
  return {
    candidate: structuredClone(candidate),
    repository: 'mercurai/orca',
    jobsEndpoint: 'repos/mercurai/orca/actions/runs/40123456789/attempts/2/jobs?per_page=100',
    runId: 40123456789,
    attempt: 2,
    outputs: {
      result: 'success',
      candidate_sha: SHA,
      candidate_tree: TREE,
      controller_sha: CONTROLLER,
      upstream_base_sha: SHA,
      full_mode: 'true',
      cache_mode: 'off',
      required_results: JSON.stringify(
        Object.fromEntries(matrixJobIds.map((id) => [id, 'success']))
      ),
      unit_shards: JSON.stringify(shards),
      selected_tests: '[]',
      layout_oracle_shards: '["1/1"]',
      advisory_exclusions: JSON.stringify(matrixPolicy.requiredMatrix.advisoryExclusions),
      unit_plan_artifact: 'unit-selection-attempt-2'
    },
    unitPlan: {
      version: 1,
      mode: 'full',
      sourceSha: SHA,
      runId: '40123456789',
      runAttempt: '2',
      selectedTests: [],
      files: ['src/a.test.ts', 'src/b.test.ts'],
      candidateFiles: ['src/a.test.ts', 'src/b.test.ts'],
      executionFiles: ['src/a.test.ts', 'src/b.test.ts'],
      shards
    },
    jobPages: [{ total_count: jobs.length, jobs }]
  }
}

function fullEvidence(input = fullMatrixInput()) {
  const qualification = {
    ...evidence().qualification,
    ...collectQualificationEvidence(input, matrixPolicy)
  }
  return evidence({ qualification })
}

test('accepts only the actual complete shared full matrix and every planned unit shard', () => {
  const input = fullMatrixInput()
  const value = fullEvidence(input)
  assert.equal(verifyPromotion(value, matrixPolicy).ok, true)
  assert.equal(value.qualification.checks.length, input.jobPages[0].jobs.length)
  assert.deepEqual(value.qualification.matrix.unitPlan.executionFiles, input.unitPlan.files)
})

test('accepts actual nested reusable unit and layout check names', () => {
  const input = fullMatrixInput()
  for (const job of input.jobPages[0].jobs) {
    if (job.name.startsWith('matrix / tests node ')) {
      job.name = job.name.replace('matrix / ', 'matrix / test / ')
    } else if (job.name.startsWith('matrix / changed e2e specs ')) {
      job.name = job.name.replace('matrix / ', 'matrix / layout oracle / ')
    }
  }
  const value = fullEvidence(input)
  assert.equal(verifyPromotion(value, matrixPolicy).ok, true)
  assert.deepEqual(
    value.qualification.checks
      .filter((row) => row.name.startsWith('tests node '))
      .map((row) => row.jobId),
    input.jobPages[0].jobs
      .filter((row) => row.name.startsWith('matrix / test / '))
      .map((row) => row.id)
  )
})

for (const [name, mutate] of [
  ['one missing unit shard', (input) => input.jobPages[0].jobs.splice(-2, 1)],
  [
    'one failed shard',
    (input) => {
      input.jobPages[0].jobs.at(-2).conclusion = 'failure'
    }
  ],
  [
    'one skipped required group',
    (input) => {
      input.outputs.required_results = JSON.stringify({
        ...JSON.parse(input.outputs.required_results),
        package: 'skipped'
      })
    }
  ],
  [
    'a selected subset pretending to be full',
    (input) => {
      input.unitPlan.executionFiles = ['src/a.test.ts']
    }
  ],
  [
    'nonempty selected tests',
    (input) => {
      input.outputs.selected_tests = '["src/a.test.ts"]'
    }
  ],
  [
    'the wrong source unit plan',
    (input) => {
      input.unitPlan.sourceSha = 'f'.repeat(40)
    }
  ],
  [
    'an old attempt unit plan',
    (input) => {
      input.unitPlan.runAttempt = '1'
    }
  ],
  [
    'duplicate physical check names',
    (input) => {
      const row = structuredClone(input.jobPages[0].jobs[0])
      row.id = 999
      input.jobPages[0].jobs.push(row)
    }
  ],
  [
    'duplicate shard assignments',
    (input) => {
      input.outputs.unit_shards = '[{"index":1,"count":2},{"index":1,"count":2}]'
    }
  ],
  [
    'an omitted layout shard',
    (input) => {
      input.outputs.layout_oracle_shards = '["1/2","2/2"]'
    }
  ],
  [
    'a different job controller',
    (input) => {
      input.jobPages[0].jobs[0].head_sha = 'f'.repeat(40)
    }
  ],
  [
    'a different job attempt',
    (input) => {
      input.jobPages[0].jobs[0].run_attempt = 1
    }
  ],
  [
    'a different jobs endpoint attempt',
    (input) => {
      input.jobsEndpoint = input.jobsEndpoint.replace('/attempts/2/', '/attempts/1/')
    }
  ],
  [
    'a cache-enabled reusable call',
    (input) => {
      input.outputs.cache_mode = 'auto'
    }
  ],
  [
    'an incomplete paginated job listing',
    (input) => {
      input.jobPages[0].total_count += 1
    }
  ],
  [
    'one missing required logical job',
    (input) => {
      const results = JSON.parse(input.outputs.required_results)
      delete results.shell_contracts
      input.outputs.required_results = JSON.stringify(results)
    }
  ],
  [
    'undeclared advisory exclusion',
    (input) => {
      input.outputs.advisory_exclusions = '["package"]'
    }
  ]
]) {
  test(`rejects full qualification with ${name}`, () => {
    const input = fullMatrixInput()
    mutate(input)
    input.jobPages[0].total_count =
      name === 'an incomplete paginated job listing'
        ? input.jobPages[0].total_count
        : input.jobPages[0].jobs.length
    assert.throws(
      () => collectQualificationEvidence(input, matrixPolicy),
      /qualification|matrix|shard|plan|job|check|selected|cache|advisory/i
    )
  })
}

test('rejects a forged successful check array that differs from the API job records', () => {
  const input = fullEvidence()
  input.qualification.matrix.jobs.find((row) => row.name.endsWith('tests node 24 2/2')).conclusion =
    'failure'
  const result = verifyPromotion(input, matrixPolicy)
  assert.equal(result.ok, false)
  assert.match(result.reasons.join('\n'), /check|shard/)
})

test('schema two never falls back to legacy partial-check admission', () => {
  const result = verifyPromotion(evidence(), { ...policy, schemaVersion: 2 })
  assert.equal(result.ok, false)
  assert.match(result.reasons.join('\n'), /matrix.*policy|policy.*matrix/i)
})

test('accepts complete paginated jobs with optional attempt fields bound by the exact API endpoint', () => {
  const input = fullMatrixInput()
  const { total_count: totalCount, jobs } = input.jobPages[0]
  for (const job of jobs) {
    delete job.run_attempt
  }
  input.jobPages = [
    { total_count: totalCount, jobs: jobs.slice(0, 10) },
    { total_count: totalCount, jobs: jobs.slice(10) }
  ]
  assert.equal(verifyPromotion(fullEvidence(input), matrixPolicy).ok, true)
})

test('explicitly excluded advisory jobs may be skipped without changing required qualification', () => {
  const input = fullMatrixInput()
  input.jobPages[0].jobs.push({
    ...input.jobPages[0].jobs[0],
    id: 999,
    name: 'matrix / real WSL terminal',
    conclusion: 'skipped'
  })
  input.jobPages[0].total_count += 1
  const value = fullEvidence(input)
  assert.equal(verifyPromotion(value, matrixPolicy).ok, true)
  assert.equal(value.qualification.matrix.jobs.at(-1).conclusion, 'skipped')
  assert.equal(
    value.qualification.checks.some((check) => check.name === 'real WSL terminal'),
    false
  )
})
