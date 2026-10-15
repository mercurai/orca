// The separate claims the speed picker may caption, drawn from the descriptor and the host's speed
// facts without inferring one from another. A stored selection is intent for the next turn; a
// requested tier is one the host cannot send; a request line is what the host submitted or was
// refused; processing is shown only when the server reported the tier of a turn, otherwise it is
// unknown.

import type { AgentSessionSpeedFacts } from './agent-session-speed-facts'
import { CODEX_SERVICE_TIER_OPTION_ID } from './codex-service-tier-presentation'
import type { SessionOptionDescriptor, SessionOptionsSurface } from './native-chat-session-options'

const MAX_DETAIL_LENGTH = 200

/** Where one client-side wait stands. Presentation only: never persisted, sent to a provider or
 *  shown as server evidence. */
export type SessionOptionProbePhase = 'pending' | 'failed' | 'settled'

/** The separate waits behind the speed select: host capability, the options read and the listing.
 *  One settling never clears another still pending; undefined means the caller has no such wait. */
export type CodexSpeedPresentationPhases = {
  capabilityPhase?: SessionOptionProbePhase
  optionsPhase?: SessionOptionProbePhase
  catalogPhase?: SessionOptionProbePhase
}

export type CodexSpeedLine =
  /** A speed read is still in flight: no claim about any tier, stored or not. */
  | { kind: 'loading' }
  /** A speed read failed and none is in flight: support is unverified, not denied. */
  | { kind: 'support-unverified' }
  | { kind: 'pending'; label: string }
  | { kind: 'stored'; label: string }
  /** The host holds a requested tier it cannot send: shown apart from what it has stored. */
  | { kind: 'requested'; label: string; state: 'unknown' | 'unavailable' }
  | {
      kind: 'last-request'
      outcome: 'sent' | 'accepted' | 'rejected'
      label: string
      detail?: string
    }
  | { kind: 'processing'; label?: string }

const NO_SPEED_LINES: readonly CodexSpeedLine[] = []

function tierLabel(descriptor: SessionOptionDescriptor, tierId: string): string {
  const choices = descriptor.kind.type === 'select' ? descriptor.kind.choices : []
  return choices.find((choice) => choice.value === tierId)?.label ?? tierId
}

/** The tier the host holds as requested but cannot send, from its facts alone: a client that
 *  restarted holds no pick of its own, and `current` is still the last accepted tier. */
function blockedRequestLine(
  descriptor: SessionOptionDescriptor,
  selection: AgentSessionSpeedFacts['selection']
): CodexSpeedLine | null {
  if (selection.state !== 'unavailable' && selection.state !== 'unknown') {
    return null
  }
  if (selection.tierId !== undefined) {
    return {
      kind: 'requested',
      label: tierLabel(descriptor, selection.tierId),
      state: selection.state
    }
  }
  if (selection.legacyFastMode) {
    return { kind: 'requested', label: 'Fast', state: selection.state }
  }
  return null
}

/** Any wait still running reads as loading; failures only count once nothing is running. */
function probePhaseLine(phases: CodexSpeedPresentationPhases | undefined): CodexSpeedLine | null {
  const all = [phases?.capabilityPhase, phases?.optionsPhase, phases?.catalogPhase]
  if (all.includes('pending')) {
    return { kind: 'loading' }
  }
  return all.includes('failed') ? { kind: 'support-unverified' } : null
}

/** Empty when the model has no speed select, except the phase line: the waits can precede any
 *  descriptor, and then name no tier. `dispatched` is a pick this client sent that the host
 *  has not confirmed; `reported` is the host's stored next-turn selection. */
export function codexSpeedLines(
  descriptor: SessionOptionDescriptor | undefined,
  speed: AgentSessionSpeedFacts | undefined,
  phases?: CodexSpeedPresentationPhases
): CodexSpeedLine[] {
  const phaseLine = probePhaseLine(phases)
  if (!descriptor) {
    return phaseLine ? [phaseLine] : []
  }
  if (descriptor.id !== CODEX_SERVICE_TIER_OPTION_ID || descriptor.kind.type !== 'select') {
    return []
  }
  const lines: CodexSpeedLine[] = phaseLine ? [phaseLine] : []
  const { currentValue } = descriptor.kind
  if (currentValue !== undefined && descriptor.valueSource === 'dispatched') {
    lines.push({ kind: 'pending', label: tierLabel(descriptor, currentValue) })
  } else if (currentValue !== undefined && descriptor.valueSource === 'reported') {
    lines.push({ kind: 'stored', label: tierLabel(descriptor, currentValue) })
  }
  const blocked = speed ? blockedRequestLine(descriptor, speed.selection) : null
  // A held pick this client made already names the tier on its pending line.
  const namedAsPending =
    blocked !== null &&
    lines.some((line) => line.kind === 'pending') &&
    speed?.selection.tierId === currentValue
  if (blocked && !namedAsPending) {
    lines.push(blocked)
  }
  const request = speed?.lastRequest
  if (request) {
    lines.push({
      kind: 'last-request',
      outcome: request.state,
      label: tierLabel(descriptor, request.tierId),
      ...(request.detail ? { detail: request.detail.slice(0, MAX_DETAIL_LENGTH) } : {})
    })
  }
  lines.push(
    speed?.processing
      ? { kind: 'processing', label: tierLabel(descriptor, speed.processing.tierId) }
      : { kind: 'processing' }
  )
  return lines
}

/** The wait line, when one exists. A picker with no speed select to hang it on shows it beside the
 *  closed pill; with a select, the select's own rows already carry it. */
export function codexSpeedPhaseLine(lines: readonly CodexSpeedLine[]): CodexSpeedLine | undefined {
  return lines.find((line) => line.kind === 'loading' || line.kind === 'support-unverified')
}

/** A surface or controller that also reports speed lines. The picker reads them without a new
 *  prop, so the composers that hand it one stay unchanged. */
export type SpeedAwareSessionOptionsSurface = SessionOptionsSurface & {
  getSpeedLines(): readonly CodexSpeedLine[]
}

/** The optional speed-line reader a controller may carry beyond its option surface. */
export type SessionOptionSpeedLinesSource = { getSpeedLines?: () => readonly CodexSpeedLine[] }

type SessionOptionSpeedLinesOwner = SessionOptionsSurface | SessionOptionSpeedLinesSource

function reportsSpeedLines(
  source: SessionOptionSpeedLinesOwner
): source is SessionOptionSpeedLinesOwner & { getSpeedLines(): readonly CodexSpeedLine[] } {
  return 'getSpeedLines' in source && typeof source.getSpeedLines === 'function'
}

export function codexSpeedLinesOfSurface(
  source: SessionOptionSpeedLinesOwner | null
): readonly CodexSpeedLine[] {
  return source && reportsSpeedLines(source) ? source.getSpeedLines() : NO_SPEED_LINES
}
