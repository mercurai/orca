import { readFileSync } from 'node:fs'

import { assertStateSchema, computeTargetDigest, summarizeQueue } from './release-state.mjs'

const activeStates = new Set(['detected', 'frozen', 'integrating', 'qualifying'])

/** Admission only: may this candidate be worked on at all? */
export function checkEligibility(state, { now } = {}) {
  if (!state || !state.candidate) {
    return { eligible: false, reason: 'no candidate is queued' }
  }
  if (!activeStates.has(state.state)) {
    return { eligible: false, reason: `candidate is already ${state.state}` }
  }
  const conflictInventory = state.evidence?.conflictInventory
  if (conflictInventory?.status === 'conflict') {
    return {
      eligible: false,
      reason: `candidate has ${conflictInventory.conflictCount} unresolved upstream conflicts`
    }
  }
  if (state.lease && state.lease.expiresAt > now) {
    return { eligible: false, reason: `lease is held by ${state.lease.owner}` }
  }
  return { eligible: true, reason: null }
}

/**
 * The wake gate: admission plus "did anything actually change?". The scheduler runs every hour and
 * upstream identity is unchanged on most of them, so a no-op hour must cost no model turn.
 */
export function evaluateGate(state, { now, force = false } = {}) {
  if (!state || typeof state !== 'object') {
    return {
      decision: 'refuse',
      changed: false,
      digest: null,
      eligible: false,
      skipped: 0,
      reason: 'no durable release state is available'
    }
  }
  if (state.schemaVersion !== undefined) {
    try {
      assertStateSchema(state)
    } catch (error) {
      return {
        decision: 'refuse',
        changed: false,
        digest: null,
        eligible: false,
        skipped: 0,
        reason: error.message
      }
    }
  }
  const admission = checkEligibility(state, { now })
  const digest = state.candidate ? computeTargetDigest(state.candidate) : null
  const skipped = state.skipped ?? 0
  if (!admission.eligible) {
    return {
      decision: 'refuse',
      changed: false,
      digest,
      eligible: false,
      skipped,
      reason: admission.reason
    }
  }
  if (!force && digest !== null && digest === state.lastEvaluatedDigest) {
    return {
      decision: 'skip',
      changed: false,
      digest,
      eligible: true,
      skipped,
      reason: 'candidate identity is unchanged since the last evaluation'
    }
  }
  return { decision: 'run', changed: true, digest, eligible: true, skipped, reason: null }
}

function flags(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) {
      continue
    }
    values.set(argv[index].slice(2), argv[index + 1])
    index += 1
  }
  return values
}

if (process.argv[1] && process.argv[1].endsWith('release-precheck.mjs')) {
  const argv = process.argv.slice(2)
  const values = flags(argv)
  const statePath = argv.find((value) => !value.startsWith('--') && value !== 'true')
  const force = values.get('force') === 'true' || values.get('force') === ''
  if (!statePath) {
    console.error('usage: node release-precheck.mjs <state.json> [--force]')
    process.exitCode = 2
  } else {
    let state = null
    try {
      state = JSON.parse(readFileSync(statePath, 'utf8'))
    } catch (error) {
      console.log(
        JSON.stringify({
          decision: 'refuse',
          changed: false,
          digest: null,
          eligible: false,
          skipped: 0,
          reason: `durable state is unreadable: ${error.message}`
        })
      )
      process.exitCode = 1
      state = null
    }
    if (state) {
      const gate = evaluateGate(state, { now: Date.now(), force })
      console.log(JSON.stringify({ ...gate, queue: summarizeQueue(state, { now: Date.now() }) }))
      if (gate.decision !== 'run') {
        process.exitCode = 1
      }
    }
  }
}
