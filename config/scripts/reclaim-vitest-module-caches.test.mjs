import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { reclaimVitestModuleCaches } from './reclaim-vitest-module-caches.mjs'
import {
  checkedLocalModuleCacheParent,
  localModuleCacheEnv,
  localModuleCacheParent,
  pruneLocalModuleCaches
} from './vitest-local-module-cache.mjs'

const roots = []
const nowMs = Date.UTC(2026, 0, 1)

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

async function worktreeWithCaches(ages) {
  const worktree = await realpath(await mkdtemp(join(tmpdir(), 'orca-vitest-module-cache-')))
  roots.push(worktree)
  for (const [name, days] of Object.entries(ages)) {
    const path = join(localModuleCacheParent(worktree), name)
    await mkdir(path, { recursive: true })
    const time = new Date(nowMs - days * 86_400_000)
    await utimes(path, time, time)
  }
  return worktree
}

it('removes only caches idle past the cutoff, and only with --apply', async () => {
  const worktree = await worktreeWithCaches({ idle: 8, recent: 1 })
  const options = { worktrees: [worktree], nowMs, report: () => {} }

  expect(await reclaimVitestModuleCaches(options)).toEqual({ entries: 1 })
  expect((await readdir(localModuleCacheParent(worktree))).sort()).toEqual(['idle', 'recent'])

  await reclaimVitestModuleCaches({ ...options, apply: true })
  expect(await readdir(localModuleCacheParent(worktree))).toEqual(['recent'])
})

it('skips the excluded worktree', async () => {
  const worktree = await worktreeWithCaches({ idle: 8 })
  await reclaimVitestModuleCaches({
    worktrees: [worktree],
    excludeWorktree: worktree,
    apply: true,
    nowMs,
    report: () => {}
  })
  expect(await readdir(localModuleCacheParent(worktree))).toEqual(['idle'])
})

const cacheComponents = ['worktree', 'node_modules', '.cache', 'orca-vitest-modules']

async function worktreeWithLinkedCache(component) {
  const sandbox = await realpath(await mkdtemp(join(tmpdir(), 'orca-vitest-module-cache-link-')))
  roots.push(sandbox)
  const index = cacheComponents.indexOf(component)
  const link = join(sandbox, ...cacheComponents.slice(0, index + 1))
  const external = join(sandbox, 'external')
  await mkdir(external)
  await mkdir(dirname(link), { recursive: true })
  await symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir')
  const externalParent = join(external, ...cacheComponents.slice(index + 1))
  const idle = join(externalParent, 'idle')
  await mkdir(idle, { recursive: true })
  const sentinel = join(idle, 'sentinel')
  await writeFile(sentinel, 'external-owned')
  const time = new Date(nowMs - 8 * 86_400_000)
  await utimes(idle, time, time)
  return { worktree: join(sandbox, 'worktree'), externalParent, sentinel }
}

it.each(cacheComponents)('refuses linked %s during reclamation', async (component) => {
  const { worktree, sentinel } = await worktreeWithLinkedCache(component)

  expect(
    await reclaimVitestModuleCaches({
      worktrees: [worktree],
      apply: true,
      nowMs,
      report: () => {}
    })
  ).toEqual({ entries: 0 })
  expect(await readFile(sentinel, 'utf8')).toBe('external-owned')
})

it.each(cacheComponents)('refuses linked %s during local pruning', async (component) => {
  const { worktree, sentinel } = await worktreeWithLinkedCache(component)

  pruneLocalModuleCaches(localModuleCacheParent(worktree), 'current', nowMs)

  expect(await readFile(sentinel, 'utf8')).toBe('external-owned')
})

it.each(cacheComponents)('uses a cold cache for linked %s', async (component) => {
  const { worktree, externalParent, sentinel } = await worktreeWithLinkedCache(component)

  expect(await localModuleCacheEnv(worktree, {})).toEqual({})
  expect(await readdir(externalParent)).toEqual(['idle'])
  expect(await readFile(sentinel, 'utf8')).toBe('external-owned')
})

it('prunes ordinary expired caches while retaining the current and recent caches', async () => {
  const worktree = await worktreeWithCaches({ idle: 8, current: 8, recent: 0 })

  pruneLocalModuleCaches(localModuleCacheParent(worktree), 'current', nowMs)

  expect((await readdir(localModuleCacheParent(worktree))).sort()).toEqual(['current', 'recent'])
})

it('creates only ordinary missing cache descendants and refuses a missing root', async () => {
  const worktree = await worktreeWithCaches({})
  const parent = localModuleCacheParent(worktree)

  expect(checkedLocalModuleCacheParent(worktree, { allowMissing: true })).toBe(parent)
  expect(checkedLocalModuleCacheParent(worktree)).toBeNull()
  expect(checkedLocalModuleCacheParent(worktree, { create: true })).toBe(parent)
  expect(await readdir(parent)).toEqual([])
  expect(checkedLocalModuleCacheParent(join(worktree, 'missing'), { create: true })).toBeNull()
  expect(await readdir(worktree)).toEqual(['node_modules'])
})
