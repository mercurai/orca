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

const REFUSED_TIER_KEY = 'refusedServiceTier'
const MAX_DIAGNOSTIC_ID_LENGTH = 80

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
