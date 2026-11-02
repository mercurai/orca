import { structuredLaunchRequestedOptions } from '../../native-chat/input/native-chat-session-option-defaults'
import {
  commitStructuredAgentSessionOptionValues,
  type StructuredAgentSessionOptionState
} from './structured-agent-session-options'
import {
  structuredAgentSessionOptionSnapshot,
  structuredAgentSessionDescribedModel
} from './structured-agent-session-option-snapshot'
import type { SessionOptionDescriptor } from '../../native-chat/input/native-chat-session-options'
import {
  cloneStructuredAgentSessionOptionRecord,
  createStructuredAgentSessionOptionRecord,
  structuredAgentSessionModelId,
  structuredAgentSessionOwnValue
} from './structured-agent-session-option-state'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../agent-chat-permission-mode'
import { STANDARD_SERVICE_TIER } from './structured-agent-session-effective-tier'

/** Query base or immutable launch seed, with finite controller operations above it.
 *  Display provenance stays separate from accepted input while catalog labels load. */
export function structuredAgentSessionOptionView(
  state: StructuredAgentSessionOptionState,
  seed: Readonly<Record<string, string>> | undefined,
  held: Readonly<Record<string, string>>,
  explicit?: Readonly<Record<string, string>>
): StructuredAgentSessionOptionState {
  if (state.optionsAnswerPresent) {
    seed = undefined
    explicit = undefined
  }
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
  const view = structuredAgentSessionOptionView(state, undefined, {})
  const snapshot = structuredAgentSessionOptionSnapshot(view)
  const model = structuredAgentSessionModelId(view.record, 'any')
  if (
    !model ||
    !snapshot.some(
      (descriptor) =>
        descriptor.id === 'effort' &&
        descriptor.kind.type === 'select' &&
        descriptor.kind.currentValue === undefined
    )
  ) {
    return snapshot
  }
  const described = structuredAgentSessionDescribedModel(view, model)
  const effort = described?.options.find((option) => option.id === 'effort')?.kind
  const declaration = described?.declaredDefaultEffort
  const fallback =
    declaration !== undefined
      ? declaration
      : view.record.agent === 'codex' &&
          view.verifiedModelIds?.includes(model) &&
          effort?.type === 'select' &&
          effort.defaultIsCliDefault
        ? effort.defaultValue
        : undefined
  if (
    !fallback ||
    effort?.type !== 'select' ||
    (declaration !== undefined && !effort.choices.some((choice) => choice.value === fallback))
  ) {
    return snapshot
  }
  // A declared default supplies context only; both Send paths still read the canonical snapshot.
  return snapshot.map((descriptor) =>
    descriptor.id === 'effort' &&
    descriptor.kind.type === 'select' &&
    descriptor.kind.currentValue === undefined
      ? {
          ...descriptor,
          valueSource: 'default',
          kind: { ...descriptor.kind, currentValue: fallback }
        }
      : descriptor
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
  if (!state.catalog || (!unconfirmedSeed && !hasHeld)) {
    return state
  }
  let view: StructuredAgentSessionOptionState = {
    ...state,
    record: cloneStructuredAgentSessionOptionRecord(state.record)
  }
  if (unconfirmedSeed) {
    view = commitStructuredAgentSessionOptionValues(view, seed, 'seeded')
  }
  if (state.record.agent === 'codex') {
    if (held.serviceTier !== undefined) {
      delete view.record.values.fastMode
    } else if (held.fastMode !== undefined) {
      delete view.record.values.serviceTier
    }
  }
  return commitStructuredAgentSessionOptionValues(view, held)
}

/** Sends carry own values plus held picks. New chats/older hosts pin shown defaults; resumed chats display defaults without sending them. */
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
  const model =
    structuredAgentSessionOwnValue(view.record, 'model') ??
    (view.defaultsUnsent ? undefined : shown('model'))
  const effort =
    structuredAgentSessionOwnValue(view.record, 'effort') ??
    (view.defaultsUnsent ? undefined : shown('effort'))
  if (view.record.agent === 'codex') {
    const tier = snapshot.find((descriptor) => descriptor.id === 'serviceTier')?.kind
    const serviceTier = tier?.type === 'select' ? tier.currentValue : undefined
    const legacy = snapshot.find((descriptor) => descriptor.id === 'fastMode')
    const trackedLegacy = view.record.values.fastMode
    const legacySource = legacy?.valueSource ?? trackedLegacy?.source
    const legacyValue =
      legacy?.kind.type === 'boolean' ? legacy.kind.currentValue : trackedLegacy?.value
    const legacyIntent =
      legacySource === 'applied' || legacySource === 'dispatched' || legacySource === 'reported'
    const speed: Record<string, string> | undefined =
      serviceTier !== undefined
        ? { serviceTier }
        : legacyIntent && typeof legacyValue === 'boolean'
          ? tier?.type === 'select' && !legacyValue
            ? { serviceTier: STANDARD_SERVICE_TIER }
            : { fastMode: String(legacyValue) }
          : undefined
    return model || effort || speed
      ? { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...speed }
      : undefined
  }
  return model || effort
    ? { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
    : undefined
}

/** Exact capture uses accepted origins; absent metadata keeps the older host contract. */
export function structuredAgentSessionMessageSelection(
  view: StructuredAgentSessionOptionState
): Record<string, string> {
  const selection: Record<string, string> = {}
  const snapshot = structuredAgentSessionOptionSnapshot(view)
  for (const id of ['model', 'effort', 'fastMode', 'serviceTier'] as const) {
    const descriptor = snapshot.find((entry) => entry.id === id)
    if (view.acceptedInputSources !== undefined) {
      if (!view.acceptedInputSources[id]) {
        continue
      }
    } else if (
      (id === 'model' || id === 'effort') &&
      view.defaultsUnsent &&
      descriptor?.valueSource === 'default'
    ) {
      continue
    }
    const raw =
      view.record.agent === 'pi' && (id === 'model' || id === 'effort')
        ? view.record.values[id]?.value
        : undefined
    const value =
      raw ??
      descriptor?.kind.currentValue ??
      (view.acceptedInputSources !== undefined ? view.record.values[id]?.value : undefined)
    if (value !== undefined) {
      selection[id] = String(value)
    }
  }
  return selection
}
