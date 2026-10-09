import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'

const { listRepoWorktreesMock, gitOptionsMock, readSharedMock } = vi.hoisted(() => ({
  listRepoWorktreesMock: vi.fn(),
  gitOptionsMock: vi.fn(),
  readSharedMock: vi.fn()
}))

vi.mock('../../../repo-worktrees', () => ({
  listRepoWorktreesForDetectedScan: listRepoWorktreesMock
}))
vi.mock('../../../project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: gitOptionsMock
}))
vi.mock('../../../runtime/repo-worktree-admin-fingerprint', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readRepoWorktreeAdminFingerprintShared: readSharedMock
}))
vi.mock('../../registered-worktree-roots-cache', () => ({
  getRegisteredWorktreeRootsRevision: () => 1,
  registerWorktreeRootsForRepo: vi.fn()
}))

const {
  DETECTED_WORKTREE_SCAN_CACHE_TTL_MS,
  __resetDetectedWorktreeScanCacheForTests,
  invalidateDetectedWorktreeScanCache,
  listDetectedGitWorktrees
} = await import('./detected-worktree-scan-cache')
const { DETECTED_WORKTREE_SCAN_RECONCILE_INTERVAL_MS } =
  await import('./detected-worktree-scan-fingerprint')

const { readRepoWorktreeAdminFingerprintShared: realReadShared } = await vi.importActual<
  typeof import('../../../runtime/repo-worktree-admin-fingerprint')
>('../../../runtime/repo-worktree-admin-fingerprint')

const store = { captureNativeLocalWorktreeMetadataScanExpectation: vi.fn() } as never

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

/** Reads the real `git worktree list`, so the test sees what an out-of-band `git worktree add` does. */
function listRealWorktrees(repoPath: string): GitWorktreeInfo[] {
  return git(repoPath, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line, index) => ({
      path: line.slice('worktree '.length),
      head: '',
      branch: '',
      isBare: false,
      isMainWorktree: index === 0
    }))
}

function advancePastListingTtl(): void {
  vi.setSystemTime(Date.now() + DETECTED_WORKTREE_SCAN_CACHE_TTL_MS + 1)
}

