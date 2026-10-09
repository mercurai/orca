import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetLocalGitConfigSignatureCacheForTests } from '../github/local-git-config-signature'
import { readLocalGitUsernameSignature } from './git-username-signature'

describe('readLocalGitUsernameSignature', () => {
  let repoPath: string

  beforeEach(async () => {
    __resetLocalGitConfigSignatureCacheForTests()
    repoPath = await mkdtemp(join(tmpdir(), 'orca-username-sig-'))
    await mkdir(join(repoPath, '.git'))
    await writeFile(join(repoPath, '.git', 'config'), '[core]\n')
    await writeFile(join(repoPath, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  })

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true })
  })

  it('is stable while nothing changes', async () => {
    const first = await readLocalGitUsernameSignature(repoPath, 'g')
    __resetLocalGitConfigSignatureCacheForTests()
    expect(await readLocalGitUsernameSignature(repoPath, 'g')).toBe(first)
    expect(first).toBeDefined()
  })

  it('changes when HEAD moves to another branch', async () => {
    const before = await readLocalGitUsernameSignature(repoPath, 'g')
    await writeFile(join(repoPath, '.git', 'HEAD'), 'ref: refs/heads/other\n')
    __resetLocalGitConfigSignatureCacheForTests()
    expect(await readLocalGitUsernameSignature(repoPath, 'g')).not.toBe(before)
  })

  it('changes when the repo config changes', async () => {
    const before = await readLocalGitUsernameSignature(repoPath, 'g')
    await writeFile(join(repoPath, '.git', 'config'), '[github]\n\tuser = someone-else\n')
    __resetLocalGitConfigSignatureCacheForTests()
    expect(await readLocalGitUsernameSignature(repoPath, 'g')).not.toBe(before)
  })

  it('changes with the global config stamp', async () => {
    const before = await readLocalGitUsernameSignature(repoPath, 'g1')
    expect(await readLocalGitUsernameSignature(repoPath, 'g2')).not.toBe(before)
  })

  it('is undefined for a path that is not a git repo', async () => {
    expect(await readLocalGitUsernameSignature(join(repoPath, 'missing'), 'g')).toBeUndefined()
  })
})
