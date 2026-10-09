import { getRepoSshConnectionId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import { readRepoWorktreeAdminFingerprintShared } from '../../../runtime/repo-worktree-admin-fingerprint'

// Why: the fingerprint reads HEAD and its ref tip exactly, but sparse-checkout edits are invisible to
// it and a tip in packed-refs or reftable only gets an mtime + size stamp, so a real scan still runs
// on this interval. Mirrors WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS on the runtime scan path.
export const DETECTED_WORKTREE_SCAN_RECONCILE_INTERVAL_MS = 5 * 60_000

// Why short: the probe only decides whether a 5 s cache can be extended. A probe that does not fit
// yields `null` ("cannot prove unchanged"), which falls back to the real scan.
const DETECTED_WORKTREE_SCAN_FINGERPRINT_TIMEOUT_MS = 2_000

/** SSH and WSL repos run Git off-host, so a local admin-dir read cannot describe their listing. */
export function canFingerprintDetectedWorktreeScan(
  repo: Repo,
  localWorktreeGitOptions: { wslDistro?: string }
): boolean {
  return !getRepoSshConnectionId(repo) && !localWorktreeGitOptions.wslDistro
}

export function readDetectedWorktreeScanFingerprint(
  cacheKey: string,
  repo: Repo
): Promise<string | null> {
  return readRepoWorktreeAdminFingerprintShared(
    `${cacheKey}\0${repo.path}`,
    repo.path,
    DETECTED_WORKTREE_SCAN_FINGERPRINT_TIMEOUT_MS
  )
}

/** True when the cached scan is young enough to reuse and the repo's admin state still matches it. */
export async function isCachedScanProvenUnchanged(
  cacheKey: string,
  repo: Repo,
  cached: { adminFingerprint: string | null; scannedAt: number }
): Promise<boolean> {
  if (
    cached.adminFingerprint === null ||
    Date.now() - cached.scannedAt >= DETECTED_WORKTREE_SCAN_RECONCILE_INTERVAL_MS
  ) {
    return false
  }
  const current = await readDetectedWorktreeScanFingerprint(cacheKey, repo)
  return current !== null && current === cached.adminFingerprint
}

/**
 * Resolve the fingerprint to store beside a fresh scan. `before` was read as the scan started; a
 * second read after it settles proves nothing moved in between, because a change landing between
 * Git's listing and the first read would otherwise be stamped as already observed and hide until the
 * reconcile interval. Any disagreement or failure yields `null`, which forces the next poll to rescan.
 */
export async function settleDetectedScanFingerprint(
  cacheKey: string,
  repo: Repo,
  before: Promise<string | null> | null
): Promise<string | null> {
  const first = before ? await before : null
  if (first === null) {
    return null
  }
  return (await readDetectedWorktreeScanFingerprint(cacheKey, repo)) === first ? first : null
}
