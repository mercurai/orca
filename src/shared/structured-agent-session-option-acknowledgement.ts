// What an explicit option action leaves behind, apart from what the host reports as stored: the
// speed a person asked for that no accepted answer has replaced yet (held, refused or unanswered),
// whether that keeps sends out, and which values an accepted answer commits. A host's merged
// acknowledgement is not the action, and a stored selection is never the request.

import type { AgentSessionOptionsResult } from './agent-session-wire'
import type { AgentSessionSpeedFacts } from './agent-session-speed-facts'
import { CODEX_SERVICE_TIER_OPTION_ID } from './codex-service-tier-presentation'
import { STRUCTURED_LAUNCH_SEED_OPTION_IDS } from './native-chat-session-option-defaults'
import { resolveEffectiveNativeChatModelId } from './native-chat-session-option-snapshot'
import {
  clearTrackedSessionOption,
  setTrackedSessionOption
} from './native-chat-session-option-state'
import { decodeStructuredAgentSessionOptionValue } from './structured-agent-session-option-codec'
import type { StructuredAgentSessionOptionState } from './structured-agent-session-options'

const LEGACY_FAST_MODE_OPTION_ID = 'fastMode'

export function commitStructuredAgentSessionOption(
  state: StructuredAgentSessionOptionState,
  id: string,
  value: string
): StructuredAgentSessionOptionState {
  if (!state.catalog) {
    return state
  }
  const effectiveModel = resolveEffectiveNativeChatModelId(
    state.catalog,
    state.catalog.models,
    state.record
  )
  const decoded = decodeStructuredAgentSessionOptionValue(id, value)
  if (decoded === null) {
    return { ...state, pendingId: null }
  }
  // An explicit pick of one speed control replaces the other's intent.
  if (id === LEGACY_FAST_MODE_OPTION_ID || id === CODEX_SERVICE_TIER_OPTION_ID) {
    clearTrackedSessionOption(
      state.record,
      effectiveModel,
      id === LEGACY_FAST_MODE_OPTION_ID ? CODEX_SERVICE_TIER_OPTION_ID : LEGACY_FAST_MODE_OPTION_ID
    )
  }
  setTrackedSessionOption(state.record, id, decoded, 'dispatched', effectiveModel)
  return { ...state, pendingId: null }
}

export function commitStructuredAgentSessionOptionValues(
  state: StructuredAgentSessionOptionState,
  values: Readonly<Record<string, string>>
): StructuredAgentSessionOptionState {
  let next = state
  for (const id of STRUCTURED_LAUNCH_SEED_OPTION_IDS) {
    const value = values[id]
    // The host's boolean beside a canonical tier is its projection, not a second pick.
    const projection =
      id === LEGACY_FAST_MODE_OPTION_ID && values[CODEX_SERVICE_TIER_OPTION_ID] !== undefined
    if (value !== undefined && !projection) {
      next = commitStructuredAgentSessionOption(next, id, value)
    }
  }
  return next
}

/** The wire id and encoded value of a speed the host has not accepted. */
export type StructuredAgentSessionRequestedSpeed = { id: string; value: string }

/** Codex's two speed controls: the catalog tier select and the older Fast toggle. */
export function isStructuredAgentSessionSpeedOption(agent: string, id: string): boolean {
  return (
    agent === 'codex' && (id === CODEX_SERVICE_TIER_OPTION_ID || id === LEGACY_FAST_MODE_OPTION_ID)
  )
}

/** Holds a speed action's request from the moment it starts: unanswered, refused and unknown
 *  outcomes all leave it in place, and only an accepted replacement (or the host's own read of the
 *  same value) ends it. Any other option is not a request. */
export function requestStructuredAgentSessionSpeed(
  state: StructuredAgentSessionOptionState,
  id: string,
  value: string
): StructuredAgentSessionOptionState {
  return isStructuredAgentSessionSpeedOption(state.record.agent, id)
    ? { ...state, requested: { id, value } }
    : state
}

/** Another connection or host is not the one the request was made to. */
export function withoutStructuredAgentSessionSpeedRequest(
  state: StructuredAgentSessionOptionState
): StructuredAgentSessionOptionState {
  const { requested: _requested, ...rest } = state
  return rest
}

/** The next-turn selection an accepted action stores. A canonical tier names itself; an accepted
 *  Fast-off is Standard without naming its id; Fast-on names no id the host resolved. */
function acceptedSpeedSelection(
  accepted: Readonly<Record<string, string>>
): AgentSessionSpeedFacts['selection'] | null {
  const tierId = accepted[CODEX_SERVICE_TIER_OPTION_ID]
  if (tierId !== undefined) {
    return { tierId, state: 'ready' }
  }
  const fastMode = accepted[LEGACY_FAST_MODE_OPTION_ID]
  if (fastMode === 'false') {
    return { state: 'unselected' }
  }
  return fastMode === 'true' ? { legacyFastMode: true, state: 'unknown' } : null
}

