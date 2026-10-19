import type { ExecutionHostId } from '../../../shared/execution-host'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { deleteStructuredAgentLaunchRecord } from './structured-agent-session-launch-persistence'
import {
  getPersistedStructuredAgentLaunchRecord,
  getStructuredLaunchStateBySessionId,
  hasStructuredAgentSessionLaunchCancellationTombstone,
  notifyStructuredLaunchListeners
} from './structured-agent-session-launch-registry'

function confirmStructuredLaunchPublication(
  worktreeId: string,
  sessionId: string
): void {
  // Store teardown imports publication bookkeeping; recovery may read the store after it exists.
  void import('./structured-agent-session-launch-publication-confirmation')
    .then((confirmation) =>
      confirmation.confirmStructuredLaunchPublication(worktreeId, sessionId)
    )
    .catch((error: unknown) => {
      console.warn('[native-chat] confirming a published opening message failed', error)
    })
}

/** `executionHostId` published the chat; only the host its launch was sent to settles it. */
export function markStructuredAgentSessionLaunchPublished(
  worktreeId: string,
  sessionId: string,
  executionHostId: ExecutionHostId
): boolean {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  if (!state) {
    const persisted = getPersistedStructuredAgentLaunchRecord(sessionId)
    if (persisted?.executionHostId !== executionHostId) {
      return false
    }
    if (persisted.firstMessage || persisted.heldPromptDrafts?.length ||
        Object.keys(persisted.heldOptions ?? {}).length > 0) {
      confirmStructuredLaunchPublication(worktreeId, sessionId)
      return false
    }
    deleteStructuredAgentLaunchRecord(sessionId)
    notifyStructuredLaunchListeners()
    return true
  }
  if (
    state.intent.worktreeId !== worktreeId ||
    state.cancelled ||
    state.intent.executionHostId !== executionHostId
  ) {
    return false
  }
  if (state.callers.outcome === 'published') {
    return true
  }
  if (state.heldPromptDrafts?.length || state.draftRecovery ||
      Object.keys(state.selection.held).length > 0) {
    confirmStructuredLaunchPublication(worktreeId, sessionId)
    return false
  }
  // Still in flight: its own settlement publishes once the picks held during launch land.
  if (state.callers.outcome === 'pending') {
    return true
  }
  if (state.intent.params.firstMessage) {
    confirmStructuredLaunchPublication(worktreeId, sessionId)
    return false
  }
  state.callers.outcome = 'published'
  deleteStructuredAgentLaunchRecord(sessionId)
  state.callers.onSettled()
  notifyStructuredLaunchListeners()
  return true
}

/** Settles every launch a host's publication shows, from whichever mirror carried it. */
export function markStructuredAgentSessionLaunchesPublished(
  executionHostId: ExecutionHostId,
  published: Iterable<{ worktreeId: string; sessionId: string }>
): void {
  for (const { worktreeId, sessionId } of published) {
    if (!hasStructuredAgentSessionLaunchCancellationTombstone(worktreeId, sessionId)) {
      markStructuredAgentSessionLaunchPublished(worktreeId, sessionId, executionHostId)
    }
  }
}

/** The structured chats a host's snapshots show, keyed as launch bookkeeping reads them. */
export function publishedStructuredSessions(
  snapshots: readonly RuntimeMobileSessionTabsResult[]
): { worktreeId: string; sessionId: string }[] {
  return snapshots.flatMap((snapshot) =>
    snapshot.tabs.flatMap((tab) =>
      tab.type === 'agent-session'
        ? [{ worktreeId: snapshot.worktree, sessionId: tab.sessionId }]
        : []
    )
  )
}
