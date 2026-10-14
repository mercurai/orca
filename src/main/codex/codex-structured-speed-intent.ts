// Codex speed intent as a session stores it: the shared tier rules plus one provider-private record of
// a pick Orca refused. The record sits beside the accepted canonical tier in the option map, so a
// refusal survives restart and every option rewrite; the next turn stays blocked until an explicit
// accepted replacement. It is never a public option key and never rides a provider request.

import {
  admitCodexServiceTierForTurn,
  CodexServiceTierSelectionError,
  codexServiceTierState,
  codexServiceTierSupport,
  normalizeCodexServiceTierOptions,
  readCodexServiceTierOptions,
  type CodexRestingOptionsReadResult
} from '../../shared/codex-service-tier-selection'
import type {
  RestingOptionsNormalizeInput,
  RestingOptionsReadInput
} from '../../shared/structured-agent-session-resting-options'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import { decodeStructuredAgentSessionOptionValue } from '../../shared/structured-agent-session-option-codec'
import type { CodexSession, CodexSpeedBlock } from './codex-structured-session-state'

const REFUSED_TIER_KEY = 'refusedServiceTier'
const MAX_DIAGNOSTIC_ID_LENGTH = 80
const CANONICAL_SPEED_KEYS = ['serviceTier', 'fastMode'] as const

export function isCodexRefusedTierKey(key: string): boolean {
  return key === REFUSED_TIER_KEY
}

/** The tier id a person asked for and was refused, still awaiting an explicit replacement. */
export function refusedCodexServiceTier(
  options: Readonly<Record<string, string>>
): string | undefined {
  return options[REFUSED_TIER_KEY] || undefined
}

function withoutRefusedTier(options: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(options).filter(([key]) => !isCodexRefusedTierKey(key)))
}

/** `options` with `tierId` as the blocked requested tier, unless an earlier refusal already is:
 *  a failed replacement never clears the block it was meant to replace. */
export function withBlockedRequestedTier(
  options: Readonly<Record<string, string>>,
  tierId: string
): Record<string, string> {
  return refusedCodexServiceTier(options)
    ? { ...options }
    : { ...options, [REFUSED_TIER_KEY]: tierId }
}

/** The refused id stays blocked even once a refresh offers it, so it is never `ready`. */
function refusedTierState(
  refused: string,
  input: RestingOptionsReadInput
): 'unknown' | 'unavailable' {
  const support = codexServiceTierSupport({
    models: input.models,
    modelId: input.options.model ?? input.currentModel,
    catalogKnown: input.catalogKnown
  })
  return codexServiceTierState(refused, support) === 'unknown' ? 'unknown' : 'unavailable'
}

class CodexRefusedTierBlockedError extends CodexServiceTierSelectionError {
  constructor(reason: 'unknown' | 'unavailable', tierId: string) {
    super(reason, { tierId })
    const id = JSON.stringify(tierId.slice(0, MAX_DIAGNOSTIC_ID_LENGTH))
    this.message = `Codex service tier ${id} was refused and stays blocked until another speed is chosen.`
  }
}

class CodexSpeedQuarantinedError extends CodexServiceTierSelectionError {
  constructor() {
    super('unknown', {})
    this.message =
      'Codex speed selection is blocked until another speed is chosen: the last speed change was not saved.'
  }
}

/** Refuses a new `turn/start` while the session's live speed is not known to match its record. */
export function assertCodexSpeedAdmissionOpen(host: { speedQuarantined?: true }): void {
  if (host.speedQuarantined) {
    throw new CodexSpeedQuarantinedError()
  }
}

/** The complete option map after a restore, launch seed or option write. An explicit valid exact
 *  tier the catalog cannot back is refused with the map that remembers it as requested intent;
 *  an accepted explicit speed action replaces that intent. Anything else keeps it. */
export function normalizeCodexSpeedIntent(
  input: RestingOptionsNormalizeInput
): Record<string, string> {
  let next: Record<string, string>
  try {
    next = normalizeCodexServiceTierOptions(input)
  } catch (error) {
    if (
      input.origin === 'set-option' &&
      error instanceof CodexServiceTierSelectionError &&
      error.tierId !== undefined
    ) {
      throw new AgentSessionOptionRejectedError(error, 'optionRejected', {
        ...input.priorOptions,
        [REFUSED_TIER_KEY]: error.tierId
      })
    }
    throw error
  }
  const isSpeedAction =
    input.origin === 'set-option' &&
    (input.changes.serviceTier !== undefined || input.changes.fastMode !== undefined)
  return isSpeedAction ? withoutRefusedTier(next) : next
}

