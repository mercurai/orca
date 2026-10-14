import { useSyncExternalStore } from 'react'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { StructuredLaunchFailure } from './structured-agent-session-launch-failure'
import type { StructuredAgentSessionResumeSource } from '../../../shared/structured-agent-session-create'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { StructuredLaunchRecoveryState } from './structured-agent-session-launch-recovery'
import type { StructuredLaunchSelection } from './structured-agent-session-launch-options'
import type { StructuredLaunchSpeedBlock } from './structured-agent-session-launch-errors'
import { structuredAgentLaunchSpeedRecord } from './structured-agent-session-launch-speed-record'
import type {
  StructuredAgentLaunchOptions,
  StructuredLaunchCallerGroup
} from './structured-agent-session-launch-callers'
import {
  deleteStructuredAgentLaunchRecord,
  hasStructuredAgentLaunchCancellationTombstonePersisted,
  readStructuredAgentLaunchRecord,
  structuredAgentLaunchRecordFor,
  writeStructuredAgentLaunchRecord,
  type StructuredAgentLaunchPersistedRecord
} from './structured-agent-session-launch-persistence'
import {
  markStructuredAgentLaunchCancellation,
  resetStructuredAgentLaunchCancellationForTests,
  retireAbsentStructuredAgentLaunchCancellations,
  retireStructuredAgentLaunchCancellation
} from './structured-agent-session-launch-cancellation'

export type StructuredLaunchState = StructuredLaunchRecoveryState & {
  identity: string
  /** Fixed by the caller that opened this launch so coalesced prompts use one delivery mode. */
  promptDelivery: StructuredAgentLaunchOptions['promptDelivery']
  callers: StructuredLaunchCallerGroup
  /** The host's refusal behind the last failed attempt, worded beside Retry. Absent when the
   *  failure named none. */
  failure?: StructuredLaunchFailure
  selection: StructuredLaunchSelection
  /** Why the chosen speed holds this launch back; absent when nothing does. The launch stays
   *  unpublished, and its first prompt unsent, until an accepted replacement or a supporting host
   *  clears it: a wake or a restart alone never does. */
  speedBlock?: StructuredLaunchSpeedBlock
  /** Wakes the pass parked on `speedBlock`; set only while it is parked. */
  releaseSpeedBlock?: () => void
  /** Set when the last look found nothing held: a pick after it goes through the session instead of
   *  being held for a pass that has already ended. */
  picksClosed?: true
  /** A recheck that arrived while the host was being asked, which that answer does not cover. */
  speedRecheckRequested?: true
}

export type StructuredAgentLaunchStatus = 'idle' | 'pending' | 'unknown'
export type StructuredAgentSessionLaunchLifecycle =
  | 'pending'
  | 'visibility-unknown'
  | 'failed'
  | 'published'
  | 'cancelled'

const structuredLaunchesBySessionId = new Map<string, StructuredLaunchState>()
const structuredLaunchListeners = new Set<() => void>()

export function resetStructuredAgentLaunchRegistryForTests(): void {
  structuredLaunchesBySessionId.clear()
  structuredLaunchListeners.clear()
  resetStructuredAgentLaunchCancellationForTests()
}

export function notifyStructuredLaunchListeners(): void {
  for (const state of structuredLaunchesBySessionId.values()) {
    persistStructuredLaunchState(state)
  }
  for (const listener of structuredLaunchListeners) {
    listener()
  }
}

export function subscribeStructuredAgentLaunchStatus(listener: () => void): () => void {
  structuredLaunchListeners.add(listener)
  return () => structuredLaunchListeners.delete(listener)
}

// Why keyed by agent: one worktree can hold a Claude and a Codex launch at once.
// Why keyed by conversation: a resume must not coalesce onto an unrelated blank launch.
export function structuredLaunchIdentity(
  worktreeId: string,
  agent: TuiAgent,
  resumeFrom?: StructuredAgentSessionResumeSource
): string {
  return resumeFrom
    ? `${agent}:${worktreeId}:resume:${resumeFrom.providerSessionId}`
    : `${agent}:${worktreeId}`
}

export function getStructuredLaunchStateBySessionId(
  sessionId: string
): StructuredLaunchState | undefined {
  return structuredLaunchesBySessionId.get(sessionId)
}

export function setStructuredLaunchState(state: StructuredLaunchState): void {
  structuredLaunchesBySessionId.set(state.intent.sessionId, state)
  persistStructuredLaunchState(state)
}