/** An accepted replacement answers the request. Only the next-turn selection (the request it
 *  replaced, a refusal it named included) is restated; what the host observed of earlier turns is
 *  evidence about those turns and stays until a read replaces it. Absent facts stay absent. */
export function settleStructuredAgentSessionSpeedRequest(
  state: StructuredAgentSessionOptionState,
  accepted?: Readonly<Record<string, string>>
): StructuredAgentSessionOptionState {
  const { requested, ...rest } = state
  if (!rest.speed) {
    return rest
  }
  const selection = acceptedSpeedSelection(
    accepted ?? (requested ? { [requested.id]: requested.value } : {})
  )
  const { selection: previous, ...evidence } = rest.speed
  // Nothing accepted names a selection: a blocked claim goes, any other stays.
  const blocked = previous.state === 'unavailable' || previous.state === 'unknown'
  const next = selection ?? (blocked ? { state: 'unselected' as const } : previous)
  return { ...rest, speed: { selection: next, ...evidence } }
}

/** An accepted explicit action: its values are committed, and an accepted speed replaces the
 *  request that was held for it. */
export function acknowledgeStructuredAgentSessionAction(
  state: StructuredAgentSessionOptionState,
  id: string,
  committed: Readonly<Record<string, string>>
): StructuredAgentSessionOptionState {
  const next = commitStructuredAgentSessionOptionValues(state, committed)
  return isStructuredAgentSessionSpeedOption(state.record.agent, id)
    ? settleStructuredAgentSessionSpeedRequest(next, committed)
    : next
}

/** Whether sends must stay out: a request this client made that nothing accepted has replaced, or a
 *  requested tier the host's own facts say it cannot send (a refusal this client never saw). */
export function structuredAgentSessionSpeedBlocked(
  state: Pick<StructuredAgentSessionOptionState, 'requested' | 'speed'>
): boolean {
  const selection = state.speed?.selection
  const hostNamesBlocked =
    selection !== undefined &&
    (selection.state === 'unavailable' || selection.state === 'unknown') &&
    (selection.tierId !== undefined || selection.legacyFastMode === true)
  return state.requested !== undefined || hostNamesBlocked
}

/** The picks the picker shows as the person's own, over the host's stored values and any pick a
 *  launch holds. */
export function structuredAgentSessionHeldWithRequested(
  held: Readonly<Record<string, string>>,
  state: Pick<StructuredAgentSessionOptionState, 'requested'>
): Readonly<Record<string, string>> {
  return state.requested ? { ...held, [state.requested.id]: state.requested.value } : held
}

/** The tier a read's own ready selection says the host stores: the proof a canonical read gives
 *  without naming it in `current.confirmed`, which describes the compatibility fields alone. */
export function structuredAgentSessionReadyTier(
  speed: AgentSessionSpeedFacts | undefined
): string | undefined {
  return speed?.selection.state === 'ready' ? speed.selection.tierId : undefined
}

/** The host's own read stores exactly what was requested, so nothing is left to accept. A read
 *  whose facts call the selection blocked, unverifiable or another tier never answers it. */
export function structuredAgentSessionRequestConfirmed(
  requested: StructuredAgentSessionRequestedSpeed,
  current: AgentSessionOptionsResult['current'],
  speed?: AgentSessionSpeedFacts
): boolean {
  const confirmed = (current.confirmed ?? []).includes(requested.id)
  if (requested.id === CODEX_SERVICE_TIER_OPTION_ID) {
    if (current.serviceTier !== requested.value) {
      return false
    }
    return speed ? structuredAgentSessionReadyTier(speed) === requested.value : confirmed
  }
  if (current.fastMode === undefined || String(current.fastMode) !== requested.value) {
    return false
  }
  return speed ? speed.selection.state === 'ready' : confirmed
}

/** The values an accepted explicit action settles. Hosts before the catalog tiers merge the prior
 *  stored options into every acknowledgement, so a Fast toggle comes back beside the saved
 *  canonical tier: that tier echoes what was stored and is not this action. A host that maps the
 *  toggle answers a tier alone, which is kept for its exact advertised id. */
export function acknowledgedStructuredAgentSessionOptions(
  action: { id: string; value: string },
  acknowledged: Readonly<Record<string, string>> | undefined
): Record<string, string> {
  if (!acknowledged) {
    return { [action.id]: action.value }
  }
  if (
    action.id === LEGACY_FAST_MODE_OPTION_ID &&
    acknowledged[LEGACY_FAST_MODE_OPTION_ID] !== undefined &&
    acknowledged[CODEX_SERVICE_TIER_OPTION_ID] !== undefined
  ) {
    const { [CODEX_SERVICE_TIER_OPTION_ID]: _echoedTier, ...rest } = acknowledged
    return rest
  }
  return { ...acknowledged }
}
