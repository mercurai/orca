import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse, parseAllDocuments } from 'yaml'

// Packages whose locked dependency closure is compiled into, or compiles, the cached addons.
export const NATIVE_MODULE_BUILD_PACKAGES = [
  'node-pty',
  '@vscode/windows-process-tree',
  '@electron/rebuild',
  'node-gyp'
]
// Only the release matters: it fixes the ABI and headers; its downloader closure does not.
export const NATIVE_MODULE_TARGET_PACKAGES = ['electron']
export const NATIVE_MODULE_WORKSPACES = ['native/windows-registry', 'native/windows-security']
// Resolution-only settings, plus patches, whose native effect already shows in snapshot ids.
const RESOLUTION_ONLY_WORKSPACE_SETTINGS = new Set([
  'addMissingPeerTypes',
  'catalog',
  'catalogs',
  'ignoredOptionalDependencies',
  'minimumReleaseAge',
  'minimumReleaseAgeExclude',
  'overrides',
  'packageExtensions',
  'patchedDependencies'
])

/** `@scope/name@1.0.0(peer@2.0.0)` -> `@scope/name`. */
function snapshotName(key) {
  const bare = key.replace(/\(.*$/, '')
  return bare.slice(0, bare.lastIndexOf('@'))
}

function versionOf(entry) {
  return typeof entry === 'string' ? entry : entry?.version
}

/** pnpm 12 splits the lockfile into a package-manager document and the project one; merge both. */
function readLockfile(contents) {
  const importers = {}
  const snapshots = {}
  const packageRecords = new Map()
  for (const document of parseAllDocuments(contents)) {
    if (document.errors.length) {
      throw document.errors[0]
    }
    const lockfile = document.toJS() ?? {}
    for (const [path, importer] of Object.entries(lockfile.importers ?? {})) {
      importers[path] = { ...importers[path], ...importer }
    }
    Object.assign(snapshots, lockfile.snapshots)
    for (const [id, record] of Object.entries(lockfile.packages ?? {})) {
      const records = packageRecords.get(id) ?? []
      records.push(record)
      packageRecords.set(id, records)
    }
  }
  return { importers, snapshots, packageRecords }
}

/** Sorted snapshot ids (versions and patch hashes) a set of native packages build from. */
export function nativeDependencyClosure(contents, selection = {}) {
  return closureFromLockfile(readLockfile(contents), selection)
}

function closureFromLockfile(
  { importers, snapshots },
  { packages, versionOnly = [], workspaces = [] } = {}
) {
  const names = Object.keys(snapshots).map(snapshotName)
  const unlocked = [...packages, ...versionOnly].filter((name) => !names.includes(name))
  if (unlocked.length > 0) {
    // Fail closed: a package that silently stopped matching would drop out of the key.
    throw new Error(`pnpm-lock.yaml locks none of ${unlocked.join(', ')}`)
  }
  const pending = Object.keys(snapshots).filter((key) => packages.includes(snapshotName(key)))
  for (const workspace of workspaces) {
    const importer = importers[workspace]
    if (!importer) {
      throw new Error(`pnpm-lock.yaml has no importer for ${workspace}`)
    }
    for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
      for (const [name, entry] of Object.entries(importer[field] ?? {})) {
        const version = versionOf(entry)
        if (!version.startsWith('link:')) {
          pending.push(`${name}@${version}`)
        }
      }
    }
  }
  const visited = new Set()
  while (pending.length > 0) {
    const key = pending.pop()
    if (visited.has(key)) {
      continue
    }
    const snapshot = snapshots[key]
    if (!snapshot) {
      throw new Error(`pnpm-lock.yaml has no snapshot for ${key}`)
    }
    visited.add(key)
    for (const field of ['dependencies', 'optionalDependencies']) {
      for (const [name, version] of Object.entries(snapshot[field] ?? {})) {
        pending.push(`${name}@${version}`)
      }
    }
  }
  for (const key of Object.keys(snapshots)) {
    if (versionOnly.includes(snapshotName(key))) {
      visited.add(key.replace(/\(.*$/, ''))
    }
  }
  return [...visited].sort()
}

function isPlainRecord(value) {
  return (
    value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
}

function canonical(value, active = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if ((!Array.isArray(value) && !isPlainRecord(value)) || active.has(value)) {
    throw new Error('Native lock metadata contains unsupported non-JSON values')
  }
  active.add(value)
  const result = Array.isArray(value)
    ? value.map((entry) => canonical(entry, active))
    : Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, canonical(value[key], active)])
      )
  active.delete(value)
  return result
}

