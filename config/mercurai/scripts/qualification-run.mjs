import { readFileSync } from 'node:fs'
import { verifyPromotion } from './verify-promotion.mjs'
import { sameReleaseReviewCandidate } from './release-review.mjs'

const SHA40 = /^[0-9a-f]{40}$/
const SHA64 = /^[0-9a-f]{64}$/
const DISPATCH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/
const WORKFLOW_PATH = '.github/workflows/fork-qualify-release.yml'
const CANDIDATE_FIELDS = ['commit', 'tree', 'controllerSha', 'manifestSha', 'policySha', 'version']
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0

function validRunRecord(run) {
  return (
    isRecord(run) &&
    positiveInteger(run.id) &&
    positiveInteger(run.workflow_id) &&
    typeof run.repository?.full_name === 'string' &&
    typeof run.path === 'string' &&
    typeof run.event === 'string' &&
    typeof run.head_branch === 'string' &&
    typeof run.head_sha === 'string' &&
    SHA40.test(run.head_sha) &&
    typeof run.display_title === 'string' &&
    typeof run.created_at === 'string' &&
    Number.isFinite(Date.parse(run.created_at))
  )
}

function validateExpected(expected) {
  const candidate = expected?.candidate
  if (
    !isRecord(expected) ||
    !isRecord(candidate) ||
    typeof expected.repository !== 'string' ||
    !/^[\w.-]+\/[\w.-]+$/.test(expected.repository) ||
    !positiveInteger(expected.workflowId) ||
    expected.workflowPath !== WORKFLOW_PATH ||
    typeof expected.branch !== 'string' ||
    expected.branch.length === 0 ||
    typeof expected.dispatchId !== 'string' ||
    !DISPATCH_ID.test(expected.dispatchId) ||
    typeof expected.startedAt !== 'string' ||
    !Number.isFinite(Date.parse(expected.startedAt))
  ) {
    throw new TypeError('qualification expectation is invalid')
  }
  for (const key of ['commit', 'tree', 'controllerSha', 'manifestSha']) {
    if (!SHA40.test(candidate[key])) {
      throw new TypeError(`expected candidate ${key} is invalid`)
    }
  }
  if (
    !SHA64.test(candidate.policySha) ||
    typeof candidate.version !== 'string' ||
    !/^\d+\.\d+\.\d+-mercurai\.\d+$/.test(candidate.version) ||
    !Array.isArray(candidate.series) ||
    !candidate.series.every(
      (pin) => typeof pin === 'string' && /^patch\/[A-Za-z0-9._-]+:[0-9a-f]{40}$/.test(pin)
    )
  ) {
    throw new TypeError('expected candidate policy, version, or ordered series is invalid')
  }
  if (!sameReleaseReviewCandidate(candidate, candidate)) {
    throw new TypeError('expected candidate full identity including upstream tuple is invalid')
  }
}

function matchesExpectedRun(run, expected) {
  return (
    isRecord(run) &&
    positiveInteger(run.id) &&
    run.repository?.full_name === expected.repository &&
    run.workflow_id === expected.workflowId &&
    [
      expected.workflowPath,
      `${expected.workflowPath}@${expected.branch}`,
      `${expected.workflowPath}@refs/heads/${expected.branch}`
    ].includes(run.path) &&
    run.event === 'workflow_dispatch' &&
    run.head_branch === expected.branch &&
    run.head_sha === expected.candidate.controllerSha &&
    run.display_title === `qualify ${expected.dispatchId}` &&
    typeof run.created_at === 'string' &&
    Date.parse(run.created_at) >= Date.parse(expected.startedAt)
  )
}

/** A filtered GitHub run search is capped at 1,000 results even when paginated. */
function completeRuns(pages) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new TypeError('qualification run pages are malformed')
  }
  const count = pages[0]?.total_count
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError('qualification run total count is invalid')
  }
  if (count > 1000) {
    throw new Error('qualification run search exceeds the API limit; narrow the search window')
  }
  const runs = []
  for (const page of pages) {
    if (!isRecord(page) || !Array.isArray(page.workflow_runs)) {
      throw new TypeError('qualification run page is malformed')
    }
    if (page.total_count !== count) {
      throw new Error('qualification run pagination is incomplete or changed while reading')
    }
    runs.push(...page.workflow_runs)
  }
  if (runs.some((run) => !validRunRecord(run))) {
    throw new TypeError('qualification run row is invalid')
  }
  if (runs.length !== count || new Set(runs.map((run) => run?.id)).size !== count) {
    throw new Error('qualification run pagination is incomplete or contains duplicate entries')
  }
  return runs
}

