import type { AgentSessionHistoryResult } from '../../../shared/agent-session-wire'
import {
  launchStructuredAgentSession,
  StructuredAgentSessionCreateRefusalError,
  type StructuredAgentSessionLaunchIntent,
  type StructuredLaunchHostSeedListener
} from '@/lib/launch-structured-agent-session'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { readStructuredSessionTabInventory } from '@/runtime/structured-session-tab-inventory'

export type StructuredAgentLaunchReceipt = { sessionId: string; fence: number }

export type StructuredLaunchRecoveryState = {
  intent: StructuredAgentSessionLaunchIntent
  promise: Promise<StructuredAgentLaunchReceipt>
  visibilityUnknown: boolean
  cancelled: boolean
  /** The chat the host created. A recovery that has it adopts that chat and never creates another. */
  receipt?: StructuredAgentLaunchReceipt
  onVisibilityChanged?: () => void
  onHostSeed?: StructuredLaunchHostSeedListener
}

export class StructuredAgentSessionLaunchCancelledError extends Error {
  constructor() {
    super('structured session launch cancelled')
    this.name = 'StructuredAgentSessionLaunchCancelledError'
  }
}

function throwIfLaunchCancelled(state: StructuredLaunchRecoveryState): void {
  if (state.cancelled) {
    throw new StructuredAgentSessionLaunchCancelledError()
  }
}

async function verifyPublishedSession(state: StructuredLaunchRecoveryState): Promise<void> {
  const snapshots = await readStructuredSessionTabInventory(state.intent.target)
  throwIfLaunchCancelled(state)
  const published = snapshots.some(
    (snapshot) =>
      snapshot.worktree === state.intent.worktreeId &&
      snapshot.tabs.some(
        (tab) => tab.type === 'agent-session' && tab.sessionId === state.intent.sessionId
      )
  )
  if (!published) {
    throw new Error('structured session tab publication unavailable')
  }
}

async function recoverPublishedSessionReceipt(
  state: StructuredLaunchRecoveryState
): Promise<StructuredAgentLaunchReceipt> {
  await verifyPublishedSession(state)
  const history = await callStructuredAgentSession<AgentSessionHistoryResult>(
    state.intent.target,
    'agentSession.history',
    { sessionId: state.intent.sessionId, direction: 'tail', limit: 1 }
  )
  throwIfLaunchCancelled(state)
  const fence = history.page.fence ?? (!history.ok ? history.fence : undefined)
  if (typeof fence !== 'number') {
    throw new Error('structured session fence publication unavailable')
  }
  return { sessionId: state.intent.sessionId, fence }
}

/** The fence the host shows now when its inventory and history can be read; the receipt otherwise. */
async function adoptRetainedReceipt(
  state: StructuredLaunchRecoveryState,
  receipt: StructuredAgentLaunchReceipt
): Promise<StructuredAgentLaunchReceipt> {
  try {
    return await recoverPublishedSessionReceipt(state)
  } catch {
    throwIfLaunchCancelled(state)
    return receipt
  }
}

async function retrySameIntent(
  state: StructuredLaunchRecoveryState,
  priorError: unknown
): Promise<StructuredAgentLaunchReceipt> {
  throwIfLaunchCancelled(state)
  try {
    const receipt = await launchStructuredAgentSession(state.intent, state.onHostSeed)
    throwIfLaunchCancelled(state)
    await verifyPublishedSession(state)
    return receipt
  } catch (error) {
    if (state.cancelled) {
      throw new StructuredAgentSessionLaunchCancelledError()
    }
    if (error instanceof StructuredAgentSessionCreateRefusalError) {
      throw error
    }
    try {
      return await recoverPublishedSessionReceipt(state)
    } catch {
      if (state.cancelled) {
        throw new StructuredAgentSessionLaunchCancelledError()
      }
      state.visibilityUnknown = true
      state.onVisibilityChanged?.()
      throw error ?? priorError
    }
  }
}

export async function launchAndReconcile(
  state: StructuredLaunchRecoveryState
): Promise<StructuredAgentLaunchReceipt> {
  throwIfLaunchCancelled(state)
  if (state.receipt) {
    return adoptRetainedReceipt(state, state.receipt)
  }
  let receipt: StructuredAgentLaunchReceipt
  try {
    receipt = await launchStructuredAgentSession(state.intent, state.onHostSeed)
  } catch (error) {
    if (state.cancelled) {
      throw new StructuredAgentSessionLaunchCancelledError()
    }
    if (error instanceof StructuredAgentSessionCreateRefusalError) {
      throw error
    }
    try {
      return await recoverPublishedSessionReceipt(state)
    } catch {
      return retrySameIntent(state, error)
    }
  }
  try {
    throwIfLaunchCancelled(state)
    await verifyPublishedSession(state)
    return receipt
  } catch (error) {
    if (state.cancelled) {
      throw new StructuredAgentSessionLaunchCancelledError()
    }
    return retrySameIntent(state, error)
  }
}

export async function reconcileUnknownLaunch(
  state: StructuredLaunchRecoveryState
): Promise<StructuredAgentLaunchReceipt> {
  throwIfLaunchCancelled(state)
  state.visibilityUnknown = false
  state.onVisibilityChanged?.()
  if (state.receipt) {
    return adoptRetainedReceipt(state, state.receipt)
  }
  try {
    return await recoverPublishedSessionReceipt(state)
  } catch (error) {
    return retrySameIntent(state, error)
  }
}
