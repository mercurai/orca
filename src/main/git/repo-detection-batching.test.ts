import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as runner from './runner'
import { GitCommandTimeoutError } from './command-runner/git-command-timeout'
import {
  getGitRepoRootAsync,
  getLinkedWorktreeMainRepoRoot,
  inspectGitRepoForRegistrationAsync,
  isGitRepoAsync
} from './repo-detection'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
}

describe('repository registration probe batching', () => {
  let directory: string
  let repo: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-repo-probe-count-'))
    repo = join(directory, 'repo')
    mkdirSync(repo)
    git(repo, ['init', '-q'])
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
  })

  it('answers registration validity, root and main-checkout identity with two probes', async () => {
    const probe = vi.spyOn(runner, 'gitExecFileAsync')
    expect(await inspectGitRepoForRegistrationAsync(repo)).toEqual({
      isRepo: true,
      rootPath: git(repo, ['rev-parse', '--show-toplevel']).trim().replace(/\\/g, '/'),
      mainRepoPath: null
    })
    expect(probe).toHaveBeenCalledTimes(2)
    // The probe keeps the 15 s ceiling of the synchronous call it replaced.
    expect(probe.mock.calls.every(([, options]) => options.timeout === 15_000)).toBe(true)
  })

  it('keeps linked main-checkout resolution lazy and reuses its metadata', async () => {
    git(repo, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'seed',
      '--allow-empty'
    ])
    const linked = join(directory, 'linked')
    git(repo, ['worktree', 'add', '-q', '-b', 'linked', linked])
    const probe = vi.spyOn(runner, 'gitExecFileAsync')
    const inspected = await inspectGitRepoForRegistrationAsync(linked)
    expect(inspected.isRepo).toBe(true)
    expect(inspected.rootPath).toBe(
      git(linked, ['rev-parse', '--show-toplevel']).trim().replace(/\\/g, '/')
    )
    expect(inspected.mainRepoPath).toBe(realpathSync(repo))
    expect(probe).toHaveBeenCalledTimes(2)
    if (!inspected.mainRepoPath) {
      throw new Error('Linked checkout did not identify its main checkout')
    }
    expect(await getGitRepoRootAsync(inspected.mainRepoPath)).toBe(
      git(repo, ['rev-parse', '--show-toplevel']).trim().replace(/\\/g, '/')
    )
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('reads root and linked-main metadata together when a symlink changes between probes', async () => {
    const linked = join(directory, 'linked')
    const alias = join(directory, 'alias')
    git(repo, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'seed',
      '--allow-empty'
    ])
    git(repo, ['worktree', 'add', '-q', '-b', 'linked', linked])
    symlinkSync(repo, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const execute = runner.gitExecFileAsync
    const probe = vi.spyOn(runner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
      const output = await execute(args, options)
      if (probe.mock.calls.length === 1) {
        rmSync(alias)
        symlinkSync(linked, alias, process.platform === 'win32' ? 'junction' : 'dir')
      }
      return output
    })
    expect(await inspectGitRepoForRegistrationAsync(alias)).toEqual({
      isRepo: true,
      rootPath: git(linked, ['rev-parse', '--show-toplevel']).trim().replace(/\\/g, '/'),
      mainRepoPath: realpathSync(repo)
    })
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('identifies a bare repository without requesting a worktree root', async () => {
    const bare = join(directory, 'bare.git')
    git(directory, ['init', '--bare', '-q', bare])
    const probe = vi.spyOn(runner, 'gitExecFileAsync')
    expect(await inspectGitRepoForRegistrationAsync(bare)).toEqual({
      isRepo: true,
      rootPath: bare,
      mainRepoPath: null
    })
    expect(probe).toHaveBeenCalledOnce()
    expect(probe.mock.calls[0][0]).not.toContain('--show-toplevel')
  })

  it('rejects an administrative directory after one clean negative pair', async () => {
    const probe = vi.spyOn(runner, 'gitExecFileAsync')
    const admin = join(repo, '.git')
    expect(await inspectGitRepoForRegistrationAsync(admin)).toEqual({
      isRepo: false,
      rootPath: admin,
      mainRepoPath: null
    })
    expect(probe).toHaveBeenCalledOnce()
  })

  it('does not repeat a failed Git discovery before using the marker fallback', async () => {
    const nested = join(repo, 'packages', 'web')
    mkdirSync(nested, { recursive: true })
    const probe = vi
      .spyOn(runner, 'gitExecFileAsync')
      .mockRejectedValue(new Error('Git could not run'))
    expect(await inspectGitRepoForRegistrationAsync(nested)).toEqual({
      isRepo: true,
      rootPath: repo.replace(/\\/g, '/'),
      mainRepoPath: null
    })
    expect(probe).toHaveBeenCalledOnce()
  })

  it('falls back to the .git marker when a probe times out', async () => {
    const nested = join(repo, 'packages', 'web')
    mkdirSync(nested, { recursive: true })
    const probe = vi
      .spyOn(runner, 'gitExecFileAsync')
      .mockRejectedValue(new GitCommandTimeoutError(15_000))

    expect(await isGitRepoAsync(nested)).toBe(true)
    expect(await getGitRepoRootAsync(nested)).toBe(repo.replace(/\\/g, '/'))
    expect(probe).toHaveBeenCalled()
  })

  it('uses one boolean query for bare checks and none for a missing path', async () => {
    const bare = join(directory, 'bare.git')
    git(directory, ['init', '--bare', '-q', bare])
    const probe = vi.spyOn(runner, 'gitExecFileAsync')
    expect(await isGitRepoAsync(bare)).toBe(true)
    expect(probe).toHaveBeenCalledOnce()
    expect((await inspectGitRepoForRegistrationAsync(join(directory, 'missing'))).isRepo).toBe(false)
    expect(probe).toHaveBeenCalledOnce()
  })
})

