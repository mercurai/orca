import {
  structuredLaunchCompatibleOptions,
  structuredLaunchRequestedOptions
} from '../../../shared/native-chat/input/native-chat-session-option-defaults'
import type { StructuredAgentSessionCreateParams } from '../../../shared/structured-agent-session-create'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../shared/agent-chat-permission-mode'
import type { StructuredLaunchState } from './agent-session/launch/structured-agent-session-launch-registry'
import {
  prepareStructuredLaunchPromptForCreate,
  prepareLegacyStructuredLaunchPrompts
} from './structured-agent-session-launch-prompt'
import type { StructuredAgentLaunchReceipt } from './agent-session/launch/structured-agent-session-launch-recovery'
import {
  structuredAgentSessionMessageSelection,
  structuredAgentSessionOptionView,
  structuredAgentSessionSendSelection
} from '../../../shared/structured-agent-session-option-view'
import { structuredAgentSessionDrawnValues } from '../../../shared/structured-agent-session-option-snapshot'
import { encodeStructuredAgentSessionOptionValue } from '../../../shared/structured-agent-session-option-codec'
import { firstFrameOptionState } from '@/components/native-chat/use-structured-agent-session-option-state'
import {
  applyStructuredLaunchHeldOptions,
  applyStructuredLaunchExplicitOptions,
  holdStructuredLaunchCreatePicks,
  previewStructuredLaunchCreatePicks,
  structuredLaunchOptionOverlay,
  settleStructuredLaunchCreateOptions
} from './structured-agent-session-launch-options'

/** Preview negotiated options; claim the first message only after speed authorization. */
export function prepareStructuredLaunchCreateMessage(
  state: StructuredLaunchState,
  createMessageSupport: boolean,
  hostTakesExplicitOptions = false
): {
  params: StructuredAgentSessionCreateParams
  commit?: () => StructuredAgentSessionCreateParams
} {
  const { intent } = state
  if (intent.createPrepared) {
    return { params: intent.params }
  }
  const previewed = previewStructuredLaunchCreatePicks(state)
  const explicit = hostTakesExplicitOptions
    ? state.selection.explicit
    : compatibleExplicitLaunchOptions(state.selection.explicit)
  const optionsMode: StructuredAgentSessionCreateParams['optionsMode'] =
    hostTakesExplicitOptions && explicit?.model !== undefined
      ? 'replace-model-selection'
      : undefined
  const { options: requested, selection } =
    createMessageSupport || !intent.explicitLaunchOptions
      ? structuredLaunchCreateOptions(state, createMessageSupport, explicit)
      : {}
  const options =
    requested && explicit && !optionsMode
      ? structuredLaunchCompatibleOptions(intent.agent, requested)
      : requested
  const params = {
    ...intent.params,
    ...(options ? { options } : {}),
    ...(optionsMode ? { optionsMode } : {})
  }
  return {
    params,
    commit: () => {
      // A legacy create is followed by setOption for every pick, so only a modern one freezes them.
      if (createMessageSupport) {
        holdStructuredLaunchCreatePicks(state, previewed)
      }
      if (!hostTakesExplicitOptions) {
        intent.explicitLaunchOptions = explicit
        state.selection = { ...state.selection, explicit }
      }
      // A joiner may hand off the CLI source while speed authorization awaits.
      const {
        options: _currentOptions,
        optionsMode: _currentMode,
        ...currentFields
      } = intent.params
      const currentParams = {
        ...currentFields,
        ...(params.options ? { options: params.options } : {}),
        ...(params.optionsMode ? { optionsMode: params.optionsMode } : {})
      }
      if (!createMessageSupport) {
        prepareLegacyStructuredLaunchPrompts(intent.sessionId)
        return currentParams
      }
      const firstMessage = prepareStructuredLaunchPromptForCreate(intent.sessionId, intent.target)
      return {
        ...currentParams,
        ...(firstMessage
          ? { firstMessage: { ...firstMessage, ...(selection !== undefined ? { selection } : {}) } }
          : {})
      }
    }
  }
}

