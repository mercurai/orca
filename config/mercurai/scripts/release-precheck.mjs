import { readFileSync } from 'node:fs'

const activeStates = new Set(['detected', 'frozen', 'integrating', 'qualifying'])

export function checkEligibility(state, { now } = {}) {
  if (!state || !state.candidate) return { eligible: false, reason: 'no candidate is queued' }
  if (!activeStates.has(state.state)) return { eligible: false, reason: `candidate is already ${state.state}` }
  const conflictInventory = state.evidence?.conflictInventory
  if (conflictInventory?.status === 'conflict') {
    return {
      eligible: false,
      reason: `candidate has ${conflictInventory.conflictCount} unresolved upstream conflicts`
    }
  }
  if (state.lease && state.lease.expiresAt > now) return { eligible: false, reason: `lease is held by ${state.lease.owner}` }
  return { eligible: true, reason: null }
}

if (process.argv[1] && process.argv[1].endsWith('release-precheck.mjs')) {
  const statePath = process.argv[2]
  if (!statePath) {
    console.error('usage: node release-precheck.mjs <state.json>')
    process.exitCode = 2
  } else {
    const result = checkEligibility(JSON.parse(readFileSync(statePath, 'utf8')), { now: Date.now() })
    console.log(JSON.stringify(result))
    if (!result.eligible) process.exitCode = 1
  }
}