export function deleteStructuredLaunchStateIfCurrent(state: StructuredLaunchState): boolean {
  if (structuredLaunchesBySessionId.get(state.intent.sessionId) !== state) {
    return false
  }
  structuredLaunchesBySessionId.delete(state.intent.sessionId)
  deleteStructuredAgentLaunchRecord(state.intent.sessionId)
  return true
}

function persistStructuredLaunchState(state: StructuredLaunchState): void {
  const lifecycle = launchStateLifecycle(state)
  if (lifecycle === 'published' || lifecycle === 'cancelled') {
    deleteStructuredAgentLaunchRecord(state.intent.sessionId)
    return
  }
  const { held, seed } = state.selection
  const speed = structuredAgentLaunchSpeedRecord(
    state.receipt,
    held.serviceTier,
    state.speedBlock,
    { accepted: seed, heldFastMode: held.fastMode }
  )
  writeStructuredAgentLaunchRecord({
    ...structuredAgentLaunchRecordFor(state.intent, lifecycle),
    ...(lifecycle === 'failed' ? { failedAt: state.callers.failedAt } : {}),
    ...(speed ? { speed } : {})
  })
}

export function getPersistedStructuredAgentLaunchRecord(
  sessionId: string
): StructuredAgentLaunchPersistedRecord | undefined {
  return readStructuredAgentLaunchRecord(sessionId)
}

export function structuredLaunchStates(): IterableIterator<StructuredLaunchState> {
  return structuredLaunchesBySessionId.values()
}

export function launchStateLifecycle(
  state: StructuredLaunchState
): StructuredAgentSessionLaunchLifecycle {
  if (state.cancelled || state.callers.outcome === 'cancelled') {
    return 'cancelled'
  }
  if (state.callers.outcome === 'published') {
    return 'published'
  }
  if (state.visibilityUnknown || state.callers.outcome === 'unknown') {
    return 'visibility-unknown'
  }
  return state.callers.outcome === 'failed' ? 'failed' : 'pending'
}

function matchesLaunchWorktree(
  state: StructuredLaunchState | undefined,
  worktreeId: string
): boolean {
  return state?.intent.worktreeId === worktreeId
}

export function getStructuredAgentSessionLaunchLifecycle(
  worktreeId: string,
  sessionId: string
): StructuredAgentSessionLaunchLifecycle | null {
  if (hasStructuredAgentSessionLaunchCancellationTombstone(worktreeId, sessionId)) {
    return 'cancelled'
  }
  const state = getStructuredLaunchStateBySessionId(sessionId)
  if (state && matchesLaunchWorktree(state, worktreeId)) {
    return launchStateLifecycle(state)
  }
  return getPersistedStructuredAgentLaunchRecord(sessionId)?.lifecycle ?? null
}

/** The host a launch still owed an outcome was sent to, in memory or persisted across a reload. */
export function getStructuredAgentSessionLaunchOwner(
  sessionId: string
): ExecutionHostId | undefined {
  return (
    getStructuredLaunchStateBySessionId(sessionId)?.intent.executionHostId ??
    getPersistedStructuredAgentLaunchRecord(sessionId)?.executionHostId
  )
}

/** The launch adopts an existing conversation, which may keep a model of its own. */
export function getStructuredAgentSessionLaunchResumes(sessionId: string): boolean {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  const resumeFrom = state
    ? state.intent.params.resumeFrom
    : getPersistedStructuredAgentLaunchRecord(sessionId)?.resumeFrom
  return resumeFrom !== undefined
}

export function getStructuredAgentSessionLaunchFailure(
  worktreeId: string,
  sessionId: string
): StructuredLaunchFailure | null {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  return state &&
    matchesLaunchWorktree(state, worktreeId) &&
    launchStateLifecycle(state) === 'failed'
    ? (state.failure ?? null)
    : null
}

/** Why the launch's chosen speed holds it back, in memory or as saved across a reload. */
export function getStructuredAgentSessionLaunchSpeedBlock(
  worktreeId: string,
  sessionId: string
): StructuredLaunchSpeedBlock | null {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  if (state) {
    return matchesLaunchWorktree(state, worktreeId) ? (state.speedBlock ?? null) : null
  }
  return getPersistedStructuredAgentLaunchRecord(sessionId)?.speed?.block ?? null
}

