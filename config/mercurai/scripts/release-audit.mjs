import { computeTargetDigest } from './release-state.mjs'

/**
 * Expected steps are derived from what actually happened, then diffed against the recorded evidence.
 * A green workflow is not evidence; a receipt is. Every miss is reported by name so the operator sees
 * the step, not just the verdict.
 */
const STAGES = [
  { state: 'frozen', receipt: 'frozen', label: 'inputs frozen' },
  { state: 'integrating', receipt: 'patchHeads', label: 'patch heads integrated' },
  { state: 'qualifying', receipt: 'candidateSha', label: 'candidate materialised' },
  { state: 'qualified', receipt: 'qualified', label: 'candidate qualified' },
  { state: 'tagged', receipt: 'tagSha', label: 'candidate tagged' },
  { state: 'packaged', receipt: 'artifactDigest', label: 'installer packaged' },
  { state: 'published', receipt: 'channel', label: 'channel published' }
]

const ORDER = STAGES.map((stage) => stage.state)

function reachedIndex(state) {
  if (state.state === 'blocked' || state.state === 'failed') {
    // A blocked candidate keeps the receipts of the stage it stopped at, so the audit names what is
    // still missing rather than pretending nothing was done.
    const highest = state.evidence?.reachedState
    return highest && ORDER.includes(highest) ? ORDER.indexOf(highest) : 0
  }
  return ORDER.indexOf(state.state)
}

function hasReceipt(evidence, key) {
  const value = evidence?.[key]
  if (value === true) {
    return true
  }
  if (typeof value === 'string') {
    return value.length > 0
  }
  // An integrated patch series is recorded as the ordered head list, not as a boolean.
  if (Array.isArray(value)) {
    return value.length > 0
  }
  return false
}

export function auditCandidate(state) {
  if (!state?.candidate) {
    return { generation: null, state: null, expected: [], done: [], missing: ['candidate'] }
  }
  const index = reachedIndex(state)
  const expected = STAGES.slice(0, Math.max(index + 1, 1)).map((stage) => stage.label)
  const done = []
  const missing = []
  for (const stage of STAGES.slice(0, Math.max(index + 1, 1))) {
    if (hasReceipt(state.evidence, stage.receipt)) {
      done.push(stage.label)
    } else {
      missing.push(stage.label)
    }
  }
  if (index >= ORDER.indexOf('integrating') && !state.evidence?.dispatchReceipt?.dispatchId) {
    missing.push('worker dispatch receipt')
  }
  const inventory = state.evidence?.conflictInventory
  if (inventory && inventory.status === 'conflict' && index >= ORDER.indexOf('integrating')) {
    missing.push(`unresolved conflicts (${inventory.conflictCount})`)
  }
  return {
    generation: state.generation,
    state: state.state,
    digest: computeTargetDigest(state.candidate),
    expected,
    done,
    missing
  }
}

/** Promotion is refused unless the candidate's own receipts cover every step it claims. */
export function verifyPromotion(state) {
  if (state?.state !== 'qualified' && state?.state !== 'tagged' && state?.state !== 'packaged') {
    return { ok: false, reason: `candidate is ${state?.state ?? 'absent'}, not promotable` }
  }
  const audit = auditCandidate(state)
  if (audit.missing.length > 0) {
    return { ok: false, reason: `audit is missing ${audit.missing.join(', ')}`, audit }
  }
  if (state.evidence?.audit?.missing?.length > 0) {
    return {
      ok: false,
      reason: `recorded audit is missing ${state.evidence.audit.missing.join(', ')}`,
      audit: state.evidence.audit
    }
  }
  return { ok: true, reason: null, audit }
}

/**
 * Publication is the one effect that cannot be undone. When its status is unknown, look at the channel
 * before doing anything: adopt what is already there, upload only a proven-missing artifact, and refuse
 * to move the channel backwards.
 */
export function reconcilePublication(state, { assets = [], expectedVersion, expectedDigest } = {}) {
  const version = state?.evidence?.version
  const digest = state?.evidence?.artifactDigest
  if (typeof version !== 'string' || version.length === 0) {
    return { action: 'refuse', reason: 'no reserved version is recorded for this candidate' }
  }
  if (typeof digest !== 'string' || digest.length === 0) {
    return { action: 'refuse', reason: 'no artifact digest is recorded for this candidate' }
  }
  if (expectedVersion && expectedVersion !== version) {
    return { action: 'refuse', reason: `reserved version ${version} is not ${expectedVersion}` }
  }
  if (expectedDigest && expectedDigest !== digest) {
    return { action: 'refuse', reason: 'artifact digest does not match the reserved candidate' }
  }
  const published = assets.find((asset) => asset.version === version)
  if (published) {
    if (published.digest !== undefined && published.digest !== digest) {
      return {
        action: 'refuse',
        reason: `channel already serves ${version} with a different artifact; never overwrite it`
      }
    }
    return { action: 'adopt', reason: `${version} is already on the channel`, version }
  }
  const newer = assets.find((asset) => compareVersions(asset.version, version) > 0)
  if (newer) {
    return {
      action: 'refuse',
      reason: `channel already serves newer ${newer.version}; do not move it backwards`
    }
  }
  return { action: 'upload', reason: `${version} is absent from the channel`, version }
}

/** `1.4.242-mercurai.10` sorts above `.9`; a plain string compare would not. */
export function compareVersions(left, right) {
  const parse = (value) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-mercurai\.(\d+))?$/.exec(String(value ?? ''))
    if (!match) {
      return null
    }
    return {
      base: [Number(match[1]), Number(match[2]), Number(match[3])],
      fork: match[4] === undefined ? -1 : Number(match[4])
    }
  }
  const a = parse(left)
  const b = parse(right)
  if (!a || !b) {
    return 0
  }
  for (let index = 0; index < 3; index += 1) {
    if (a.base[index] !== b.base[index]) {
      return a.base[index] - b.base[index]
    }
  }
  return a.fork - b.fork
}
