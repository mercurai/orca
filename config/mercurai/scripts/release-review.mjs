import { readFileSync } from 'node:fs'

const SHA40 = /^[0-9a-f]{40}$/
const SHA64 = /^[0-9a-f]{64}$/
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/
const WORKFLOW = '.github/workflows/fork-accept-release-review.yml'
const MAX_BYTES = 1024 * 1024
const FIELDS = ['commit', 'tree', 'controllerSha', 'manifestSha', 'policySha', 'version']
const UPSTREAM = ['repository', 'mainSha', 'stableTag', 'stableCommit']
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const positive = (value) => Number.isSafeInteger(value) && value > 0
const text = (value, limit) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= limit
const result = (reasons) => ({ ok: reasons.length === 0, reasons })

function validCandidate(candidate) {
  return (
    object(candidate) &&
    ['commit', 'tree', 'controllerSha', 'manifestSha'].every((key) => SHA40.test(candidate[key])) &&
    SHA64.test(candidate.policySha) &&
    /^\d+\.\d+\.\d+-mercurai\.\d+$/.test(candidate.version) &&
    Array.isArray(candidate.series) &&
    candidate.series.length <= 1024 &&
    candidate.series.every(
      (pin) => typeof pin === 'string' && /^patch\/[A-Za-z0-9._-]+:[0-9a-f]{40}$/.test(pin)
    ) &&
    new Set(candidate.series.map((pin) => pin.split(':')[0])).size === candidate.series.length &&
    object(candidate.upstream) &&
    REPOSITORY.test(candidate.upstream.repository) &&
    SHA40.test(candidate.upstream.mainSha) &&
    SHA40.test(candidate.upstream.stableCommit) &&
    /^v\d+\.\d+\.\d+$/.test(candidate.upstream.stableTag)
  )
}

export function sameReleaseReviewCandidate(left, right) {
  return (
    validCandidate(left) &&
    validCandidate(right) &&
    FIELDS.every((key) => left[key] === right[key]) &&
    UPSTREAM.every((key) => left.upstream[key] === right.upstream[key]) &&
    JSON.stringify(left.series) === JSON.stringify(right.series)
  )
}

function validExpected(expected, needsRun = false) {
  return (
    object(expected) &&
    REPOSITORY.test(expected.repository) &&
    positive(expected.workflowId) &&
    /^refs\/heads\/[A-Za-z0-9._/-]+$/.test(expected.controllerRef) &&
    validCandidate(expected.candidate) &&
    (!needsRun || (positive(expected.runId) && positive(expected.attempt)))
  )
}

/** Validates owner-supplied data, never authenticates its author or an AI reviewer. */
export function validateReleaseReviewSubmission(record, expected) {
  const reasons = []
  if (!validExpected(expected)) {
    reasons.push('review external expectation is invalid')
  }
  if (!object(record)) {
    return result([...reasons, 'review owner acceptance record is missing'])
  }
  if (
    record.schemaVersion !== 1 ||
    record.scope !== 'candidate-and-controller' ||
    record.verdict !== 'approved' ||
    record.ownerAccepted !== true ||
    !Array.isArray(record.openBlockers) ||
    record.openBlockers.length !== 0
  ) {
    reasons.push(
      'review requires owner acceptance of a full candidate-and-controller approval without blockers'
    )
  }
  if (!sameReleaseReviewCandidate(record.candidate, expected?.candidate)) {
    reasons.push('review candidate identity does not match the external expectation')
  }
  const reviewer = record.reviewer
  if (
    !object(reviewer) ||
    reviewer.independent !== true ||
    !text(reviewer.identity, 256) ||
    /[\r\n\0]/.test(reviewer.identity) ||
    !text(reviewer.evidenceSummary, 8192) ||
    !SHA64.test(reviewer.evidenceSha256)
  ) {
    reasons.push('review independent reviewer and bounded evidence summary/digest are required')
  }
  return result(reasons)
}

function validActor(actor) {
  return object(actor) && text(actor.login, 100) && positive(actor.id)
}

function sameActor(left, right) {
  return (
    validActor(left) &&
    validActor(right) &&
    left.id === right.id &&
    left.login.toLowerCase() === right.login.toLowerCase()
  )
}

function validPolicy(policy, expected) {
  const review = policy?.review
  return (
    object(review) &&
    review.workflowPath === WORKFLOW &&
    review.controllerRef === expected?.controllerRef &&
    (review.workflowId === undefined ||
      (positive(review.workflowId) && review.workflowId === expected?.workflowId)) &&
    Array.isArray(review.owners) &&
    review.owners.length > 0 &&
    review.owners.length <= 100 &&
    review.owners.every(validActor)
  )
}

function artifactReasons(artifact, expected, now) {
  const reasons = []
  if (!object(artifact) || !validExpected(expected, true)) {
    return ['review artifact or its external expectation is invalid']
  }
  if (
    !positive(artifact.id) ||
    artifact.name !== `release-review-${expected.runId}-${expected.attempt}`
  ) {
    reasons.push('review artifact id/name is invalid for the run attempt')
  }
  if (
    artifact.expired !== false ||
    !Number.isFinite(Date.parse(artifact.expires_at)) ||
    Date.parse(artifact.expires_at) <= now()
  ) {
    reasons.push('review artifact is expired or expiry is invalid')
  }
  if (!positive(artifact.size_in_bytes) || artifact.size_in_bytes > MAX_BYTES) {
    reasons.push('review artifact exceeds the archive size limit or has invalid size')
  }
  if (typeof artifact.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(artifact.digest)) {
    reasons.push('review artifact API digest is missing or invalid')
  }
  if (
    artifact.workflow_run?.id !== expected.runId ||
    artifact.workflow_run?.head_sha !== expected.candidate.controllerSha ||
    artifact.workflow_run?.head_branch !== expected.controllerRef.slice('refs/heads/'.length)
  ) {
    reasons.push('review artifact is not from the expected controller run')
  }
  return reasons
}

