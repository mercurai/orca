const SHA40 = /^[0-9a-f]{40}$/

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
  if (typeof value !== 'string' || !SHA40.test(value)) throw new TypeError(`${label} must be a lowercase 40-character sha`)
}

function validateTarget(target) {
  if (!target || typeof target !== 'object') throw new TypeError('candidate target is required')
  for (const [key, value] of [
    ['upstreamMainSha', target.upstreamMainSha],
    ['controllerSha', target.controllerSha]
  ]) requireSha(value, key)
  if (target.stableTagSha !== undefined) requireSha(target.stableTagSha, 'stableTagSha')
  if (typeof target.stableTag !== 'string' || !/^v\d+\.\d+\.\d+$/.test(target.stableTag)) {
    throw new TypeError('stableTag must be a stable upstream version')
  }
  if (!Array.isArray(target.patchHeads)) throw new TypeError('patchHeads must be an array')
  for (const patch of target.patchHeads) {
    if (!patch || typeof patch.branch !== 'string' || !/^patch\/[A-Za-z0-9._-]+$/.test(patch.branch)) {
      throw new TypeError('patch branch is invalid')
    }
    requireSha(patch.commit, `patch ${patch.branch} commit`)
    if (patch.base !== undefined) requireSha(patch.base, `patch ${patch.branch} base`)
  }
}

function checkVersion(state, expectedVersion) {
  if (!Number.isInteger(expectedVersion) || expectedVersion !== state.version) {
    throw new StateConflictError(`state version ${state.version} does not match expected ${expectedVersion}`)
  }
}

function timestamp(value) {
  if (value === undefined) return new Date().toISOString()
  return typeof value === 'number' ? new Date(value).toISOString() : value
}

export function createState(target, { now } = {}) {
  validateTarget(target)
  return {
    schemaVersion: 1,
    version: 0,
    generation: 1,
    state: 'detected',
    candidate: copy(target),
    queuedTarget: null,
    lease: null,
    evidence: {},
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
    if (evidence[key] !== true && (typeof evidence[key] !== 'string' || evidence[key].length === 0)) {
      throw new TypeError(`${to} requires evidence.${key}`)
    }
  }
}

export function transitionState(state, { expectedVersion, to, owner, evidence = {}, now } = {}) {
  checkVersion(state, expectedVersion)
  if (typeof owner !== 'string' || owner.length === 0) throw new TypeError('owner is required')
  if (!Object.hasOwn(transitions, state.state) || !transitions[state.state].includes(to)) {
    throw new StateConflictError(`invalid transition ${state.state} -> ${to}`)
  }
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw new TypeError('evidence must be an object')
  if (to === 'blocked' || to === 'failed') {
    if (typeof evidence.reason !== 'string' || evidence.reason.length === 0) {
      throw new TypeError(`${to} requires evidence.reason`)
    }
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
  if (typeof owner !== 'string' || owner.length === 0) throw new TypeError('owner is required')
  if (!Number.isFinite(now) || !Number.isFinite(leaseMs) || leaseMs <= 0) throw new TypeError('lease timing is invalid')
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

export function enqueueTarget(state, target, { now } = {}) {
  validateTarget(target)
  return {
    ...copy(state),
    version: state.version + 1,
    queuedTarget: copy(target),
    updatedAt: timestamp(now)
  }
}

export function activateQueuedTarget(state, { expectedVersion, now } = {}) {
  checkVersion(state, expectedVersion)
  if (!state.queuedTarget) throw new StateConflictError('no queued target is available')
  if (!['published', 'blocked', 'failed'].includes(state.state)) {
    throw new StateConflictError(`cannot activate a queued target while candidate is ${state.state}`)
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
    updatedAt: timestamp(now)
  }
}