export function useStructuredAgentSessionLaunchSpeedBlock(
  worktreeId: string,
  sessionId: string
): StructuredLaunchSpeedBlock | null {
  return useSyncExternalStore(
    subscribeStructuredAgentLaunchStatus,
    () => getStructuredAgentSessionLaunchSpeedBlock(worktreeId, sessionId),
    () => null
  )
}

export function useStructuredAgentSessionLaunchFailure(
  worktreeId: string,
  sessionId: string
): StructuredLaunchFailure | null {
  return useSyncExternalStore(
    subscribeStructuredAgentLaunchStatus,
    () => getStructuredAgentSessionLaunchFailure(worktreeId, sessionId),
    () => null
  )
}

export function useStructuredAgentSessionLaunchLifecycle(
  worktreeId: string,
  sessionId: string
): StructuredAgentSessionLaunchLifecycle | null {
  return useSyncExternalStore(
    subscribeStructuredAgentLaunchStatus,
    () => getStructuredAgentSessionLaunchLifecycle(worktreeId, sessionId),
    () => null
  )
}

export function shouldRetainStructuredAgentSessionLaunchTab(
  worktreeId: string,
  sessionId: string
): boolean {
  const lifecycle = getStructuredAgentSessionLaunchLifecycle(worktreeId, sessionId)
  return lifecycle === 'pending' || lifecycle === 'visibility-unknown' || lifecycle === 'failed'
}

function markStructuredAgentSessionLaunchCancelledInternal(
  worktreeId: string,
  sessionId: string,
  executionHostId: ExecutionHostId,
  notify: boolean
): boolean {
  const alreadyCancelled = hasStructuredAgentLaunchCancellationTombstonePersisted(sessionId)
  const state = getStructuredLaunchStateBySessionId(sessionId)
  if (matchesLaunchWorktree(state, worktreeId) && state) {
    // The launch's own owner outranks the caller's: it is the host the create was sent to.
    markStructuredAgentLaunchCancellation(
      sessionId,
      state.intent.executionHostId,
      alreadyCancelled,
      state.promise
    )
    state.cancelled = true
    // A pass parked on a speed block ends with the launch instead of waiting for a pick.
    state.releaseSpeedBlock?.()
    state.callers.outcome = 'cancelled'
    // The tombstone is the durable authority; drop the in-memory launch so bulk closes cannot
    // retain a dead promise for the lifetime of the renderer.
    deleteStructuredLaunchStateIfCurrent(state)
  } else if (!alreadyCancelled) {
    markStructuredAgentLaunchCancellation(sessionId, executionHostId, alreadyCancelled)
  }
  if (!alreadyCancelled && notify) {
    notifyStructuredLaunchListeners()
  }
  return !alreadyCancelled
}

/** `executionHostId` owns the chat; a launch still in memory names its own. */
export function markStructuredAgentSessionLaunchCancelled(
  worktreeId: string,
  sessionId: string,
  executionHostId: ExecutionHostId
): boolean {
  return markStructuredAgentSessionLaunchCancelledInternal(
    worktreeId,
    sessionId,
    executionHostId,
    true
  )
}

/** Bulk workspace purges run inside a store updater; persist cancellation without notifying React. */
export function markStructuredAgentSessionLaunchCancelledSilently(
  worktreeId: string,
  sessionId: string,
  executionHostId: ExecutionHostId
): boolean {
  return markStructuredAgentSessionLaunchCancelledInternal(
    worktreeId,
    sessionId,
    executionHostId,
    false
  )
}

export function hasStructuredAgentSessionLaunchCancellationTombstone(
  _worktreeId: string,
  sessionId: string
): boolean {
  return hasStructuredAgentLaunchCancellationTombstonePersisted(sessionId)
}

export function retireStructuredAgentSessionLaunchCancellationTombstone(
  worktreeId: string,
  sessionId: string
): boolean {
  if (!hasStructuredAgentSessionLaunchCancellationTombstone(worktreeId, sessionId)) {
    return false
  }
  retireStructuredAgentLaunchCancellation(sessionId)
  notifyStructuredLaunchListeners()
  return true
}

export function retireAbsentStructuredAgentSessionLaunchCancellationTombstones(
  publishedSessionIds: ReadonlySet<string>,
  authoritativeInventory: number,
  executionHostId: ExecutionHostId
): boolean {
  const changed = retireAbsentStructuredAgentLaunchCancellations(
    publishedSessionIds,
    authoritativeInventory,
    executionHostId
  )
  if (changed) {
    notifyStructuredLaunchListeners()
  }
  return changed
}
