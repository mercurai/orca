import {
  getStructuredLaunchStateBySessionId,
  subscribeStructuredAgentLaunchStatus,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'

const blocked = new WeakSet<StructuredLaunchState>()
const selectionVersions = new WeakMap<StructuredLaunchState, number>()

export function isCodexLaunchSpeedKey(state: StructuredLaunchState, key: string): boolean {
  return state.intent.agent === 'codex' && (key === 'serviceTier' || key === 'fastMode')
}

/** Replacements still use the created receipt after a modern opening message was published. */
export function isStructuredLaunchSpeedBlocked(sessionId: string, key: string): boolean {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  return !!state && blocked.has(state) && (key === 'model' || isCodexLaunchSpeedKey(state, key))
}

export function noteStructuredLaunchSpeedReplacement(
  state: StructuredLaunchState,
  key: string
): void {
  if (key === 'model' || isCodexLaunchSpeedKey(state, key)) {
    selectionVersions.set(state, (selectionVersions.get(state) ?? 0) + 1)
  }
}

/** Only an explicit held selection change or cancellation wakes a refused speed; never a timer. */
export function waitForStructuredLaunchSpeedChange(state: StructuredLaunchState): Promise<void> {
  const version = selectionVersions.get(state)
  blocked.add(state)
  return new Promise((resolve) => {
    let unsubscribe = (): void => {}
    const check = (): void => {
      if (!state.cancelled && selectionVersions.get(state) === version) {
        return
      }
      unsubscribe()
      blocked.delete(state)
      resolve()
    }
    unsubscribe = subscribeStructuredAgentLaunchStatus(check)
    check()
  })
}
