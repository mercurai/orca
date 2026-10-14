// The separate claims the speed picker may caption, drawn from the descriptor and the host's speed
// facts without inferring one from another. A stored selection is intent for the next turn; a
// request line is what the host submitted or was refused; processing is shown only when the server
// reported the tier of a turn, otherwise it is unknown.

import type { AgentSessionSpeedFacts } from './agent-session-speed-facts'
import { CODEX_SERVICE_TIER_OPTION_ID } from './codex-service-tier-presentation'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from './native-chat-session-options'

const MAX_DETAIL_LENGTH = 200

export type CodexSpeedLine =
  | { kind: 'pending'; label: string }
  | { kind: 'stored'; label: string }
  | {
      kind: 'last-request'
      outcome: 'sent' | 'accepted' | 'rejected'
      label: string
      detail?: string
    }
  | { kind: 'processing'; label?: string }

function tierLabel(descriptor: SessionOptionDescriptor, tierId: string): string {
  const choices = descriptor.kind.type === 'select' ? descriptor.kind.choices : []
  return choices.find((choice) => choice.value === tierId)?.label ?? tierId
}

/** Empty when the model has no speed select. `dispatched` is a pick this client sent that the host
 *  has not confirmed; `reported` is the host's stored next-turn selection. */
export function codexSpeedLines(
  descriptor: SessionOptionDescriptor | undefined,
  speed: AgentSessionSpeedFacts | undefined
): CodexSpeedLine[] {
  if (
    !descriptor ||
    descriptor.id !== CODEX_SERVICE_TIER_OPTION_ID ||
    descriptor.kind.type !== 'select'
  ) {
    return []
  }
  const lines: CodexSpeedLine[] = []
  const { currentValue } = descriptor.kind
  if (currentValue !== undefined && descriptor.valueSource === 'dispatched') {
    lines.push({ kind: 'pending', label: tierLabel(descriptor, currentValue) })
  } else if (currentValue !== undefined && descriptor.valueSource === 'reported') {
    lines.push({ kind: 'stored', label: tierLabel(descriptor, currentValue) })
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

/** A surface that also reports speed lines. The picker reads them without a new prop, so the
 *  composers that hand it a surface stay unchanged. */
export type SpeedAwareSessionOptionsSurface = SessionOptionsSurface & {
  getSpeedLines(): readonly CodexSpeedLine[]
}

function isSpeedAwareSurface(
  surface: SessionOptionsSurface
): surface is SpeedAwareSessionOptionsSurface {
  return 'getSpeedLines' in surface && typeof surface.getSpeedLines === 'function'
}

export function codexSpeedLinesOfSurface(
  surface: SessionOptionsSurface | null
): readonly CodexSpeedLine[] {
  return surface && isSpeedAwareSurface(surface) ? surface.getSpeedLines() : []
}
