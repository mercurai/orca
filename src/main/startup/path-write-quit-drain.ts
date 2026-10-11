import { drainPendingPathWrites, pendingPathWritePaths } from '../../shared/path-write-serializer'
import { settleWithinMs } from '../quit-teardown-deadline'

// Why 5s: a durable secure write is a temp write, an fsync, an ACL spawn on Windows and a rename;
// it has to fit well inside the shared 20s will-quit deadline.
export const PATH_WRITE_QUIT_DEADLINE_MS = 5_000

/** Waits for queued secure-file writes before quit; a hung write is logged and abandoned, never awaited. */
export async function drainPathWritesForQuit(
  timeoutMs: number = PATH_WRITE_QUIT_DEADLINE_MS
): Promise<void> {
  const settled = await settleWithinMs(drainPendingPathWrites(), timeoutMs)
  if (settled.outcome === 'timed-out') {
    // Why paths only: the payloads are credentials.
    console.warn('[shutdown] Secure file writes still pending at quit', {
      paths: pendingPathWritePaths()
    })
  }
}