describe('detected worktree scan admin fingerprint gate', () => {
  let root: string
  let repo: Repo

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'orca-scan-fingerprint-')))
    const repoPath = path.join(root, 'repo')
    mkdirSync(repoPath)
    git(repoPath, 'init', '-q', '-b', 'main')
    git(repoPath, 'config', 'user.email', 'test@example.com')
    git(repoPath, 'config', 'user.name', 'Test')
    writeFileSync(path.join(repoPath, 'file.txt'), 'one')
    git(repoPath, 'add', '.')
    git(repoPath, 'commit', '-q', '-m', 'init')
    repo = { id: 'repo-1', path: repoPath, displayName: 'repo' } as Repo

    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    gitOptionsMock.mockReset().mockReturnValue({})
    readSharedMock.mockReset().mockImplementation(realReadShared)
    listRepoWorktreesMock.mockReset().mockImplementation(async () => listRealWorktrees(repo.path))
    __resetDetectedWorktreeScanCacheForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(root, { recursive: true, force: true })
  })

  it('skips the listing on cache expiry while the admin fingerprint is unchanged', async () => {
    const first = await listDetectedGitWorktrees(store, repo)
    for (let poll = 0; poll < 5; poll += 1) {
      advancePastListingTtl()
      const scan = await listDetectedGitWorktrees(store, repo)
      expect(scan.gitWorktrees).toBe(first.gitWorktrees)
      expect(scan.superseded).toBe(false)
    }
    expect(listRepoWorktreesMock).toHaveBeenCalledTimes(1)
  })

  it('lists a worktree added outside Orca on the next poll after the TTL', async () => {
    await listDetectedGitWorktrees(store, repo)
    const added = path.join(root, 'outside')
    git(repo.path, 'worktree', 'add', '-q', '-b', 'outside', added)

    advancePastListingTtl()
    const scan = await listDetectedGitWorktrees(store, repo)

    expect(listRepoWorktreesMock).toHaveBeenCalledTimes(2)
    expect(scan.gitWorktrees.map((worktree) => path.resolve(worktree.path))).toContain(
      path.resolve(added)
    )
  })

  it('lists again after a commit moves the branch tip', async () => {
    await listDetectedGitWorktrees(store, repo)
    writeFileSync(path.join(repo.path, 'file.txt'), 'two')
    git(repo.path, 'commit', '-q', '-am', 'second')

    advancePastListingTtl()
    await listDetectedGitWorktrees(store, repo)

    expect(listRepoWorktreesMock).toHaveBeenCalledTimes(2)
  })

  it('still lists once per reconcile interval even when nothing changed', async () => {
    await listDetectedGitWorktrees(store, repo)
    vi.setSystemTime(Date.now() + DETECTED_WORKTREE_SCAN_RECONCILE_INTERVAL_MS + 1)
    await listDetectedGitWorktrees(store, repo)
    expect(listRepoWorktreesMock).toHaveBeenCalledTimes(2)
  })

  it('lists again after an Orca-side invalidation', async () => {
    await listDetectedGitWorktrees(store, repo)
    invalidateDetectedWorktreeScanCache(repo.id)
    await listDetectedGitWorktrees(store, repo)
    expect(listRepoWorktreesMock).toHaveBeenCalledTimes(2)
  })

  it('never fingerprints WSL-routed repos', async () => {
    gitOptionsMock.mockReturnValue({ wslDistro: 'Ubuntu' })
    await listDetectedGitWorktrees(store, repo)
    advancePastListingTtl()
    await listDetectedGitWorktrees(store, repo)
    expect(listRepoWorktreesMock).toHaveBeenCalledTimes(2)
    expect(readSharedMock).not.toHaveBeenCalled()
  })

  it('does not stamp a change that landed between the listing and the fingerprint read', async () => {
    // The listing resolves only after the opening read settled, then a worktree appears and the
    // (stale) rows are returned: the closing read sees a different state and the stamp is dropped.
    let openingRead: Promise<unknown> | undefined
    readSharedMock.mockImplementationOnce((...args: Parameters<typeof realReadShared>) => {
      openingRead = realReadShared(...args)
      return openingRead
    })
    listRepoWorktreesMock.mockImplementationOnce(async () => {
      const rows = listRealWorktrees(repo.path)
      await openingRead
      git(repo.path, 'worktree', 'add', '-q', '-b', 'racing', path.join(root, 'racing'))
      return rows
    })
    await listDetectedGitWorktrees(store, repo)

    advancePastListingTtl()
    const scan = await listDetectedGitWorktrees(store, repo)

    expect(listRepoWorktreesMock).toHaveBeenCalledTimes(2)
    expect(scan.gitWorktrees.map((worktree) => path.resolve(worktree.path))).toContain(
      path.resolve(root, 'racing')
    )
  })

  it('rescans when an invalidation lands while the expiry probe is pending', async () => {
    await listDetectedGitWorktrees(store, repo)
    let release: (value: string | null) => void = () => {}
    readSharedMock.mockImplementationOnce(
      () => new Promise<string | null>((resolve) => (release = resolve))
    )
    advancePastListingTtl()
    const pending = listDetectedGitWorktrees(store, repo)
    invalidateDetectedWorktreeScanCache(repo.id)
    // The pre-invalidation fingerprint would match, but the entry it describes is gone.
    release(await realReadShared('probe', repo.path, 10_000))
    await pending
    expect(listRepoWorktreesMock).toHaveBeenCalledTimes(2)
  })

  it('lets concurrent expired polls share one answer without listing', async () => {
    await listDetectedGitWorktrees(store, repo)
    advancePastListingTtl()
    await Promise.all([
      listDetectedGitWorktrees(store, repo),
      listDetectedGitWorktrees(store, repo)
    ])
    expect(listRepoWorktreesMock).toHaveBeenCalledTimes(1)
  })

  it('lists again when the repo cannot be fingerprinted', async () => {
    const missing = { ...repo, path: path.join(root, 'not-a-repo') } as Repo
    await listDetectedGitWorktrees(store, missing)
    advancePastListingTtl()
    await listDetectedGitWorktrees(store, missing)
    expect(listRepoWorktreesMock).toHaveBeenCalledTimes(2)
  })
})
