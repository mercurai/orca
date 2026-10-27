import { readFileSync } from 'node:fs'
import { sameReleaseReviewCandidate, verifyReleaseReview } from './release-review.mjs'

const SHA40 = /^[0-9a-f]{40}$/
const SHA64 = /^[0-9a-f]{64}$/

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const sameSeries = (left, right) => JSON.stringify(left ?? []) === JSON.stringify(right ?? [])

const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const uniqueStrings = (values) =>
  Array.isArray(values) &&
  values.length > 0 &&
  values.every((value) => typeof value === 'string' && value.length > 0) &&
  new Set(values).size === values.length
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0

function completeShardNames(shards) {
  if (!Array.isArray(shards) || shards.length < 1 || shards.length > 100) {
    throw new Error('qualification shard plan is missing or exceeds its limit')
  }
  const count = shards.length
  if (
    !shards.every(
      (shard, index) => isRecord(shard) && shard.index === index + 1 && shard.count === count
    )
  ) {
    throw new Error('qualification shard plan is incomplete or duplicated')
  }
  return shards.map(({ index }) => `${index}/${count}`)
}

function requiredMatrixChecks(candidate, qualification, policy, repository) {
  const config = policy.requiredMatrix
  const matrix = qualification.matrix
  if (
    policy.schemaVersion !== 2 ||
    !positiveInteger(qualification.runId) ||
    !positiveInteger(qualification.attempt) ||
    !isRecord(config) ||
    !uniqueStrings(config.jobIds) ||
    !Array.isArray(config.nodeVersions) ||
    config.nodeVersions.length === 0 ||
    !config.nodeVersions.every(positiveInteger) ||
    new Set(config.nodeVersions).size !== config.nodeVersions.length ||
    typeof config.jobNamePrefix !== 'string' ||
    !config.jobNamePrefix.endsWith(' / ') ||
    !uniqueStrings(policy.requiredChecks) ||
    !uniqueStrings(config.advisoryExclusions)
  ) {
    throw new Error('qualification full matrix policy is invalid')
  }
  if (
    !isRecord(matrix) ||
    matrix.fullMode !== true ||
    matrix.cacheMode !== 'off' ||
    matrix.upstreamBaseSha !== candidate.upstream?.mainSha
  ) {
    throw new Error('qualification matrix must use the exact official base and full cacheless mode')
  }
  if (
    typeof repository !== 'string' ||
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    matrix.jobsEndpoint !==
      `repos/${repository}/actions/runs/${qualification.runId}/attempts/${qualification.attempt}/jobs?per_page=100`
  ) {
    throw new Error(
      'qualification job evidence is not bound to the exact repository, run, and attempt endpoint'
    )
  }
  if (
    !isRecord(matrix.requiredResults) ||
    !sameJson(Object.keys(matrix.requiredResults).sort(), [...config.jobIds].sort()) ||
    !config.jobIds.every((id) => matrix.requiredResults[id] === 'success')
  ) {
    throw new Error('qualification required matrix jobs are missing, skipped, or unsuccessful')
  }
  if (!sameJson(matrix.advisoryExclusions, config.advisoryExclusions)) {
    throw new Error('qualification advisory exclusions do not match the reviewed policy')
  }
  if (!Array.isArray(qualification.selectedTests) || qualification.selectedTests.length > 0) {
    throw new Error('qualification selected tests must be explicitly empty')
  }
  const plan = matrix.unitPlan
  const shards = completeShardNames(matrix.unitShards)
  if (
    shards.length < 2 ||
    shards.length > 10 ||
    !isRecord(plan) ||
    plan.version !== 1 ||
    plan.mode !== 'full' ||
    plan.sourceSha !== candidate.commit ||
    String(plan.runId) !== String(qualification.runId) ||
    String(plan.runAttempt) !== String(qualification.attempt) ||
    !uniqueStrings(plan.files) ||
    !sameJson(plan.files, plan.candidateFiles) ||
    !sameJson(plan.files, plan.executionFiles) ||
    !sameJson(plan.shards, matrix.unitShards) ||
    !Array.isArray(plan.selectedTests) ||
    plan.selectedTests.length > 0 ||
    matrix.unitPlanArtifact !== `unit-selection-attempt-${qualification.attempt}`
  ) {
    throw new Error(
      'qualification unit plan is not the complete current source and attempt; dispatch fresh full qualification'
    )
  }
  if (!uniqueStrings(matrix.layoutShards)) {
    throw new Error('qualification layout shard plan is missing')
  }
  const layoutNames = completeShardNames(
    matrix.layoutShards.map((value) => {
      const match = /^(\d+)\/(\d+)$/.exec(value)
      return { index: Number(match?.[1]), count: Number(match?.[2]) }
    })
  )
  const names = [
    ...policy.requiredChecks,
    ...config.nodeVersions.flatMap((node) => shards.map((shard) => `tests node ${node} ${shard}`)),
    ...layoutNames.map((shard) => `changed e2e specs (${shard})`)
  ]
  if (
    !uniqueStrings(names) ||
    !Array.isArray(matrix.jobs) ||
    matrix.jobs.length === 0 ||
    matrix.jobs.length > 10000 ||
    new Set(matrix.jobs.map((job) => job?.id)).size !== matrix.jobs.length ||
    matrix.jobs.some(
      (job) =>
        !positiveInteger(job?.id) ||
        job.run_id !== qualification.runId ||
        (job.run_attempt !== undefined && job.run_attempt !== qualification.attempt) ||
        job.head_sha !== candidate.controllerSha ||
        typeof job.name !== 'string'
    )
  ) {
    throw new Error('qualification API job evidence has invalid identity, count, or duplicate rows')
  }
  return names.map((name) => {
    const rows = matrix.jobs.filter(
      (job) => job.name.startsWith(config.jobNamePrefix) && job.name.split(' / ').at(-1) === name
    )
    if (rows.length !== 1 || rows[0].status !== 'completed' || rows[0].conclusion !== 'success') {
      throw new Error(
        `qualification check ${name} is missing, duplicated, skipped, or unsuccessful; require complete current-attempt evidence`
      )
    }
    return { name, conclusion: rows[0].conclusion, jobId: rows[0].id }
  })
}

