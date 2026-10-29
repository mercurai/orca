import { structuredLaunchRequestedOptions } from './native-chat/input/native-chat-session-option-defaults'
import {
  commitStructuredAgentSessionOptionValues,
  structuredAgentSessionOptionSnapshot,
  type StructuredAgentSessionOptionState
} from './structured-agent-session-options'
import type { SessionOptionDescriptor } from './native-chat/input/native-chat-session-options'
import {
  cloneStructuredAgentSessionOptionRecord,
  createStructuredAgentSessionOptionRecord,
  structuredAgentSessionModelId,
  structuredAgentSessionOwnValue
} from './structured-agent-session-option-state'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from './agent-chat-permission-mode'

/** Derive held picks, host values and launch seeds without mutating the record; retain unlisted models.
 * Permission mode uses held, host, explicit launch mode, then seed. */
export function structuredAgentSessionOptionView(
  state: StructuredAgentSessionOptionState,
  seed: Readonly<Record<string, string>> | undefined,
  held: Readonly<Record<string, string>>,
  explicit?: Readonly<Record<string, string>>
): StructuredAgentSessionOptionState {
  const requested = structuredLaunchRequestedOptions({ explicit, seed, held })
  // Only a requested model replaces the shown selection; a permission mode alone overlays it.
  if (requested?.model !== undefined) {
    return commitStructuredAgentSessionOptionValues(
      { ...state, record: createStructuredAgentSessionOptionRecord(state.record.agent) },
      requested
    )
  }
  const heldPermission = held[AGENT_CHAT_PERMISSION_MODE_OPTION_ID]
  const heldSelection: Record<string, string> = { ...held }
  delete heldSelection[AGENT_CHAT_PERMISSION_MODE_OPTION_ID]
  if (state.record.agent === 'codex') {
    if (requested?.serviceTier !== undefined) {
      heldSelection.serviceTier = requested.serviceTier
      delete heldSelection.fastMode
    } else if (requested?.fastMode !== undefined) {
      heldSelection.fastMode = requested.fastMode
      delete heldSelection.serviceTier
    }
  }
  const view = modelOptionView(state, seed, heldSelection)
  const permissionMode =
    heldPermission ??
    state.permissionMode ??
    requested?.[AGENT_CHAT_PERMISSION_MODE_OPTION_ID] ??
    seed?.[AGENT_CHAT_PERMISSION_MODE_OPTION_ID] ??
    null
  return view.permissionMode === permissionMode ? view : { ...view, permissionMode }
}

export function structuredAgentSessionShownSnapshot(
  state: StructuredAgentSessionOptionState
): SessionOptionDescriptor[] {
  return structuredAgentSessionOptionSnapshot(
    structuredAgentSessionOptionView(state, undefined, {})
  )
}

function modelOptionView(
  state: StructuredAgentSessionOptionState,
  seed: Readonly<Record<string, string>> | undefined,
  held: Readonly<Record<string, string>>
): StructuredAgentSessionOptionState {
  const unconfirmedSeed =
    seed !== undefined && structuredAgentSessionModelId(state.record, 'own') === null
  const hasHeld = Object.keys(held).length > 0
  const bindsCodexSpeed =
    state.record.agent === 'codex' &&
    seed?.model !== undefined &&
    held.model === undefined &&
    (held.serviceTier !== undefined || held.fastMode !== undefined)
  const seeded =
    unconfirmedSeed &&
    (bindsCodexSpeed || state.catalogSource === 'host' || state.catalogSource === 'live') &&
    (held.model === undefined || held.model === seed.model)
  if (!state.catalog || (!seeded && !hasHeld)) {
    return state
  }
  let view: StructuredAgentSessionOptionState = {
    ...state,
    record: cloneStructuredAgentSessionOptionRecord(state.record)
  }
  if (seeded) {
    view = commitStructuredAgentSessionOptionValues(view, seed)
  }
  if (state.record.agent === 'codex') {
    if (held.serviceTier !== undefined) {
      delete view.record.values.fastMode
    } else if (held.fastMode !== undefined) {
      delete view.record.values.serviceTier
    }
  }
  return { ...commitStructuredAgentSessionOptionValues(view, held), pendingId: state.pendingId }
}

/** Claude sends its own values plus held picks. New chats/older hosts pin shown defaults on first send; resumed chats display defaults without sending them. */
export function structuredAgentSessionSendSelection(
  view: StructuredAgentSessionOptionState
): Record<string, string> | undefined {
  if (view.record.agent !== 'claude' && view.record.agent !== 'codex') {
    return undefined
  }
  const snapshot =
    view.record.agent === 'codex' ||
    (view.catalog?.defaultModelIsCliDefault === true && !view.defaultsUnsent)
      ? structuredAgentSessionOptionSnapshot(view)
      : []
  const shown = (id: string): string | undefined => {
    const kind = snapshot.find((descriptor) => descriptor.id === id)?.kind
    return kind?.type === 'select' ? kind.currentValue : undefined
  }
  const model = structuredAgentSessionOwnValue(view.record, 'model') ?? shown('model')
  const effort = structuredAgentSessionOwnValue(view.record, 'effort') ?? shown('effort')
  if (view.record.agent === 'codex') {
    const serviceTier = shown('serviceTier')
    const legacy = snapshot.find((descriptor) => descriptor.id === 'fastMode')
    const legacyIntent =
      legacy?.valueSource === 'applied' ||
      legacy?.valueSource === 'dispatched' ||
      legacy?.valueSource === 'reported'
    const speed: Record<string, string> | undefined =
      serviceTier !== undefined
        ? { serviceTier }
        : legacyIntent && legacy?.kind.type === 'boolean'
          ? { fastMode: String(legacy.kind.currentValue) }
          : undefined
    return speed
      ? { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...speed }
      : undefined
  }
  return model || effort
    ? { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
    : undefined
}
