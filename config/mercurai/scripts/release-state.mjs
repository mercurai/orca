import { createHash } from 'node:crypto'

const SHA40 = /^[0-9a-f]{40}$/

/**
 * Bumped only with a migration. A reader that meets an unknown version refuses the state instead of
 * interpreting fields it does not understand (a wrong interpretation of durable state is worse than a stop).
 */
export const STATE_SCHEMA_VERSION = 1

const transitions = {
  detected: ['frozen', 'blocked', 'failed'],
  frozen: ['integrating', 'blocked', 'failed'],
  integrating: ['qualifying', 'blocked', 'failed'],
  qualifying: ['qualified', 'blocked', 'failed'],
  qualified: ['tagged', 'blocked', 'failed'],
  tagged: ['packaged', 'blocked', 'failed'],
  packaged: ['published', 'blocked', 'failed'],
  published: [],
  blocked: [],
  failed: []
}

export class StateConflictError extends Error {
  constructor(message) {
    super(message)
    this.name = 'StateConflictError'
  }
}

const copy = (value) => structuredClone(value)

function requireSha(value, label) {
  if (typeof value !== 'string' || !SHA40.test(value)) {
    throw new TypeError(`${label} must be a lowercase 40-character sha`)
  }
}

function validateTarget(target) {
  if (!target || typeof target !== 'object') {
    throw new TypeError('candidate target is required')
  }
  for (const [key, value] of [
    ['upstreamMainSha', target.upstreamMainSha],
    ['controllerSha', target.controllerSha]
  ]) {
    requireSha(value, key)
  }
  if (target.stableTagSha !== undefined) {
    requireSha(target.stableTagSha, 'stableTagSha')
  }
  if (typeof target.stableTag !== 'string' || !/^v\d+\.\d+\.\d+$/.test(target.stableTag)) {
    throw new TypeError('stableTag must be a stable upstream version')
  }
  if (!Array.isArray(target.patchHeads)) {
    throw new TypeError('patchHeads must be an array')
  }
  for (const patch of target.patchHeads) {
    if (
      !patch ||
      typeof patch.branch !== 'string' ||
      !/^patch\/[A-Za-z0-9._-]+$/.test(patch.branch)
    ) {
      throw new TypeError('patch branch is invalid')
    }
    requireSha(patch.commit, `patch ${patch.branch} commit`)
    if (patch.base !== undefined) {
      requireSha(patch.base, `patch ${patch.branch} base`)
    }
  }
}

/** Canonical identity of a candidate target: two equal digests mean the same work, byte for byte. */
export function computeTargetDigest(target) {
  validateTarget(target)
  return createHash('sha256')
    .update(
      JSON.stringify({
        upstreamMainSha: target.upstreamMainSha,
        stableTag: target.stableTag,
        stableTagSha: target.stableTagSha ?? null,
        controllerSha: target.controllerSha,
        patchHeads: target.patchHeads.map((patch) => ({
          branch: patch.branch,
          commit: patch.commit,
          base: patch.base ?? null
        }))
      })
    )
    .digest('hex')
}

/** Refuse a state written by another schema instead of guessing what its fields mean. */
export function assertStateSchema(state) {
  if (!state || typeof state !== 'object') {
    throw new TypeError('state is required')
  }
  if (state.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new TypeError(
      `state schemaVersion ${String(state.schemaVersion)} is not supported; expected ${STATE_SCHEMA_VERSION}`
    )
  }
  return state
}

function checkVersion(state, expectedVersion) {
  if (!Number.isInteger(expectedVersion) || expectedVersion !== state.version) {
    throw new StateConflictError(
      `state version ${state.version} does not match expected ${expectedVersion}`
    )
  }
}

