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
import { structuredAgentSessionOptionSnapshot } from '../../../shared/structured-agent-session-options'
import { firstFrameOptionState } from '@/components/native-chat/use-structured-agent-session-option-state'
import {
  applyStructuredLaunchHeldOptions,
  settleStructuredLaunchCreateOptions
} from './structured-agent-session-launch-options'

/** Preview options without taking ownership of the first message before authorization. */
export function prepareStructuredLaunchCreateMessage(state: StructuredLaunchState): {
  params: StructuredAgentSessionCreateParams
  commit?: () => StructuredAgentSessionCreateParams
} {
  const { intent } = state
  if (intent.createPrepared) {
    return { params: intent.params }
  }
  const options = structuredLaunchCreateOptions(state)
  const params = { ...intent.params, ...(options ? { options } : {}) }
  return {
    params,
    commit: () => {
      // A joiner may hand off the CLI source while speed authorization awaits.
      const { options: _currentOptions, ...currentFields } = intent.params
      const currentParams = {
        ...currentFields,
        ...(params.options ? { options: params.options } : {})
      }
      if (intent.createMessageSupport !== true) {
        prepareLegacyStructuredLaunchPrompts(intent.sessionId)
        return currentParams
      }
      const firstMessage = prepareStructuredLaunchPromptForCreate(intent.sessionId, intent.target)
      return { ...currentParams, ...(firstMessage ? { firstMessage } : {}) }
    }
  }
}

/** Picks held so far, and the model and effort the chat shows: a first message starts its turn
 *  on them, as a later send does. */
function structuredLaunchCreateOptions(
  state: StructuredLaunchState
): Readonly<Record<string, string>> | undefined {
  const { intent, selection } = state
  const firstFrame = firstFrameOptionState(intent.agent, intent.target, {
    newLaunch: !intent.params.resumeFrom,
    worktree: intent.params.worktree,
    seedsModel: intent.seedOptions?.model !== undefined
  })
  const view = structuredAgentSessionOptionView(firstFrame, intent.seedOptions, selection.held)
  const options = {
    ...selection.held,
    ...structuredAgentSessionSendSelection(intent.agent, structuredAgentSessionOptionSnapshot(view))
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
