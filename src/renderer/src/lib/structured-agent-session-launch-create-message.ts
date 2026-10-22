import type { StructuredAgentSessionCreateParams } from '../../../shared/structured-agent-session-create'
import type { StructuredLaunchState } from './structured-agent-session-launch-registry'
import {
  prepareStructuredLaunchPromptForCreate,
  prepareLegacyStructuredLaunchPrompts
} from './structured-agent-session-launch-prompt'
import type { StructuredAgentLaunchReceipt } from './structured-agent-session-launch-recovery'
import {
  structuredAgentSessionOptionView,
  structuredAgentSessionSendSelection
} from '../../../shared/structured-agent-session-option-view'
import { firstFrameOptionState } from '@/components/native-chat/use-structured-agent-session-option-state'
import {
  applyStructuredLaunchHeldOptions,
  holdStructuredLaunchCreatePicks,
  settleStructuredLaunchCreateOptions
} from './structured-agent-session-launch-options'

/** Preview options without taking ownership of the first message before authorization. */
export function prepareStructuredLaunchCreateMessage(
  state: StructuredLaunchState,
  createMessageSupport: boolean
): {
  params: StructuredAgentSessionCreateParams
  commit?: () => StructuredAgentSessionCreateParams
} {
  const { intent } = state
  if (intent.createPrepared) {
    return { params: intent.params }
  }
  const heldPicks = { ...state.selection.held }
  const options = structuredLaunchCreateOptions(state, createMessageSupport)
  const params = { ...intent.params, ...(options ? { options } : {}) }
  return {
    params,
    commit: () => {
      holdStructuredLaunchCreatePicks(state, heldPicks)
      // A joiner may hand off the CLI source while speed authorization awaits.
      const { options: _currentOptions, ...currentFields } = intent.params
      const currentParams = {
        ...currentFields,
        ...(params.options ? { options: params.options } : {})
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

/** Picks held so far, and the chat's own model and effort: a first message starts its turn on
 *  them, as a later send does. */
function structuredLaunchCreateOptions(
  state: StructuredLaunchState,
  createMessageSupport: boolean
): Readonly<Record<string, string>> | undefined {
  const { intent, selection } = state
  const firstFrame = firstFrameOptionState(intent.agent, intent.target, {
    newLaunch: !intent.params.resumeFrom,
    worktree: intent.params.worktree,
    seedsModel: intent.seedOptions?.model !== undefined
  })
  const view = structuredAgentSessionOptionView(firstFrame, intent.seedOptions, selection.held)
  const {
    model: seededModel,
    effort: seededEffort,
    permissionMode: seededPermission,
    ...independentSeed
  } = intent.seedOptions ?? {}
  // Legacy create needs the seeded permission; modern create carries an explicit held
  // permission only. Speed/personality intent survives an unlisted remembered model.
  // A paired host supplied its own seed during admission. Explicit Codex speed keeps
  // its model too, so an unknown tier is refused under that model, never paid elsewhere.
  const keepsSeedModel =
    intent.target.kind !== 'local' ||
    (intent.agent === 'codex' &&
      (independentSeed.serviceTier !== undefined || independentSeed.fastMode !== undefined))
  const options = {
    ...independentSeed,
    ...(keepsSeedModel && seededModel !== undefined ? { model: seededModel } : {}),
    ...(keepsSeedModel && seededEffort !== undefined ? { effort: seededEffort } : {}),
    ...(!createMessageSupport && seededPermission !== undefined
      ? { permissionMode: seededPermission }
      : {}),
    ...selection.held,
    ...structuredAgentSessionSendSelection(view)
  }
  return Object.keys(options).length ? options : undefined
}

/** Later picks use the normal option path without holding publication behind startup. */
export function publishStructuredLaunchCreateOptions(
  state: StructuredLaunchState,
  receipt: StructuredAgentLaunchReceipt
): StructuredAgentLaunchReceipt | Promise<StructuredAgentLaunchReceipt> {
  if (state.intent.createMessageSupport !== true) {
    return applyStructuredLaunchHeldOptions(state, receipt)
  }
  settleStructuredLaunchCreateOptions(state, state.intent.createCanonicalOptions ?? {})
  void applyStructuredLaunchHeldOptions(state, receipt).catch((error: unknown) => {
    console.warn('[native-chat] applying a launch option failed', error)
  })
  return receipt
}