/** Older hosts retain their own new-chat permission default. */
function compatibleExplicitLaunchOptions(
  explicit: Readonly<Record<string, string>> | undefined
): Readonly<Record<string, string>> | undefined {
  if (explicit?.[AGENT_CHAT_PERMISSION_MODE_OPTION_ID] === undefined) {
    return explicit
  }
  const { [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: _omitted, ...rest } = explicit
  return Object.keys(rest).length ? rest : undefined
}

/** The first turn uses held picks over the action's choices over the chat's shown selection. */
function structuredLaunchCreateOptions(
  state: StructuredLaunchState,
  createMessageSupport: boolean,
  explicit: Readonly<Record<string, string>> | undefined
): {
  options?: Readonly<Record<string, string>>
  selection?: Readonly<Record<string, string>>
} {
  const { intent } = state
  const overlay = structuredLaunchOptionOverlay(state)
  const requested = structuredLaunchRequestedOptions({ explicit, held: overlay })
  const firstFrame = firstFrameOptionState(intent.agent, intent.target, {
    newLaunch: !intent.params.resumeFrom,
    worktree: intent.params.worktree,
    seedsModel: intent.seedOptions?.model !== undefined
  })
  const view = structuredAgentSessionOptionView(
    firstFrame,
    intent.seedOptions,
    { ...requested, ...overlay },
    explicit
  )
  const drawn = structuredAgentSessionDrawnValues(view)
  const held = Object.fromEntries(
    Object.entries(overlay).map(([id, encoded]) => {
      // Model and effort remain raw action input. Speed intent must reach admission unchanged;
      // drawing a fallback cannot authorize it.
      const exact =
        id === 'model' ||
        id === 'effort' ||
        (intent.agent === 'codex' && (id === 'serviceTier' || id === 'fastMode'))
      const value = exact ? undefined : drawn[id]?.value
      const shown = value === undefined ? null : encodeStructuredAgentSessionOptionValue(id, value)
      return [id, shown ?? encoded]
    })
  )
  const selection = intent.sendSelectionSupport
    ? structuredAgentSessionMessageSelection(view)
    : undefined
  const result = (options: Readonly<Record<string, string>>) => ({
    ...(Object.keys(options).length ? { options } : {}),
    ...(selection !== undefined ? { selection } : {})
  })
  if (requested?.model !== undefined) {
    return result(requested.model === overlay.model ? { ...requested, ...held } : requested)
  }
  const {
    model: seededModel,
    effort: seededEffort,
    permissionMode: seededPermission,
    serviceTier: seededTier,
    fastMode: seededFast,
    ...independentSeed
  } = intent.seedOptions ?? {}
  const sent = structuredAgentSessionSendSelection(view)
  const { serviceTier: _drawnTier, fastMode: _drawnFast, ...nonSpeed } = sent ?? {}
  const speedPicks = requested ?? held
  const speed =
    speedPicks.serviceTier !== undefined
      ? { serviceTier: speedPicks.serviceTier }
      : speedPicks.fastMode !== undefined
        ? { fastMode: speedPicks.fastMode }
        : seededTier !== undefined
          ? { serviceTier: seededTier }
          : seededFast !== undefined
            ? { fastMode: seededFast }
            : {}
  const keepsSeedModel =
    intent.target.kind !== 'local' || (intent.agent === 'codex' && Object.keys(speed).length > 0)
  return result({
    ...independentSeed,
    ...(intent.agent !== 'codex' && seededTier !== undefined ? { serviceTier: seededTier } : {}),
    ...(intent.agent !== 'codex' && seededFast !== undefined ? { fastMode: seededFast } : {}),
    ...(keepsSeedModel && seededModel !== undefined ? { model: seededModel } : {}),
    ...(keepsSeedModel && seededEffort !== undefined ? { effort: seededEffort } : {}),
    ...(!createMessageSupport && seededPermission !== undefined
      ? { permissionMode: seededPermission }
      : {}),
    ...(intent.agent === 'codex' ? nonSpeed : sent),
    ...requested,
    ...held,
    ...(intent.agent === 'codex' ? speed : {})
  })
}

/** Later picks use the normal option path without holding publication behind startup. */
export function publishStructuredLaunchCreateOptions(
  state: StructuredLaunchState,
  receipt: StructuredAgentLaunchReceipt
): StructuredAgentLaunchReceipt | Promise<StructuredAgentLaunchReceipt> {
  if (state.intent.createMessageSupport !== true) {
    return applyStructuredLaunchExplicitOptions(state, receipt)
  }
  settleStructuredLaunchCreateOptions(state, state.intent.createCanonicalOptions ?? {})
  void applyStructuredLaunchHeldOptions(state, receipt, false).catch((error: unknown) => {
    console.warn('[native-chat] applying a launch option failed', error)
  })
  return receipt
}