function timestamp(value) {
  if (value === undefined) {
    return new Date().toISOString()
  }
  return typeof value === 'number' ? new Date(value).toISOString() : value
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} is required`)
  }
}

export function createState(target, { now } = {}) {
  validateTarget(target)
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    version: 0,
    generation: 1,
    state: 'detected',
    candidate: copy(target),
    queuedTarget: null,
    lease: null,
    evidence: {},
    // Work the coordinator must not attempt twice, and approvals a human already gave for one range.
    parked: [],
    approvalMemo: {},
    lastEvaluatedDigest: null,
    skipped: 0,
    updatedAt: timestamp(now)
  }
}

function requiredEvidence(to, evidence) {
  const requirements = {
    qualified: ['qualified'],
    tagged: ['tagSha'],
    packaged: ['artifactDigest'],
    published: ['channel']
  }
  for (const key of requirements[to] ?? []) {
    if (
      evidence[key] !== true &&
      (typeof evidence[key] !== 'string' || evidence[key].length === 0)
    ) {
      throw new TypeError(`${to} requires evidence.${key}`)
    }
  }
}

export function transitionState(state, { expectedVersion, to, owner, evidence = {}, now } = {}) {
  checkVersion(state, expectedVersion)
  requireString(owner, 'owner')
  if (!Object.hasOwn(transitions, state.state) || !transitions[state.state].includes(to)) {
    throw new StateConflictError(`invalid transition ${state.state} -> ${to}`)
  }
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new TypeError('evidence must be an object')
  }
  if (to === 'blocked' || to === 'failed') {
    requireString(evidence.reason, `evidence.reason for ${to}`)
  } else {
    requiredEvidence(to, evidence)
  }
  return {
    ...copy(state),
    version: state.version + 1,
    state: to,
    evidence: { ...copy(state.evidence), ...copy(evidence), owner },
    updatedAt: timestamp(now)
  }
}

export function claimLease(state, { expectedVersion, owner, now, leaseMs = 15 * 60 * 1000 } = {}) {
  checkVersion(state, expectedVersion)
  requireString(owner, 'owner')
  if (!Number.isFinite(now) || !Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new TypeError('lease timing is invalid')
  }
  const current = state.lease
  if (current && current.expiresAt > now && current.owner !== owner) {
    throw new StateConflictError(`lease is held by ${current.owner}`)
  }
  return {
    ...copy(state),
    version: state.version + 1,
    lease: { owner, acquiredAt: now, expiresAt: now + leaseMs },
    updatedAt: timestamp()
  }
}

/**
 * Queue one pending target. A target identical to the queued one is not re-queued: the coordinator
 * runs hourly and upstream identity is unchanged on most of those runs, so a version bump per run
 * would be pure churn.
 */
export function enqueueTarget(state, target, { now } = {}) {
  validateTarget(target)
  if (state.queuedTarget && computeTargetDigest(state.queuedTarget) === computeTargetDigest(target)) {
    return copy(state)
  }
  return {
    ...copy(state),
    version: state.version + 1,
    queuedTarget: copy(target),
    updatedAt: timestamp(now)
  }
}

export function activateQueuedTarget(state, { expectedVersion, now } = {}) {
  checkVersion(state, expectedVersion)
  if (!state.queuedTarget) {
    throw new StateConflictError('no queued target is available')
  }
  if (!['published', 'blocked', 'failed'].includes(state.state)) {
    throw new StateConflictError(
      `cannot activate a queued target while candidate is ${state.state}`
    )
  }
  const currentTime = typeof now === 'number' ? now : Date.now()
  if (state.lease && state.lease.expiresAt > currentTime) {
    throw new StateConflictError(`lease is held by ${state.lease.owner}`)
  }
  return {
    ...copy(state),
    version: state.version + 1,
    generation: state.generation + 1,
    state: 'detected',
    candidate: copy(state.queuedTarget),
    queuedTarget: null,
    lease: null,
    evidence: {},
    lastEvaluatedDigest: null,
    updatedAt: timestamp(now)
  }
}

/**
 * Record what the gate looked at. `skipped` is the wake-gate counter: consecutive evaluations that
 * found nothing to do. A coordinator that keeps skipping is healthy, not stuck.
 */
export function recordEvaluation(state, { digest, changed, now } = {}) {
  requireString(digest, 'digest')
  if (typeof changed !== 'boolean') {
    throw new TypeError('changed must be a boolean')
  }
  return {
    ...copy(state),
    version: state.version + 1,
    lastEvaluatedDigest: digest,
    skipped: changed ? 0 : (state.skipped ?? 0) + 1,
    updatedAt: timestamp(now)
  }
}

/** Park one blocked item so the rest of the queue keeps moving. Identity is (kind, key). */
export function parkItem(state, { kind, key, reason, unblocksAt = null, evidence = {} }, { now } = {}) {
  requireString(kind, 'kind')
  requireString(key, 'key')
  requireString(reason, 'reason')
  if (unblocksAt !== null && typeof unblocksAt !== 'string') {
    throw new TypeError('unblocksAt must be an ISO timestamp or null')
  }
  const entry = {
    kind,
    key,
    reason,
    unblocksAt,
    evidence: copy(evidence),
    recordedAt: timestamp(now)
  }
  const parked = (state.parked ?? []).filter((item) => !(item.kind === kind && item.key === key))
  parked.push(entry)
  return {
    ...copy(state),
    version: state.version + 1,
    parked,
    updatedAt: timestamp(now)
  }
}

export function clearParked(state, { kind, key } = {}, { now } = {}) {
  requireString(kind, 'kind')
  requireString(key, 'key')
  const parked = (state.parked ?? []).filter((item) => !(item.kind === kind && item.key === key))
  if (parked.length === (state.parked ?? []).length) {
    return copy(state)
  }
  return { ...copy(state), version: state.version + 1, parked, updatedAt: timestamp(now) }
}

export function findParked(state, { kind, key } = {}) {
  return (state.parked ?? []).find((item) => item.kind === kind && item.key === key) ?? null
}

/**
 * Remember one owner approval for exactly one reviewed range. The coordinator may read this and may
 * never write it: the caller of this function is the owner-intake path, not the agent.
 */
export function recordApproval(state, { kind, key, approver, sha, rangeDigest }, { now } = {}) {
  requireString(kind, 'kind')
  requireString(key, 'key')
  requireString(approver, 'approver')
  requireString(rangeDigest, 'rangeDigest')
  requireSha(sha, 'sha')
  const memo = copy(state.approvalMemo ?? {})
  const entries = (memo[key] ?? []).filter(
    (entry) => !(entry.approver === approver && entry.rangeDigest === rangeDigest)
  )
  entries.push({ kind, approver, sha, rangeDigest, recordedAt: timestamp(now) })
  memo[key] = entries
  return { ...copy(state), version: state.version + 1, approvalMemo: memo, updatedAt: timestamp(now) }
}

/** True only when this approver already approved this exact range. A changed range is a new question. */
export function findApproval(state, { key, approver, rangeDigest } = {}) {
  requireString(key, 'key')
  requireString(approver, 'approver')
  requireString(rangeDigest, 'rangeDigest')
  return (
    (state.approvalMemo?.[key] ?? []).find(
      (entry) => entry.approver === approver && entry.rangeDigest === rangeDigest
    ) ?? null
  )
}

/** The operator-facing answer: what can run, what is waiting, and why. */
export function summarizeQueue(state, { now } = {}) {
  const current = typeof now === 'number' ? now : Date.now()
  const parked = state.parked ?? []
  return {
    generation: state.generation,
    state: state.state,
    eligible: ['detected', 'frozen', 'integrating', 'qualifying'].includes(state.state),
    parked: parked.map((item) => ({
      kind: item.kind,
      key: item.key,
      reason: item.reason,
      unblocksAt: item.unblocksAt
    })),
    parkedCount: parked.length,
    skipped: state.skipped ?? 0,
    lease: state.lease && state.lease.expiresAt > current ? state.lease.owner : null,
    queued: state.queuedTarget ? computeTargetDigest(state.queuedTarget) : null,
    digest: computeTargetDigest(state.candidate)
  }
}