/** Build the receipt from current-attempt API rows and outputs of the trusted shared workflow. */
export function collectQualificationEvidence(input, policy) {
  const { candidate, outputs, unitPlan, jobPages, runId, attempt, repository, jobsEndpoint } = input
  if (
    !isRecord(outputs) ||
    !positiveInteger(runId) ||
    !positiveInteger(attempt) ||
    outputs.result !== 'success' ||
    outputs.candidate_sha !== candidate?.commit ||
    outputs.candidate_tree !== candidate?.tree ||
    outputs.controller_sha !== candidate?.controllerSha ||
    !Array.isArray(jobPages) ||
    jobPages.length === 0
  ) {
    throw new Error('qualification matrix outputs or job listing identity are invalid')
  }
  const count = jobPages[0]?.total_count
  if (
    !positiveInteger(count) ||
    count > 10000 ||
    jobPages.some((page) => page?.total_count !== count || !Array.isArray(page.jobs))
  ) {
    throw new Error('qualification job pagination is malformed or changed')
  }
  const rows = jobPages.flatMap((page) => page.jobs)
  if (!rows.every(isRecord)) {
    throw new Error('qualification API job row is malformed')
  }
  const jobs = rows.map((job) => ({
    id: job.id,
    run_id: job.run_id,
    run_attempt: job.run_attempt,
    head_sha: job.head_sha,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion
  }))
  if (jobs.length !== count) {
    throw new Error('qualification job pagination is incomplete')
  }
  const parsedOutput = (key) => {
    try {
      return JSON.parse(outputs[key])
    } catch {
      throw new Error(`qualification matrix ${key} output is invalid JSON`)
    }
  }
  const qualification = {
    mode: 'full',
    runId,
    attempt,
    latestAttempt: attempt,
    checkoutSha: outputs.candidate_sha,
    checkoutTree: outputs.candidate_tree,
    controllerSha: outputs.controller_sha,
    manifestSha: candidate.manifestSha,
    policySha: candidate.policySha,
    series: candidate.series,
    conclusion: 'success',
    selectedTests: parsedOutput('selected_tests'),
    matrix: {
      fullMode: outputs.full_mode === 'true',
      cacheMode: outputs.cache_mode,
      upstreamBaseSha: outputs.upstream_base_sha,
      requiredResults: parsedOutput('required_results'),
      advisoryExclusions: parsedOutput('advisory_exclusions'),
      unitShards: parsedOutput('unit_shards'),
      layoutShards: parsedOutput('layout_oracle_shards'),
      unitPlanArtifact: outputs.unit_plan_artifact,
      unitPlan,
      jobs,
      jobsEndpoint
    }
  }
  qualification.checks = requiredMatrixChecks(candidate, qualification, policy, repository)
  return qualification
}

/**
 * Check release evidence at the promotion boundary.
 *
 * This function only accepts evidence already collected from trusted workflow and review records.
 * It does not query GitHub and it never treats a matching tree as a matching commit.
 */
