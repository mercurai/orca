import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  selectReleaseReviewArtifact as selectArtifact,
  validateReleaseReviewSubmission,
  verifyReleaseReview as verifyReview
} from './release-review.mjs'

const sha = (digit, length = 40) => digit.repeat(length)
const NOW = Date.parse('2026-10-26T12:00:00Z')
const verifyReleaseReview = (value, reviewPolicy) => verifyReview(value, reviewPolicy, () => NOW)
const selectReleaseReviewArtifact = (value, identity) => selectArtifact(value, identity, () => NOW)
const expected = {
  repository: 'mercurai/orca',
  workflowId: 91,
  controllerRef: 'refs/heads/mercurai',
  runId: 101,
  attempt: 2,
  candidate: {
    commit: sha('a'),
    tree: sha('b'),
    controllerSha: sha('c'),
    manifestSha: sha('d'),
    policySha: sha('e', 64),
    version: '1.4.239-mercurai.3',
    series: [`patch/first:${sha('f')}`, `patch/second:${sha('1')}`],
    upstream: {
      repository: 'stablyai/orca',
      mainSha: sha('2'),
      stableTag: 'v1.4.239',
      stableCommit: sha('3')
    }
  }
}
const policy = {
  review: {
    workflowId: expected.workflowId,
    workflowPath: '.github/workflows/fork-accept-release-review.yml',
    controllerRef: expected.controllerRef,
    owners: [{ login: 'synthetic-owner', id: 7 }]
  }
}
const actor = { login: 'synthetic-owner', id: 7 }

function record() {
  return {
    schemaVersion: 1,
    scope: 'candidate-and-controller',
    verdict: 'approved',
    ownerAccepted: true,
    openBlockers: [],
    candidate: structuredClone(expected.candidate),
    reviewer: {
      identity: 'independent-fleet-reviewer',
      independent: true,
      evidenceSummary: 'Reviewed the complete candidate and controller; no open blockers.',
      evidenceSha256: sha('4', 64)
    },
    authentication: {
      repository: expected.repository,
      workflowId: expected.workflowId,
      workflowPath: policy.review.workflowPath,
      controllerRef: expected.controllerRef,
      controllerSha: expected.candidate.controllerSha,
      runId: expected.runId,
      attempt: expected.attempt,
      actor: { ...actor },
      triggeringActor: { ...actor }
    }
  }
}

function run() {
  return {
    id: expected.runId,
    workflow_id: expected.workflowId,
    repository: { full_name: expected.repository },
    path: policy.review.workflowPath,
    event: 'workflow_dispatch',
    head_branch: 'mercurai',
    head_sha: expected.candidate.controllerSha,
    run_attempt: expected.attempt,
    status: 'completed',
    conclusion: 'success',
    actor: { ...actor },
    triggering_actor: { ...actor }
  }
}

function artifact() {
  return {
    id: 303,
    name: `release-review-${expected.runId}-${expected.attempt}`,
    expired: false,
    expires_at: '2026-11-01T00:00:00Z',
    size_in_bytes: 4096,
    digest: `sha256:${sha('5', 64)}`,
    workflow_run: {
      id: expected.runId,
      head_branch: 'mercurai',
      head_sha: expected.candidate.controllerSha
    }
  }
}

const pages = (...artifacts) => [{ total_count: artifacts.length, artifacts }]
const input = () => ({
  record: record(),
  run: run(),
  artifact: artifact(),
  archiveSha256: sha('5', 64),
  expected: structuredClone(expected)
})
const refused = (result) => assert.equal(result.ok, false, JSON.stringify(result))

test('accepts account-controlled acceptance of an exact independent full review', () => {
  assert.deepEqual(verifyReleaseReview(input(), policy), { ok: true, reasons: [] })
})

test('allows workflow registration bootstrap while requiring an externally resolved workflow id', () => {
  const bootstrapped = structuredClone(policy)
  delete bootstrapped.review.workflowId
  assert.deepEqual(verifyReleaseReview(input(), bootstrapped), { ok: true, reasons: [] })
  const missing = input()
  delete missing.expected.workflowId
  refused(verifyReleaseReview(missing, bootstrapped))
})

test('submission validation does not require or invent workflow authentication', () => {
  const submitted = record()
  delete submitted.authentication
  assert.deepEqual(validateReleaseReviewSubmission(submitted, expected), { ok: true, reasons: [] })
  refused(verifyReleaseReview({ ...input(), record: submitted }, policy))
})

test('selects exactly the latest attempt artifact across complete pages', () => {
  const prior = { ...artifact(), id: 302, name: 'release-review-101-1' }
  assert.deepEqual(
    selectReleaseReviewArtifact(
      [
        { total_count: 2, artifacts: [prior] },
        { total_count: 2, artifacts: [artifact()] }
      ],
      expected
    ),
    artifact()
  )
})

