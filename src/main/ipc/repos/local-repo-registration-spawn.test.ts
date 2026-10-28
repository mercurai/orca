import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as runner from '../../git/runner'
import { isGitRepo } from '../../git/repo'
import { resolveLocalNestedRepoImportTargetPath } from '../../project-groups/nested-repo-import-target'
import type { Store } from '../../persistence'

// Every synchronous spawn route throws, so a regression anywhere on these paths fails loudly.
const { runProcessSyncMock } = vi.hoisted(() => ({
  runProcessSyncMock: vi.fn(() => {
    throw new Error('synchronous spawn on the registration path')
  })
}))

vi.mock('../../../shared/child-process/run-process', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runProcessSync: runProcessSyncMock
}))
vi.mock('../../repo-icon-autodetect', () => ({
  detectRepoIconAndUpstream: vi.fn(async () => ({}))
}))
vi.mock('../../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: vi.fn(async () => {})
}))

import { addLocalRepoFromPath } from './local-repo-registration'

describe('repo detection spawn behaviour', () => {
  let directory: string
  let repo: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-add-repo-spawn-'))
    repo = join(directory, 'repo')
    mkdirSync(repo)
    execFileSync('git', ['init', '-q'], { cwd: repo })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  it('registers a repo without a synchronous spawn on the main thread', async () => {
    const syncGit = vi.spyOn(runner, 'gitExecFileSync')
    const asyncGit = vi.spyOn(runner, 'gitExecFileAsync')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: addLocalRepoFromPath reads only getRepos and addRepo; Store is a class, so a structural double cannot satisfy it without the cast.
    const store = { getRepos: () => [], addRepo: vi.fn() } as unknown as Store

    const result = await addLocalRepoFromPath(store, repo)

    expect(result).toMatchObject({ alreadyExisted: false })
    expect(syncGit).not.toHaveBeenCalled()
    expect(runProcessSyncMock).not.toHaveBeenCalled()
    expect(asyncGit).toHaveBeenCalled()
  })

  it('answers the nested-import checks without a synchronous spawn', async () => {
    const syncGit = vi.spyOn(runner, 'gitExecFileSync')

    // Both nested-import paths gate each candidate on isGitRepo, then resolve its import target
    // through the worktree graph.
    expect(await isGitRepo(repo)).toBe(true)
    expect(await isGitRepo(directory)).toBe(false)
    expect(await resolveLocalNestedRepoImportTargetPath(repo)).toBe(repo.replaceAll('\\', '/'))

    expect(syncGit).not.toHaveBeenCalled()
    expect(runProcessSyncMock).not.toHaveBeenCalled()
  })
})
