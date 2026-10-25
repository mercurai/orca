import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SHA40 = /^[0-9a-f]{40}$/
const SHA64 = /^[0-9a-f]{64}$/

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const sameSeries = (left, right) =>
  JSON.stringify(left ?? []) === JSON.stringify(right ?? [])

/**
 * Check release evidence at the promotion boundary.
 *
 * This function only accepts evidence already collected from trusted workflow and review records.
 * It does not query GitHub and it never treats a matching tree as a matching commit.
 */
export function verifyPromotion(input, policy) {
  const reasons = []
  const candidate = input?.candidate
  const qualification = input?.qualification
  const review = input?.review

  if (!isRecord(candidate)) reasons.push('candidate evidence is missing')
  if (!isRecord(qualification)) reasons.push('qualification evidence is missing')
  if (!isRecord(review)) reasons.push('independent review evidence is missing')
  if (!isRecord(policy)) reasons.push('release policy is missing')
  if (reasons.length > 0) return { ok: false, reasons }

  if (!SHA40.test(candidate.commit)) reasons.push('candidate commit is not a lowercase 40-character sha')
  if (!SHA40.test(candidate.tree)) reasons.push('candidate tree is not a lowercase 40-character sha')
  if (!SHA40.test(candidate.controllerSha)) reasons.push('candidate controller sha is invalid')
  if (!SHA40.test(candidate.manifestSha)) reasons.push('candidate manifest sha is invalid')
  if (!SHA64.test(candidate.policySha)) reasons.push('candidate policy sha is invalid')
  if (typeof candidate.version !== 'string' || candidate.version.length === 0) reasons.push('candidate version is missing')

  if (qualification.workflow !== policy.workflow) {
    reasons.push(`qualification workflow ${qualification.workflow ?? 'missing'} does not match policy ${policy.workflow}`)
  }
  if (qualification.mode !== 'full') reasons.push('qualification is not a full-matrix run')
  if (Array.isArray(qualification.selectedTests) && qualification.selectedTests.length > 0) {
    reasons.push('qualification selected-test list is non-empty')
  }
  if (!Number.isInteger(qualification.runId) || qualification.runId <= 0) reasons.push('qualification run id is missing')
  if (qualification.attempt !== qualification.latestAttempt) reasons.push('qualification is not the latest workflow attempt')
  if (qualification.conclusion !== 'success') reasons.push(`qualification conclusion is ${qualification.conclusion ?? 'missing'}`)

  const identityFields = [
    ['checkout commit', qualification.checkoutSha, candidate.commit],
    ['checkout tree', qualification.checkoutTree, candidate.tree],
    ['controller sha', qualification.controllerSha, candidate.controllerSha],
    ['manifest sha', qualification.manifestSha, candidate.manifestSha],
    ['policy sha', qualification.policySha, candidate.policySha]
  ]
  for (const [label, actual, expected] of identityFields) {
    if (actual !== expected) reasons.push(`qualification ${label} does not match the candidate`)
  }
  if (!sameSeries(qualification.series, candidate.series)) {
    reasons.push('qualification patch series does not match the candidate')
  }

  const checks = Array.isArray(qualification.checks) ? qualification.checks : []
  const requiredChecks = Array.isArray(policy.requiredChecks)
    ? policy.requiredChecks
    : Array.isArray(policy.requiredJobs)
      ? policy.requiredJobs.flatMap((job) => job.checks ?? [])
      : []
  const permittedSkips = new Set(Array.isArray(policy.permittedSkips) ? policy.permittedSkips : [])

  if (requiredChecks.length === 0) reasons.push('release policy declares no required checks')
  for (const name of requiredChecks) {
    const matches = checks.filter((check) => check?.name === name)
    if (matches.length === 0) {
      reasons.push(`${name} is missing`)
      continue
    }
    if (matches.length > 1) {
      reasons.push(`${name} appears more than once`)
      continue
    }
    const [check] = matches
    if (check.conclusion === 'skipped' && permittedSkips.has(name)) continue
    if (check.conclusion !== 'success') reasons.push(`${name} has conclusion ${check.conclusion ?? 'missing'}`)
  }
  for (const check of checks) {
    if (check?.conclusion === 'skipped' && !permittedSkips.has(check.name)) {
      reasons.push(`${check.name ?? 'unnamed check'} is skipped without a policy predicate`)
    }
  }

  if (review.verdict !== 'approved') reasons.push(`independent review verdict is ${review.verdict ?? 'missing'}`)
  if (review.reviewedSha !== candidate.commit) reasons.push('independent review is not bound to the candidate commit')
  if (review.controllerSha !== candidate.controllerSha) reasons.push('independent review is not bound to the candidate controller')
  if (typeof review.reviewer !== 'string' || review.reviewer.length === 0) reasons.push('independent reviewer identity is missing')

  return { ok: reasons.length === 0, reasons }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const evidencePath = process.argv[2]
  const policyPath = process.argv[3]
  if (!evidencePath || !policyPath) {
    console.error('usage: node verify-promotion.mjs <evidence.json> <release-policy.json>')
    process.exitCode = 2
  } else {
    const result = verifyPromotion(JSON.parse(readFileSync(evidencePath, 'utf8')), JSON.parse(readFileSync(policyPath, 'utf8')))
    console.log(JSON.stringify(result))
    if (!result.ok) process.exitCode = 1
  }
}