/** Canonical current values stay the accepted tier; a refused pick is reported as the blocked
 *  selection beside it. */
export function readCodexSpeedIntent(
  input: RestingOptionsReadInput
): CodexRestingOptionsReadResult {
  const stored = readCodexServiceTierOptions(input)
  const refused = refusedCodexServiceTier(input.options)
  if (!refused) {
    return stored
  }
  return {
    ...stored,
    speed: {
      ...stored.speed,
      selection: { tierId: refused, state: refusedTierState(refused, input) }
    }
  }
}

/** `stored` with legacy Fast that was requested and never saved as the blocked selection, beside the
 *  acknowledged tier. A refused exact tier already in the map is the one reported instead. */
export function withBlockedLegacyFastSelection(
  stored: CodexRestingOptionsReadResult,
  input: RestingOptionsReadInput
): CodexRestingOptionsReadResult {
  if (refusedCodexServiceTier(input.options)) {
    return stored
  }
  const support = codexServiceTierSupport({
    models: input.models,
    modelId: input.options.model ?? input.currentModel,
    catalogKnown: input.catalogKnown
  })
  return {
    ...stored,
    speed: {
      ...stored.speed,
      selection: { legacyFastMode: true, state: support.known ? 'unavailable' : 'unknown' }
    }
  }
}

/** The exact tier the next `turn/start` carries; throws before any write when the selection is
 *  refused, unavailable or unverifiable. */
export function admitCodexSpeedIntentForTurn(input: RestingOptionsReadInput): string | undefined {
  const refused = refusedCodexServiceTier(input.options)
  if (refused) {
    throw new CodexRefusedTierBlockedError(refusedTierState(refused, input), refused)
  }
  return admitCodexServiceTierForTurn(input)
}

// ─── Recovery after a write that could not be saved ─────────────────────────

/** The session state the speed block lives in; the option map is shared with the session's turns. */
export type CodexSpeedProviderHost = Pick<
  CodexSession,
  | 'options'
  | 'speedQuarantined'
  | 'blockedLegacyFastMode'
  | 'speedBlockBeforeWrite'
  | 'speedCapture'
>

/** The saved options a record reads back as; throws for a record that cannot be read. */
type RestoreCodexOptions = (
  options: Readonly<Record<string, string>> | undefined
) => Map<string, string>

/** Replaces a session's stored options in place; the Map's identity is shared with its turns. */
export function replaceCodexSessionOptions(
  options: Map<string, string>,
  next: Readonly<Record<string, string>>
): void {
  options.clear()
  for (const [key, value] of Object.entries(next)) {
    options.set(key, value)
  }
}

/** What blocks the session's speed now: a refusal marker, legacy Fast, quarantine, or a capture's
 *  request, flagged `attempted` while only the failed write that carried it ever held it. */
export function speedBlockInForce(host: CodexSpeedProviderHost): CodexSpeedBlock {
  const marker = refusedCodexServiceTier(Object.fromEntries(host.options))
  const refusedTier = marker ?? host.speedCapture?.refusedTier
  return {
    ...(refusedTier ? { refusedTier } : {}),
    ...(host.blockedLegacyFastMode ? { legacyFastMode: true as const } : {}),
    ...(host.speedQuarantined ? { quarantined: true as const } : {}),
    ...(!marker && host.speedCapture?.attempted ? { attempted: true as const } : {})
  }
}

/** The speed request a failed write carried; read from the live map before it is restored. */
function attemptedSpeedBlock(
  host: CodexSpeedProviderHost,
  failed: { key: string; value: string }
): CodexSpeedBlock {
  if (failed.key === 'serviceTier') {
    return { refusedTier: failed.value }
  }
  if (failed.key !== 'fastMode') {
    return {}
  }
  const resolved = host.options.get('serviceTier')
  if (resolved !== undefined) {
    return { refusedTier: resolved }
  }
  return decodeStructuredAgentSessionOptionValue('fastMode', failed.value) === true
    ? { legacyFastMode: true }
    : {}
}

function holdsSpeedRequest(block: CodexSpeedBlock): boolean {
  return Boolean(block.refusedTier || block.legacyFastMode)
}

/**
 * Puts a session's live options back on its record after the write that changed them could not be
 * saved. The record's own options return; the speed the person asked for stays blocked beside the
 * acknowledged tier, and a block the write found in force is never released by its failure: the
 * earlier request outranks the attempted one, unless only an earlier failed write ever carried it.
 * Admission is quarantined and the request captured first, with the live tier no longer taken for
 * the record's, so a restore that throws leaves new turns refused and reads unverified rather than
 * spending or reporting a map nobody saved; only an accepted speed pick lifts it. Synchronous and
 * in memory, so it makes no promise past a restart.
 */
