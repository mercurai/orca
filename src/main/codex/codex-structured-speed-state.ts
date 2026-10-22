import type { AgentSessionSpeed } from '../../shared/agent-session-speed'
import type { CodexModelCatalogListing } from './codex-structured-model-catalog'
import type { CodexSession } from './codex-structured-session-state'
import { CODEX_DEFAULT_SERVICE_TIER, codexFastServiceTier } from './codex-structured-service-tier'

/** Request facts belong to one acquisition, never saved preferences or a thread config echo. */
export type CodexSpeedRequestState = {
  speedDispatchSequence?: number
  speedAcknowledgedSequence?: number
  speedApplied?: { sequence: number; tierId: string; turnId: string | null }
  catalogListingInProgress?: boolean
}

export function acknowledgeCodexSpeed(
  host: CodexSpeedRequestState,
  sequence: number,
  tierId: string | undefined,
  turnId: string | null
): void {
  if (sequence <= (host.speedAcknowledgedSequence ?? 0)) {
    return
  }
  host.speedAcknowledgedSequence = sequence
  host.speedApplied = tierId === undefined ? undefined : { sequence, tierId, turnId }
}

export function readCodexSessionSpeed(
  session: CodexSession,
  listing: CodexModelCatalogListing
): AgentSessionSpeed {
  const tierId = session.options.get('serviceTier')
  const legacyFast = tierId === undefined && session.options.get('fastMode') === 'true'
  const requested =
    tierId !== undefined ? { tierId } : legacyFast ? { legacyFast: true as const } : undefined
  const access = session.catalogAccess
  const entry = access?.read ? access.read(true) : access?.store.get(access.fingerprint)
  const usable =
    !access ||
    (!!entry &&
      !access.store.isStale(entry, 'latest') &&
      !access.store.hasActiveFailure(access.fingerprint))
  const modelId = session.options.get('model') ?? session.reportedOptions.model
  const model = (access ? entry?.models : listing.models)?.find((row) => row.id === modelId)
  let support: AgentSessionSpeed['support'] = 'unknown'
  if (usable && model?.serviceTiers !== undefined) {
    const selected = legacyFast ? codexFastServiceTier(model) : tierId
    const available =
      legacyFast && selected === undefined
        ? false
        : selected === undefined ||
          selected === CODEX_DEFAULT_SERVICE_TIER ||
          model.serviceTiers.some((row) => row.value === selected)
    support = available ? 'available' : 'unavailable'
  } else if (
    session.catalogListingInProgress ||
    (access && access.store.isListing(access.fingerprint))
  ) {
    support = 'loading'
  }
  const applied = session.speedApplied
  return {
    ...(requested ? { requested } : {}),
    support,
    ...(applied ? { applied: { tierId: applied.tierId, turnId: applied.turnId } } : {}),
    processing: { status: 'unknown' }
  }
}