for (const [name, mutate] of [
  [
    'plain reviewer string',
    (value) => {
      value.record = 'approved by reviewer'
    }
  ],
  [
    'delta-only scope',
    (value) => {
      value.record.scope = 'delta'
    }
  ],
  [
    'owner acceptance absent',
    (value) => {
      delete value.record.ownerAccepted
    }
  ],
  [
    'non-independent reviewer',
    (value) => {
      value.record.reviewer.independent = false
    }
  ],
  [
    'open blocker',
    (value) => {
      value.record.openBlockers = ['pending CI']
    }
  ],
  [
    'negative verdict',
    (value) => {
      value.record.verdict = 'changes-requested'
    }
  ],
  [
    'unbounded reviewer',
    (value) => {
      value.record.reviewer.identity = 'x'.repeat(257)
    }
  ],
  [
    'unbounded evidence',
    (value) => {
      value.record.reviewer.evidenceSummary = 'x'.repeat(8193)
    }
  ],
  [
    'missing digest',
    (value) => {
      delete value.record.reviewer.evidenceSha256
    }
  ],
  [
    'unknown actor',
    (value) => {
      value.run.actor = { login: 'stranger', id: 8 }
    }
  ],
  [
    'same login changed id',
    (value) => {
      value.run.actor.id = 8
    }
  ],
  [
    'unauthorized rerunner',
    (value) => {
      value.run.triggering_actor = { login: 'stranger', id: 8 }
    }
  ],
  [
    'missing rerunner',
    (value) => {
      delete value.run.triggering_actor
    }
  ],
  [
    'other repository',
    (value) => {
      value.run.repository.full_name = 'other/orca'
    }
  ],
  [
    'other workflow',
    (value) => {
      value.run.workflow_id += 1
    }
  ],
  [
    'other workflow path',
    (value) => {
      value.run.path = '.github/workflows/fake.yml'
    }
  ],
  [
    'nonmanual event',
    (value) => {
      value.run.event = 'push'
    }
  ],
  [
    'feature controller',
    (value) => {
      value.run.head_branch = 'feature'
    }
  ],
  [
    'other controller sha',
    (value) => {
      value.run.head_sha = sha('6')
    }
  ],
  [
    'pending rerun',
    (value) => {
      value.run.status = 'in_progress'
    }
  ],
  [
    'failed rerun',
    (value) => {
      value.run.conclusion = 'failure'
    }
  ],
  [
    'stale attempt',
    (value) => {
      value.run.run_attempt += 1
    }
  ],
  [
    'forged provenance',
    (value) => {
      value.record.authentication.actor.id = 8
    }
  ],
  [
    'wrong archive bytes',
    (value) => {
      value.archiveSha256 = sha('6', 64)
    }
  ],
  [
    'artifact digest absent',
    (value) => {
      delete value.artifact.digest
    }
  ],
  [
    'invalid artifact id',
    (value) => {
      value.artifact.id = 0
    }
  ],
  [
    'artifact controller mismatch',
    (value) => {
      value.artifact.workflow_run.head_sha = sha('6')
    }
  ],
  [
    'expired artifact',
    (value) => {
      value.artifact.expired = true
    }
  ],
  [
    'past expiry metadata',
    (value) => {
      value.artifact.expires_at = '2026-10-25T12:00:00Z'
    }
  ],
  [
    'oversized archive',
    (value) => {
      value.artifact.size_in_bytes = 1024 * 1024 + 1
    }
  ],
  [
    'wrong attempt artifact',
    (value) => {
      value.artifact.name = 'release-review-101-1'
    }
  ],
  [
    'foreign artifact',
    (value) => {
      value.artifact.workflow_run.id += 1
    }
  ],
  [
    'missing expectation',
    (value) => {
      delete value.expected
    }
  ]
]) {
  test(`refuses ${String(name)}`, () => {
    const value = input()
    mutate(value)
    refused(verifyReleaseReview(value, policy))
  })
}

for (const key of ['commit', 'tree', 'controllerSha', 'manifestSha', 'policySha', 'version']) {
  test(`refuses a review for another candidate ${key}`, () => {
    const value = input()
    value.record.candidate[key] =
      key === 'version' ? '1.4.239-mercurai.4' : sha('6', key === 'policySha' ? 64 : 40)
    refused(verifyReleaseReview(value, policy))
  })
}

test('refuses reordered patch series and changed upstream tuple', () => {
  const reordered = input()
  reordered.record.candidate.series.reverse()
  refused(verifyReleaseReview(reordered, policy))
  for (const key of ['repository', 'mainSha', 'stableTag', 'stableCommit']) {
    const value = input()
    value.record.candidate.upstream[key] = 'different'
    refused(verifyReleaseReview(value, policy))
  }
})

test('refuses missing, malformed or untrusted policy', () => {
  for (const value of [
    undefined,
    {},
    { review: {} },
    { review: { ...policy.review, owners: [] } },
    { review: { ...policy.review, owners: [{ login: actor.login }] } },
    { review: { ...policy.review, workflowId: 92 } }
  ]) {
    refused(verifyReleaseReview(input(), value))
  }
})

test('refuses incomplete, duplicated, ambiguous or stale artifact listings', () => {
  const other = { ...artifact(), id: 304 }
  for (const value of [
    [],
    [{ total_count: 2, artifacts: [artifact()] }],
    [{ total_count: 1, artifacts: [artifact(), artifact()] }],
    pages(artifact(), other),
    pages({ ...artifact(), name: 'release-review-101-1' }),
    pages({ ...artifact(), expired: true }),
    [{ total_count: 10001, artifacts: [] }]
  ]) {
    assert.throws(() => selectReleaseReviewArtifact(value, expected))
  }
})
