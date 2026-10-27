import { drainPendingPathWrites, pendingPathWritePaths } from '../../shared/path-write-serializer'
import { settleWithinMs } from '../quit-teardown-deadline'

// Why 5s: a durable secure write is a temp write, an fsync, an ACL spawn on Windows and a rename;
// it has to fit well inside the shared 20s will-quit deadline.
export const PATH_WRITE_QUIT_DEADLINE_MS = 5_000

/** Bounds shutdown writes; daemon hosts reject timeouts to retain their ownership fences. */
export async function drainPathWritesForQuit(
  timeoutMs: number = PATH_WRITE_QUIT_DEADLINE_MS,
  options: { throwOnTimeout?: boolean } = {}
): Promise<void> {
  const settled = await settleWithinMs(drainPendingPathWrites(), timeoutMs)
  if (settled.outcome === 'timed-out') {
    // Why paths only: the payloads are credentials.
    console.warn('[shutdown] Secure file writes still pending at quit', {
      paths: pendingPathWritePaths()
    })
    if (options.throwOnTimeout) {
      throw new Error('Secure file writes did not drain before shutdown')
    }
  }
}
