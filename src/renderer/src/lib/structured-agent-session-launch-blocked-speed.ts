import type { AgentSessionWriteFailure } from '../../../shared/agent-session/failures/agent-session-write-failure'
import {
  getStructuredLaunchStateBySessionId,
  subscribeStructuredAgentLaunchStatus,
  type StructuredLaunchState
} from './agent-session/launch/structured-agent-session-launch-registry'

/** A refused Codex speed pick: the user's intent, kept until an explicit replacement lands. */
type RetainedSpeed = {
  key: string
  value: string
  failure: AgentSessionWriteFailure | undefined
  /** The refused operation's identity, so recency survives that operation being discarded. */
  identity: number
}

const retained = new WeakMap<StructuredLaunchState, RetainedSpeed>()
const selectionVersions = new WeakMap<StructuredLaunchState, number>()

export function isCodexLaunchSpeedKey(state: StructuredLaunchState, key: string): boolean {
  return state.intent.agent === 'codex' && (key === 'serviceTier' || key === 'fastMode')
}

const OTHER_SPEED_KEY: Readonly<Record<string, string>> = {
  serviceTier: 'fastMode',
  fastMode: 'serviceTier'
}

export function otherCodexLaunchSpeedKey(
  state: StructuredLaunchState,
  key: string
): string | undefined {
  return isCodexLaunchSpeedKey(state, key) ? OTHER_SPEED_KEY[key] : undefined
}

/** Codex's tier and fast switch are one speed intent. The newest pick of either key, or the
 *  retained refusal that outlived its operation, wins: any older speed operation or retained
 *  value is stale, whatever the host later answers for it. */
export function isSupersededBySpeedPick(
  state: StructuredLaunchState,
  controller: { current(key: string): { identity: number } | undefined },
  key: string,
  identity: number
): boolean {
  if (!isCodexLaunchSpeedKey(state, key)) {
    return false
  }
  const newest = Math.max(
    retained.get(state)?.identity ?? 0,
    controller.current('serviceTier')?.identity ?? 0,
    controller.current('fastMode')?.identity ?? 0
  )
  return newest > identity
}

export function retainedStructuredLaunchSpeed(
  state: StructuredLaunchState
): RetainedSpeed | undefined {
  return retained.get(state)
}

export function retainStructuredLaunchSpeed(
  state: StructuredLaunchState,
  speed: RetainedSpeed
): void {
  retained.set(state, speed)
}

/** Replacements still use the created receipt after a modern opening message was published. */
export function isStructuredLaunchSpeedBlocked(sessionId: string, key: string): boolean {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  return !!state && retained.has(state) && (key === 'model' || isCodexLaunchSpeedKey(state, key))
}

/** A speed pick replaces the retained one; a model pick hands it back to be tried under that model. */
export function noteStructuredLaunchSpeedReplacement(
  state: StructuredLaunchState,
  key: string
): RetainedSpeed | undefined {
  if (key !== 'model' && !isCodexLaunchSpeedKey(state, key)) {
    return undefined
  }
  selectionVersions.set(state, (selectionVersions.get(state) ?? 0) + 1)
  const speed = retained.get(state)
  retained.delete(state)
  return key === 'model' ? speed : undefined
}

/** Only an explicit selection change, cancellation or the selection owner's retirement wakes a
 *  refused speed; never a timer. The controller's own subscription reports retirement. */
export function waitForStructuredLaunchSpeedChange(
  state: StructuredLaunchState,
  owner: { subscribe(listener: () => void): () => void; isCurrent(): boolean }
): Promise<void> {
  const version = selectionVersions.get(state)
  return new Promise((resolve) => {
    let unsubscribeStatus = (): void => {}
    let unsubscribeOwner = (): void => {}
    const check = (): void => {
      if (!state.cancelled && owner.isCurrent() && selectionVersions.get(state) === version) {
        return
      }
      unsubscribeStatus()
      unsubscribeOwner()
      resolve()
    }
    unsubscribeStatus = subscribeStructuredAgentLaunchStatus(check)
    unsubscribeOwner = owner.subscribe(check)
    check()
  })
}