function lockedPackageMetadata(closure, packageRecords) {
  const ids = [...new Set(closure.map((key) => key.replace(/\(.*$/, '')))].sort()
  return ids.map((id) => {
    const records = packageRecords.get(id)
    if (!records?.length) {
      throw new Error(`pnpm-lock.yaml has no package metadata for ${id}`)
    }
    const metadata = records.map((record) => {
      if (!isPlainRecord(record) || !isPlainRecord(record.resolution)) {
        throw new Error(`pnpm-lock.yaml has invalid package resolution metadata for ${id}`)
      }
      const resolution = record.resolution
      const locators = ['integrity', 'tarball'].filter((key) => Object.hasOwn(resolution, key))
      if (
        locators.length === 0 ||
        locators.some((key) =>
          typeof resolution[key] !== 'string' || resolution[key].trim().length === 0
        ) ||
        Object.hasOwn(resolution, 'directory') ||
        resolution.type === 'directory' ||
        (Object.hasOwn(resolution, 'tarball') && !/^https?:\/\//.test(resolution.tarball))
      ) {
        throw new Error(`pnpm-lock.yaml has unsupported or empty package resolution metadata for ${id}`)
      }
      return canonical(record)
    })
    if (metadata.some((record) => JSON.stringify(record) !== JSON.stringify(metadata[0]))) {
      throw new Error(`pnpm-lock.yaml has conflicting package metadata for ${id}`)
    }
    return { id, metadata: metadata[0] }
  })
}

/** pnpm-workspace.yaml minus resolution-only settings, with build approvals for `closure` only. */
export function nativeWorkspaceSettings(contents, closure) {
  const names = new Set(closure.map(snapshotName))
  return Object.fromEntries(
    Object.entries(parse(contents) ?? {})
      .filter(([setting]) => !RESOLUTION_ONLY_WORKSPACE_SETTINGS.has(setting))
      .map(([setting, value]) =>
        setting === 'allowBuilds' && value && typeof value === 'object'
          ? [setting, Object.fromEntries(Object.entries(value).filter(([name]) => names.has(name)))]
          : [setting, value]
      )
      .sort(([left], [right]) => left.localeCompare(right))
  )
}

export function nativeDependencyLockDigest({
  repository = resolve(import.meta.dirname, '../..'),
  ...selection
}) {
  const lockfile = readLockfile(readFileSync(join(repository, 'pnpm-lock.yaml'), 'utf8'))
  const closure = closureFromLockfile(lockfile, selection)
  const settings = nativeWorkspaceSettings(
    readFileSync(join(repository, 'pnpm-workspace.yaml'), 'utf8'),
    closure
  )
  const lockedPackages = lockedPackageMetadata(closure, lockfile.packageRecords)
  const digest = createHash('sha256')
    .update(JSON.stringify(canonical({ closure, settings, lockedPackages })))
    .digest('hex')
  return { digest, closure }
}

if (process.argv[1]?.endsWith('native-dependency-lock-digest.mjs')) {
  const { digest, closure } = nativeDependencyLockDigest({
    packages: NATIVE_MODULE_BUILD_PACKAGES,
    versionOnly: NATIVE_MODULE_TARGET_PACKAGES,
    workspaces: NATIVE_MODULE_WORKSPACES
  })
  console.error(`[native-cache] locked inputs: ${closure.join(' ')}`)
  console.log(digest)
}