export function verifyPromotion(input, policy, reviewContext, now = Date.now) {
  const reasons = []
  const candidate = input?.candidate
  const qualification = input?.qualification
  const review = input?.review

  if (!isRecord(candidate)) {
    reasons.push('candidate evidence is missing')
  }
  if (!isRecord(qualification)) {
    reasons.push('qualification evidence is missing')
  }
  if (!isRecord(review)) {
    reasons.push('independent review evidence is missing')
  }
  if (!isRecord(policy)) {
    reasons.push('release policy is missing')
  }
  if (reasons.length > 0) {
    return { ok: false, reasons }
  }

  if (policy.promotionEnabled !== true) {
    return { ok: false, reasons: ['release promotion is disabled by policy'] }
  }

  if (!SHA40.test(candidate.commit)) {
    reasons.push('candidate commit is not a lowercase 40-character sha')
  }
  if (!SHA40.test(candidate.tree)) {
    reasons.push('candidate tree is not a lowercase 40-character sha')
  }
  if (!SHA40.test(candidate.controllerSha)) {
    reasons.push('candidate controller sha is invalid')
  }
  if (!SHA40.test(candidate.manifestSha)) {
    reasons.push('candidate manifest sha is invalid')
  }
  if (!SHA64.test(candidate.policySha)) {
    reasons.push('candidate policy sha is invalid')
  }
  if (typeof candidate.version !== 'string' || candidate.version.length === 0) {
    reasons.push('candidate version is missing')
  }

  if (qualification.workflow !== policy.workflow) {
    reasons.push(
      `qualification workflow ${qualification.workflow ?? 'missing'} does not match policy ${policy.workflow}`
    )
  }
  if (qualification.mode !== 'full') {
    reasons.push('qualification is not a full-matrix run')
  }
  if (Array.isArray(qualification.selectedTests) && qualification.selectedTests.length > 0) {
    reasons.push('qualification selected-test list is non-empty')
  }
  if (!Number.isInteger(qualification.runId) || qualification.runId <= 0) {
    reasons.push('qualification run id is missing')
  }
  if (qualification.attempt !== qualification.latestAttempt) {
    reasons.push('qualification is not the latest workflow attempt')
  }
  if (qualification.conclusion !== 'success') {
    reasons.push(`qualification conclusion is ${qualification.conclusion ?? 'missing'}`)
  }

  const identityFields = [
    ['checkout commit', qualification.checkoutSha, candidate.commit],
    ['checkout tree', qualification.checkoutTree, candidate.tree],
    ['controller sha', qualification.controllerSha, candidate.controllerSha],
    ['manifest sha', qualification.manifestSha, candidate.manifestSha],
    ['policy sha', qualification.policySha, candidate.policySha]
  ]
  for (const [label, actual, expected] of identityFields) {
    if (actual !== expected) {
      reasons.push(`qualification ${label} does not match the candidate`)
    }
  }
  if (!sameSeries(qualification.series, candidate.series)) {
    reasons.push('qualification patch series does not match the candidate')
  }

  const checks = Array.isArray(qualification.checks) ? qualification.checks : []
  if (policy.schemaVersion === 2) {
    try {
      const actualChecks = requiredMatrixChecks(
        candidate,
        qualification,
        policy,
        reviewContext?.expected?.repository
      )
      if (!sameJson(checks, actualChecks)) {
        reasons.push('qualification check claims differ from the actual API job evidence')
      }
    } catch (error) {
      reasons.push(error.message)
    }
  } else if (policy.schemaVersion !== 1) {
    reasons.push('release policy schema version is unsupported')
  }
  const requiredChecks = Array.isArray(policy.requiredChecks)
    ? policy.requiredChecks
    : Array.isArray(policy.requiredJobs)
      ? policy.requiredJobs.flatMap((job) => job.checks ?? [])
      : []
  const permittedSkips = new Set(Array.isArray(policy.permittedSkips) ? policy.permittedSkips : [])

  if (requiredChecks.length === 0) {
    reasons.push('release policy declares no required checks')
  }
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
    if (check.conclusion === 'skipped' && permittedSkips.has(name)) {
      continue
    }
    if (check.conclusion !== 'success') {
      reasons.push(`${name} has conclusion ${check.conclusion ?? 'missing'}`)
    }
  }
  for (const check of checks) {
    if (check?.conclusion === 'skipped' && !permittedSkips.has(check.name)) {
      reasons.push(`${check.name ?? 'unnamed check'} is skipped without a policy predicate`)
    }
  }

  if (
    !isRecord(reviewContext) ||
    !sameReleaseReviewCandidate(reviewContext.expected?.candidate, candidate)
  ) {
    reasons.push('review owner acceptance requires external API evidence for the exact candidate')
  } else {
    reasons.push(...verifyReleaseReview({ ...reviewContext, record: review }, policy, now).reasons)
  }

  return { ok: reasons.length === 0, reasons }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const evidencePath = process.argv[2]
  const policyPath = process.argv[3]
  const reviewContextPath = process.argv[4]
  if (!evidencePath || !policyPath || !reviewContextPath) {
    console.error(
      'usage: node verify-promotion.mjs <evidence.json> <release-policy.json> <review-context.json>'
    )
    process.exitCode = 2
  } else {
    const result = verifyPromotion(
      JSON.parse(readFileSync(evidencePath, 'utf8')),
      JSON.parse(readFileSync(policyPath, 'utf8')),
      JSON.parse(readFileSync(reviewContextPath, 'utf8'))
    )
    console.log(JSON.stringify(result))
    if (!result.ok) {
      process.exitCode = 1
    }
  }
}