export function selectQualificationRun(pages, expected) {
  validateExpected(expected)
  const matches = completeRuns(pages).filter((run) => matchesExpectedRun(run, expected))
  if (matches.length > 1) {
    throw new Error('qualification dispatch is ambiguous: more than one run matched')
  }
  return matches[0]?.id ?? null
}

/** Compare external assembly identity before trusting the receipt's self-consistency. */
export function verifyQualificationRun(
  { receipt, run, expected, reviewContext },
  policy,
  now = Date.now
) {
  try {
    validateExpected(expected)
  } catch (error) {
    return { ok: false, reasons: [error.message] }
  }
  const { reasons } = verifyPromotion(receipt, policy, reviewContext, now)
  for (const key of CANDIDATE_FIELDS) {
    if (receipt?.candidate?.[key] !== expected.candidate[key]) {
      reasons.push(`receipt candidate ${key} does not match the external expectation`)
    }
  }
  if (JSON.stringify(receipt?.candidate?.series) !== JSON.stringify(expected.candidate.series)) {
    reasons.push('receipt ordered series does not match the external expectation')
  }
  for (const key of ['repository', 'mainSha', 'stableTag', 'stableCommit']) {
    if (receipt?.candidate?.upstream?.[key] !== expected.candidate.upstream[key]) {
      reasons.push(`receipt upstream ${key} does not match the external expectation`)
    }
  }
  if (!sameReleaseReviewCandidate(reviewContext?.expected?.candidate, expected.candidate)) {
    reasons.push('review context candidate does not match the external qualification expectation')
  }
  if (
    reviewContext?.expected?.repository !== expected.repository ||
    reviewContext?.expected?.controllerRef !== `refs/heads/${expected.branch}`
  ) {
    reasons.push(
      'review context repository or controller ref does not match the qualification expectation'
    )
  }
  if (!matchesExpectedRun(run, expected)) {
    reasons.push(
      'qualification run does not match the expected repository, workflow, controller, or dispatch'
    )
  }
  if (
    !positiveInteger(expected.runId) ||
    run?.id !== expected.runId ||
    receipt?.qualification?.runId !== expected.runId
  ) {
    reasons.push('qualification run id does not match its receipt and external expectation')
  }
  if (run?.status !== 'completed' || run?.conclusion !== 'success') {
    reasons.push('qualification run is not completed successfully')
  }
  if (
    !positiveInteger(run?.run_attempt) ||
    receipt?.qualification?.attempt !== run.run_attempt ||
    receipt?.qualification?.latestAttempt !== run.run_attempt
  ) {
    reasons.push('qualification receipt does not describe the latest run attempt')
  }
  if (receipt?.qualification?.dispatchId !== expected.dispatchId) {
    reasons.push('qualification receipt dispatch id does not match the external expectation')
  }
  return { ok: reasons.length === 0, reasons }
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  try {
    const [command, ...paths] = process.argv.slice(2)
    if (command === 'select' && paths.length === 2) {
      const id = selectQualificationRun(readJson(paths[0]), readJson(paths[1]))
      if (id !== null) {
        console.log(id)
      }
    } else if (command === 'verify' && paths.length === 6) {
      const [receipt, policy, expectation, run, runId, reviewContext] = paths
      const expected = { ...readJson(expectation), runId: Number(runId) }
      const result = verifyQualificationRun(
        {
          receipt: readJson(receipt),
          run: readJson(run),
          expected,
          reviewContext: readJson(reviewContext)
        },
        readJson(policy)
      )
      console.log(JSON.stringify(result))
      if (!result.ok) {
        process.exitCode = 1
      }
    } else {
      throw new Error(
        'usage: qualification-run.mjs select <pages> <expectation> | verify <receipt> <policy> <expectation> <run> <run-id> <review-context.json>'
      )
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
