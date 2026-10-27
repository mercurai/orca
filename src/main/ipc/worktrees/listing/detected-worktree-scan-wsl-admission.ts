import type { Repo } from '../../../../shared/repo-types'
import type { getLocalProjectWorktreeGitOptions } from '../../../project-runtime-git-options'
import { listRepoWorktreesForDetectedScan } from '../../../repo-worktrees'
import { assertWslUncPathRunning, wslDistroForPath } from '../../../wsl/wsl-unc-access-gate'

// A stopped distro fails the scan as unavailable (rows are retained) instead of booting it (E9).
// Not async: a host scan must start and settle on the same ticks as before.
export function listUnlessWslDistroStopped(
  repo: Repo,
  options: ReturnType<typeof getLocalProjectWorktreeGitOptions>
): ReturnType<typeof listRepoWorktreesForDetectedScan> {
  if (!wslDistroForPath(repo.path, options.wslDistro)) {
    return listRepoWorktreesForDetectedScan(repo, options)
  }
  return assertWslUncPathRunning(repo.path, options.wslDistro).then(() =>
    listRepoWorktreesForDetectedScan(repo, options)
  )
}
