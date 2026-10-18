import { translate } from '@/i18n/i18n'
import {
  getStructuredAgentSessionSendNotice,
  publishStructuredAgentSessionSends,
  setStructuredAgentSessionSendNotice
} from '@/components/native-chat/structured-agent-session-pending-sends'
import { recoverStructuredLaunchPromptDrafts } from './structured-agent-session-launch-prompt-recovery'
import {
  getStructuredLaunchStateBySessionId,
  notifyStructuredLaunchListeners,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'

/** Recovery shares one transaction and retains its source until storage confirms ownership. */
export function recoverStructuredLaunchDrafts(state: StructuredLaunchState): Promise<boolean> {
  if (state.draftRecovery) {
    return state.draftRecovery
  }
  const drafts = state.heldPromptDrafts
  if (!drafts?.length) {
    return Promise.resolve(true)
  }
  state.visibilityUnknown = true
  const notice = translate(
    'components.native-chat.composer.speedStatus.recoveryStorage',
    'Could not restore the unsent message. Free storage and retry; its saved recovery copy is retained.'
  )
  const recovery = recoverStructuredLaunchPromptDrafts(state.intent.sessionId, drafts)
    .catch(() => false)
    .then((committed) => {
      if (state.cancelled || getStructuredLaunchStateBySessionId(state.intent.sessionId) !== state) {
        return false
      }
      if (!committed) {
        setStructuredAgentSessionSendNotice(state.intent.sessionId, notice)
        return false
      }
      if (state.heldPromptDrafts !== drafts) {
        return false
      }
      delete state.heldPromptDrafts
      if (getStructuredAgentSessionSendNotice(state.intent.sessionId) === notice) {
        publishStructuredAgentSessionSends(state.intent.sessionId, { notice: null })
      }
      notifyStructuredLaunchListeners()
      return true
    })
    .finally(() => {
      if (state.draftRecovery === recovery) {
        delete state.draftRecovery
      }
    })
  state.draftRecovery = recovery
  return recovery
}

/** Retry cannot replace the launch identity until unsent text has durable ownership. */
export async function requireStructuredLaunchDraftRecovery(state: StructuredLaunchState): Promise<void> {
  if (!(await recoverStructuredLaunchDrafts(state))) {
    throw new Error('Unsent message recovery needs durable storage')
  }
  if (state.cancelled) {
    throw new Error('Launch cancelled during message recovery')
  }
}
