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
  const heldPicks = { ...state.selection.held }
  const explicit = hostTakesExplicitOptions
    ? state.selection.explicit
    : compatibleExplicitLaunchOptions(state.selection.explicit)
  const optionsMode: StructuredAgentSessionCreateParams['optionsMode'] =
    hostTakesExplicitOptions && explicit?.model !== undefined
      ? 'replace-model-selection'
      : undefined
  const requested =
    createMessageSupport || !intent.explicitLaunchOptions
      ? structuredLaunchCreateOptions(state, createMessageSupport, explicit)
      : undefined
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
      holdStructuredLaunchCreatePicks(state, heldPicks)
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
      return { ...currentParams, ...(firstMessage ? { firstMessage } : {}) }
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
): Readonly<Record<string, string>> | undefined {
  const { intent } = state
  const selection = { ...state.selection, explicit }
  const requested = structuredLaunchRequestedOptions(selection)
  const firstFrame = firstFrameOptionState(intent.agent, intent.target, {
    newLaunch: !intent.params.resumeFrom,
    worktree: intent.params.worktree,
    seedsModel: intent.seedOptions?.model !== undefined
  })
  const view = structuredAgentSessionOptionView(
    firstFrame,
    intent.seedOptions,
    selection.held,
    explicit
  )
  const drawn = structuredAgentSessionDrawnValues(view)
  const held = Object.fromEntries(
    Object.entries(selection.held).map(([id, encoded]) => {
      // Speed intent must reach admission unchanged; drawing a fallback cannot authorize it.
      const exact =
        id === 'model' || (intent.agent === 'codex' && (id === 'serviceTier' || id === 'fastMode'))
      const value = exact ? undefined : drawn[id]?.value
      const shown = value === undefined ? null : encodeStructuredAgentSessionOptionValue(id, value)
      return [id, shown ?? encoded]
    })
  )
  if (requested?.model !== undefined) {
    return requested.model === selection.held.model ? { ...requested, ...held } : requested
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
  const options = {
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
  }
  return Object.keys(options).length ? options : undefined
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
  void applyStructuredLaunchHeldOptions(state, receipt).catch((error: unknown) => {
    console.warn('[native-chat] applying a launch option failed', error)
  })
  return receipt
}