// Windows rejects control characters in directory names.
describe.skipIf(process.platform === 'win32')('repository paths with newlines', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-repo-newline-'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
  })

  it.each(['repo\nname', 'repo\n\nname', ' repo name ', 'repo\n'])(
    'preserves the complete root %j instead of registering a prefix repository',
    async (name) => {
      const prefixRepo = join(directory, 'repo')
      mkdirSync(prefixRepo)
      git(prefixRepo, ['init', '-q'])
      const repo = join(directory, name)
      const nested = join(repo, 'nested')
      mkdirSync(nested, { recursive: true })
      git(repo, ['init', '-q'])
      expect(await getGitRepoRootAsync(nested)).toBe(realpathSync(repo))
      expect(await inspectGitRepoForRegistrationAsync(nested)).toEqual({
        isRepo: true,
        rootPath: realpathSync(repo),
        mainRepoPath: null
      })
    }
  )

  it('preserves an external Git directory containing a newline', async () => {
    const repo = join(directory, 'repo')
    const admin = join(directory, 'external\nadmin')
    mkdirSync(repo)
    git(repo, ['init', '-q', '--separate-git-dir', admin])
    const probe = vi.spyOn(runner, 'gitExecFileAsync')
    expect(await inspectGitRepoForRegistrationAsync(repo)).toEqual({
      isRepo: true,
      rootPath: realpathSync(repo),
      mainRepoPath: null
    })
    expect(probe).toHaveBeenCalledTimes(5)
    expect(probe.mock.calls.map(([args]) => args)).toContainEqual(['rev-parse', '--git-dir'])
    expect(probe.mock.calls.map(([args]) => args)).toContainEqual(['rev-parse', '--git-common-dir'])
    expect(await getLinkedWorktreeMainRepoRoot(repo)).toBeNull()
  })

  it('resolves linked checkout ownership with newlines in the root and common directory', async () => {
    const repo = join(directory, 'main\n\nrepo')
    mkdirSync(repo)
    git(repo, ['init', '-q'])
    git(repo, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '-qm',
      'seed',
      '--allow-empty'
    ])
    const linked = join(directory, 'linked\nrepo')
    git(repo, ['worktree', 'add', '-q', '-b', 'linked', linked])
    expect(await inspectGitRepoForRegistrationAsync(linked)).toEqual({
      isRepo: true,
      rootPath: realpathSync(linked),
      mainRepoPath: realpathSync(repo)
    })
    expect(await getLinkedWorktreeMainRepoRoot(linked)).toBe(realpathSync(repo))
  })
})
