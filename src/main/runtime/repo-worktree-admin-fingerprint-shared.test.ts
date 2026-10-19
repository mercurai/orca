import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { resolveCommonDirMock } = vi.hoisted(() => ({ resolveCommonDirMock: vi.fn() }))

vi.mock('../../shared/git-common-directory', () => ({
  resolveGitCommonDirectory: resolveCommonDirMock
}))

const { readRepoWorktreeAdminFingerprintShared } = await import('./repo-worktree-admin-fingerprint')

describe('readRepoWorktreeAdminFingerprintShared single flight', () => {
  let releases: (() => void)[] = []
  const releaseAll = (): void => releases.forEach((release) => release())

  beforeEach(() => {
    vi.useFakeTimers()
    // A repo with no resolvable common dir fingerprints to null once the gate opens.
    releases = []
    resolveCommonDirMock.mockReset().mockImplementation(
      () =>
        new Promise<null>((resolve) => {
          releases.push(() => resolve(null))
        })
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs one read for concurrent callers on one key and one per distinct key', async () => {
    const first = readRepoWorktreeAdminFingerprintShared('a', '/repo', 10_000)
    const second = readRepoWorktreeAdminFingerprintShared('a', '/repo', 10_000)
    const other = readRepoWorktreeAdminFingerprintShared('b', '/repo', 10_000)
    expect(resolveCommonDirMock).toHaveBeenCalledTimes(2)
    releaseAll()
    await Promise.all([first, second, other])
  })

  it('answers null at the timeout but keeps the slot until the read itself settles', async () => {
    const timedOut = readRepoWorktreeAdminFingerprintShared('a', '/repo', 50)
    await vi.advanceTimersByTimeAsync(50)
    expect(await timedOut).toBeNull()

    readRepoWorktreeAdminFingerprintShared('a', '/repo', 50).catch(() => {})
    expect(resolveCommonDirMock).toHaveBeenCalledTimes(1)

    releaseAll()
    await vi.advanceTimersByTimeAsync(0)
    const afterSettle = readRepoWorktreeAdminFingerprintShared('a', '/repo', 10_000)
    expect(resolveCommonDirMock).toHaveBeenCalledTimes(2)
    releaseAll()
    await afterSettle
  })
})
