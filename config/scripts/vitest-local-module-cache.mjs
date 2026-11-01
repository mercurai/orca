import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, utimesSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

// A run that started under an older policy may still be reading its directory.
const STALE_AFTER_MS = 30 * 60_000

export function localModuleCacheParent(root) {
  return join(root, 'node_modules', '.cache', 'orca-vitest-modules')
}

export function checkedLocalModuleCacheParent(root, { create = false, allowMissing = false } = {}) {
  const base = resolve(root)
  const parent = localModuleCacheParent(base)
  const directories = [
    base,
    join(base, 'node_modules'),
    join(base, 'node_modules', '.cache'),
    parent
  ]
  try {
    for (const [index, directory] of directories.entries()) {
      let info
      try {
        info = lstatSync(directory)
      } catch (error) {
        if (error.code !== 'ENOENT' || index === 0) {
          return null
        }
        if (!create) {
          return allowMissing ? parent : null
        }
        try {
          mkdirSync(directory)
        } catch (error) {
          if (error.code !== 'EEXIST') {
            return null
          }
        }
        info = lstatSync(directory)
      }
      if (!info.isDirectory() || relative(directory, realpathSync(directory)) !== '') {
        return null
      }
    }
    return parent
  } catch {
    return null
  }
}

/** Retire directories from earlier policies so one worktree holds a single cache. */
export function pruneLocalModuleCaches(parent, keep, now = Date.now()) {
  const root = resolve(parent, '../../..')
  const checked = checkedLocalModuleCacheParent(root)
  if (!checked || relative(checked, resolve(parent)) !== '') {
    return
  }
  let names
  try {
    names = readdirSync(checked)
  } catch {
    return
  }
  for (const name of names) {
    const path = join(checked, name)
    try {
      const info = lstatSync(path)
      if (name !== keep && info.isDirectory() && now - info.mtimeMs > STALE_AFTER_MS) {
        if (checkedLocalModuleCacheParent(root) !== checked) {
          return
        }
        rmSync(path, { recursive: true, force: true, maxRetries: 3 })
      }
    } catch {}
  }
}

/**
 * Persist Vitest transforms between local runs. The policy hash covers what Vitest's
 * per-module key misses (lockfile, tsconfig, package.json, runner scripts), so any such
 * change starts a fresh directory. CI keeps its own shard-keyed cache.
 */
export async function localModuleCacheEnv(root, env = process.env) {
  if (env.CI || env.ORCA_UNIT_MODULE_CACHE_PATH || env.ORCA_LOCAL_MODULE_CACHE === '0') {
    return {}
  }
  if (!checkedLocalModuleCacheParent(root, { allowMissing: true })) {
    return {}
  }
  // Lazy: the policy hash loads TypeScript sources that reclaim, which only needs the parent, avoids.
  const { moduleCachePolicyHash } = await import('./ci-unit-module-cache.mjs')
  const key = `${(await moduleCachePolicyHash(root)).slice(0, 16)}-node${process.versions.node}`
  const parent = checkedLocalModuleCacheParent(root, { create: true })
  if (!parent) {
    return {}
  }
  pruneLocalModuleCaches(parent, key)
  const path = join(parent, key)
  try {
    try {
      mkdirSync(path)
    } catch (error) {
      if (error.code !== 'EEXIST') {
        return {}
      }
    }
    if (
      checkedLocalModuleCacheParent(root) !== parent ||
      !lstatSync(path).isDirectory() ||
      relative(path, realpathSync(path)) !== ''
    ) {
      return {}
    }
    // Reclaim (reclaim-vitest-module-caches.mjs) reads this mtime as the last run.
    const now = new Date()
    utimesSync(path, now, now)
    return { ORCA_UNIT_MODULE_CACHE_PATH: path }
  } catch {
    return {}
  }
}