/** All pages must come from the exact run's artifacts endpoint, not a repository-wide search. */
export function selectReleaseReviewArtifact(pages, expected, now = Date.now) {
  if (!validExpected(expected, true) || !Array.isArray(pages) || pages.length === 0) {
    throw new TypeError('review artifact expectation/pages are invalid')
  }
  const count = pages[0]?.total_count
  if (!Number.isSafeInteger(count) || count < 0 || count > 10000) {
    throw new TypeError('review artifact total count is invalid or exceeds the bounded limit')
  }
  const rows = []
  for (const page of pages) {
    if (
      !object(page) ||
      page.total_count !== count ||
      !Array.isArray(page.artifacts) ||
      rows.length + page.artifacts.length > count
    ) {
      throw new TypeError('review artifact pagination is malformed or changed')
    }
    rows.push(...page.artifacts)
  }
  if (
    rows.length !== count ||
    rows.some((row) => !object(row) || !positive(row.id) || !text(row.name, 256)) ||
    new Set(rows.map((row) => row.id)).size !== count
  ) {
    throw new Error('review artifact pagination is incomplete or duplicated')
  }
  const matches = rows.filter(
    (row) => row.name === `release-review-${expected.runId}-${expected.attempt}`
  )
  if (matches.length !== 1) {
    throw new Error('review artifact is missing or ambiguous')
  }
  const reasons = artifactReasons(matches[0], expected, now)
  if (reasons.length) {
    throw new Error(reasons.join('; '))
  }
  return matches[0]
}

/** API evidence is supplied by trusted callers; record fields alone never authenticate acceptance. */
export function verifyReleaseReview(input, policy, now = Date.now) {
  const { record, run, artifact, archiveSha256, expected } = input ?? {}
  const { reasons } = validateReleaseReviewSubmission(record, expected)
  if (!validExpected(expected, true)) {
    reasons.push('review run external expectation is invalid')
  }
  if (!validPolicy(policy, expected)) {
    reasons.push('review owner acceptance policy is invalid or missing')
  }
  if (reasons.length) {
    return result(reasons)
  }
  const branch = expected.controllerRef.slice('refs/heads/'.length)
  const path = policy.review.workflowPath
  if (
    !object(run) ||
    run.id !== expected.runId ||
    run.workflow_id !== expected.workflowId ||
    run.repository?.full_name !== expected.repository ||
    run.event !== 'workflow_dispatch' ||
    ![path, `${path}@${branch}`, `${path}@${expected.controllerRef}`].includes(run.path) ||
    run.head_branch !== branch ||
    run.head_sha !== expected.candidate.controllerSha ||
    run.run_attempt !== expected.attempt ||
    run.status !== 'completed' ||
    run.conclusion !== 'success'
  ) {
    reasons.push('review live run does not match the latest successful default-controller intake')
  }
  if (
    !policy.review.owners.some((owner) => sameActor(owner, run?.actor)) ||
    !policy.review.owners.some((owner) => sameActor(owner, run?.triggering_actor))
  ) {
    reasons.push('review actor and triggering actor must both be authorized owners')
  }
  const auth = record.authentication
  if (
    !object(auth) ||
    auth.repository !== expected.repository ||
    auth.workflowId !== expected.workflowId ||
    auth.workflowPath !== path ||
    auth.controllerRef !== expected.controllerRef ||
    auth.controllerSha !== expected.candidate.controllerSha ||
    auth.runId !== expected.runId ||
    auth.attempt !== expected.attempt ||
    !sameActor(auth.actor, run?.actor) ||
    !sameActor(auth.triggeringActor, run?.triggering_actor)
  ) {
    reasons.push('review owner acceptance provenance does not match the live GitHub run')
  }
  reasons.push(...artifactReasons(artifact, expected, now))
  if (!SHA64.test(archiveSha256) || artifact?.digest !== `sha256:${archiveSha256}`) {
    reasons.push('review downloaded archive sha256 does not match the API artifact digest')
  }
  return result(reasons)
}

function readJson(path) {
  const bytes = readFileSync(path)
  if (bytes.length > MAX_BYTES) {
    throw new Error('review JSON exceeds the size limit')
  }
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('review JSON is invalid')
  }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  try {
    const [command, left, right] = process.argv.slice(2)
    const answer =
      command === 'submission'
        ? validateReleaseReviewSubmission(readJson(left), readJson(right))
        : command === 'select'
          ? selectReleaseReviewArtifact(readJson(left), readJson(right))
          : command === 'verify'
            ? verifyReleaseReview(readJson(left), readJson(right))
            : (() => {
                throw new Error(
                  'usage: release-review.mjs submission|select|verify <input.json> <expected-or-policy.json>'
                )
              })()
    console.log(JSON.stringify(answer))
    if (answer.ok === false) {
      process.exitCode = 1
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
