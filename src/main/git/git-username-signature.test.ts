import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetLocalGitConfigSignatureCacheForTests } from '../github/local-git-config-signature'
import { readGlobalGitConfigStamp, readLocalGitUsernameSignature } from './git-username-signature'

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

describe('readGlobalGitConfigStamp', () => {
  let dir: string
  const savedGlobal = process.env.GIT_CONFIG_GLOBAL

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orca-global-sig-'))
  })

  afterEach(async () => {
    if (savedGlobal === undefined) {
      delete process.env.GIT_CONFIG_GLOBAL
    } else {
      process.env.GIT_CONFIG_GLOBAL = savedGlobal
    }
    await rm(dir, { recursive: true, force: true })
  })

  it('changes when an included file is edited', async () => {
    const included = join(dir, 'work.gitconfig')
    const main = join(dir, 'gitconfig')
    await writeFile(included, '[user]\n\tname = one\n')
    await writeFile(main, `[include]\n\tpath = ${included.split(sep).join('/')}\n`)
    process.env.GIT_CONFIG_GLOBAL = main

    const before = await readGlobalGitConfigStamp()
    await writeFile(included, '[user]\n\tname = two-longer\n')

    expect(await readGlobalGitConfigStamp()).not.toBe(before)
  })

  it('reads GIT_CONFIG_GLOBAL instead of the home gitconfig', async () => {
    const main = join(dir, 'gitconfig')
    await writeFile(main, '[user]\n')
    process.env.GIT_CONFIG_GLOBAL = main

    expect(await readGlobalGitConfigStamp()).toContain(main)
  })
})

describe('readGlobalGitConfigStamp gh login state', () => {
  let dir: string
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, gh: process.env.GH_CONFIG_DIR }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orca-gh-sig-'))
    process.env.GIT_CONFIG_GLOBAL = join(dir, 'gitconfig')
    process.env.GH_CONFIG_DIR = join(dir, 'gh')
    await mkdir(join(dir, 'gh'))
  })

  afterEach(async () => {
    for (const [key, value] of [
      ['GIT_CONFIG_GLOBAL', saved.global],
      ['GH_CONFIG_DIR', saved.gh]
    ] as const) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    await rm(dir, { recursive: true, force: true })
  })

  it('changes when the gh hosts file changes (login, logout, switch)', async () => {
    await writeFile(join(dir, 'gh', 'hosts.yml'), 'github.com:\n  user: one\n')
    const before = await readGlobalGitConfigStamp()
    await writeFile(join(dir, 'gh', 'hosts.yml'), 'github.com:\n  user: two-longer\n')

    expect(await readGlobalGitConfigStamp()).not.toBe(before)
  })
})
