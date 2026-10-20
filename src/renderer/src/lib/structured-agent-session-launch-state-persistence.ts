import { captureStructuredLaunchPromptDrafts } from './structured-agent-session-launch-prompt'
import {
  deleteStructuredAgentLaunchRecord,
  structuredAgentLaunchRecordFor,
  writeStructuredAgentLaunchRecord
} from './structured-agent-session-launch-persistence'
import type {
  StructuredAgentSessionLaunchLifecycle,
  StructuredLaunchState
} from './structured-agent-session-launch-registry'

/** Host publication cannot retire settings or unsent text still owned by the launch. */
export function persistStructuredLaunchState(
  state: StructuredLaunchState,
  lifecycle: StructuredAgentSessionLaunchLifecycle
): void {
  const heldOptions = state.selection.held
  const hasHeld = Object.keys(heldOptions).length > 0
  const heldPromptDrafts =
    state.heldPromptDrafts ??
    (hasHeld ? captureStructuredLaunchPromptDrafts(state.intent.sessionId) : [])
  if (
    lifecycle === 'cancelled' ||
    (lifecycle === 'published' && !hasHeld && !heldPromptDrafts.length)
  ) {
    deleteStructuredAgentLaunchRecord(state.intent.sessionId)
    return
  }
  writeStructuredAgentLaunchRecord({
    ...structuredAgentLaunchRecordFor(
      state.intent,
      lifecycle === 'published' ? 'visibility-unknown' : lifecycle,
      {
        ...(hasHeld ? { heldOptions } : {}),
        ...(heldPromptDrafts.length ? { heldPromptDrafts } : {})
      }
    ),
    ...(lifecycle === 'failed' ? { failedAt: state.callers.failedAt } : {})
  })
}
