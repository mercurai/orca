import { recoverStructuredLaunchDrafts } from './structured-agent-session-launch-draft-recovery'
import { recoverPublishedSessionReceipt } from './structured-agent-session-launch-recovery'
import { settleStructuredLaunchCreateOptions } from './structured-agent-session-launch-options'
import { trackLaunchSettlement } from './structured-agent-session-launch-outcome-tracking'
import { trackStructuredLaunchConfirmationDeadline } from './structured-agent-session-launch-prompt-outcome'
import { restorePersistedStructuredLaunchState } from './structured-agent-session-launch-reload'
import {
  getStructuredLaunchStateBySessionId,
  notifyStructuredLaunchListeners
} from './structured-agent-session-launch-registry'

/** Publication proves existence; held intent and the opening receipt still need their own proof. */
export function confirmStructuredLaunchPublication(worktreeId: string, sessionId: string): void {
  const state =
    getStructuredLaunchStateBySessionId(sessionId) ??
    restorePersistedStructuredLaunchState(worktreeId, sessionId)
  if (!state || state.callers.outcome === 'pending' || state.cancelled) {
    return
  }
  const hasHeldOptions = Object.keys(state.selection.held).length > 0
  if (
    !state.intent.params.firstMessage &&
    (state.heldPromptDrafts?.length || state.draftRecovery || hasHeldOptions)
  ) {
    void recoverStructuredLaunchDrafts(state)
    return
  }
  state.callers.outcome = 'pending'
  state.visibilityUnknown = false
  state.promise = recoverStructuredLaunchDrafts(state)
    .then((recovered) => {
      if (!recovered) {
        throw new Error('Unsent message recovery needs durable storage')
      }
      return recoverPublishedSessionReceipt(state, { replayMissingMessage: false })
    })
    .then((receipt) => {
      settleStructuredLaunchCreateOptions(state, state.intent.createCanonicalOptions ?? {})
      return receipt
    })
    .catch((error: unknown) => {
      state.visibilityUnknown = true
      throw error
    })
  trackLaunchSettlement(state, state.promise)
  trackStructuredLaunchConfirmationDeadline(state, state.promise)
  notifyStructuredLaunchListeners()
}