export function recoverCodexSpeedAfterFailedSave(
  host: CodexSpeedProviderHost,
  failed: { key: string; value: string; priorOptions: Readonly<Record<string, string>> },
  restore: RestoreCodexOptions
): void {
  const earlier: CodexSpeedBlock = host.speedBlockBeforeWrite ?? {}
  const attempted = attemptedSpeedBlock(host, failed)
  let blocked = earlier
  if (!holdsSpeedRequest(earlier) || earlier.attempted) {
    blocked = holdsSpeedRequest(attempted) ? { ...attempted, attempted: true as const } : earlier
  }
  host.speedQuarantined = true
  host.speedCapture = {
    ...(blocked.refusedTier ? { refusedTier: blocked.refusedTier } : {}),
    ...(blocked.attempted ? { attempted: true as const } : {})
  }
  if (blocked.legacyFastMode) {
    host.blockedLegacyFastMode = true
  }
  for (const key of CANONICAL_SPEED_KEYS) {
    host.options.delete(key)
  }
  const restored = Object.fromEntries(restore(failed.priorOptions))
  replaceCodexSessionOptions(
    host.options,
    blocked.refusedTier ? withBlockedRequestedTier(restored, blocked.refusedTier) : restored
  )
  if (!blocked.legacyFastMode) {
    delete host.blockedLegacyFastMode
  }
  delete host.speedCapture
  // A speed write with no request to keep stays refused: nothing says the live map is the record.
  const isSpeedWrite = failed.key === 'serviceTier' || failed.key === 'fastMode'
  if (!blocked.legacyFastMode && !earlier.quarantined && !(isSpeedWrite && !blocked.refusedTier)) {
    delete host.speedQuarantined
  }
}

/**
 * Takes the record's canonical speed back into a session whose live map a failed save left without
 * one, and keeps the captured exact tier as the refusal marker every settled map then carries.
 * With no readable saved record at hand the capture stays, and only an explicit speed pick, which
 * replaces the tier, may go on; any other write throws before it settles anything from that map.
 */
export function reconcileCodexSpeedCapture(
  host: CodexSpeedProviderHost,
  key: string,
  saved: Readonly<Record<string, string>> | undefined,
  restore: RestoreCodexOptions
): void {
  const capture = host.speedCapture
  if (!capture) {
    return
  }
  let record: Map<string, string> | undefined
  try {
    record = saved && restore(saved)
  } catch {
    record = undefined
  }
  if (!record) {
    if (key === 'serviceTier' || key === 'fastMode') {
      return
    }
    throw new Error('codex speed cannot be verified against the saved options')
  }
  for (const speedKey of CANONICAL_SPEED_KEYS) {
    const value = record.get(speedKey)
    if (value === undefined) {
      host.options.delete(speedKey)
    } else {
      host.options.set(speedKey, value)
    }
  }
  const refused =
    refusedCodexServiceTier(Object.fromEntries(host.options)) ??
    capture.refusedTier ??
    refusedCodexServiceTier(Object.fromEntries(record))
  if (refused) {
    host.options.set(REFUSED_TIER_KEY, refused)
  }
  delete host.speedCapture
}

/** An accepted explicit speed pick replaces whatever a failed save left guarding admission. */
export function releaseCodexSpeedBlock(host: CodexSpeedProviderHost): void {
  delete host.speedQuarantined
  delete host.blockedLegacyFastMode
  delete host.speedCapture
}

/** The session's speed as a live read reports it. A capture's exact tier is the blocked request,
 *  and a speed no record has verified is never `ready`: the live map holds no canonical tier. */
export function readCodexSessionSpeed(
  host: CodexSpeedProviderHost,
  input: Omit<RestingOptionsReadInput, 'options'>
): CodexRestingOptionsReadResult {
  const live = Object.fromEntries(host.options)
  const captured = host.speedCapture?.refusedTier
  const options = captured ? withBlockedRequestedTier(live, captured) : live
  const readInput = { ...input, options }
  const read = readCodexSpeedIntent(readInput)
  if (host.blockedLegacyFastMode) {
    return withBlockedLegacyFastSelection(read, readInput)
  }
  if (host.speedCapture && read.speed.selection.state === 'unselected') {
    return { ...read, speed: { ...read.speed, selection: { state: 'unknown' } } }
  }
  return read
}
