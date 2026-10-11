import { getSshHostServerStatus } from '../ssh/ssh-host-server-status'
import { getCurrentMainWindow } from './ssh-ipc-context'
import { restorePortForwards } from './ssh-port-forward-persistence'

const restoring = new Map<string, Promise<void>>()

/** A managed host has no relay session to restore its saved forwards, so its connects do. */
export function restoreManagedHostPortForwards(targetId: string): Promise<void> {
  if (getSshHostServerStatus(targetId)?.kind !== 'managed') {
    return Promise.resolve()
  }
  // Why chained: overlapping connects would otherwise both bind the same saved local port.
  const previous = restoring.get(targetId) ?? Promise.resolve()
  const next = previous
    .then(() => restorePortForwards(targetId, getCurrentMainWindow))
    .catch((error: unknown) => {
      console.warn(`[ssh] Could not restore port forwards for ${targetId}:`, error)
    })
    .finally(() => {
      if (restoring.get(targetId) === next) {
        restoring.delete(targetId)
      }
    })
  restoring.set(targetId, next)
  return next
}
