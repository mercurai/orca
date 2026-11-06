import { createHash } from 'node:crypto'
import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  type Stats
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, win32 } from 'node:path'
import { PE_MACHINE, readPeMachine } from './windows-pe-machine.cjs'
import { hasUnsupportedWindowsCodexOwner } from './windows-codex-native-owner'

export type WindowsCodexNativeInstallResult =
  | { nativeExecutable: string; managedPackageRoot: string }
  | { fallbackReason: 'unverified_install' | 'native_unavailable' }

type CodexWindowsMachine = 'x64' | 'arm64'
type JsonObject = Record<string, unknown>

const MAX_LAUNCHER_BYTES = 16 * 1024
const MAX_MANIFEST_BYTES = 64 * 1024
const CODEX_PACKAGE_NAME = '@openai/codex'
const CODEX_PACKAGE_VERSION = '0.166.0'
const CODEX_LAUNCHER_SHA256 = 'e14fc83739c13c1074b12bd1acce4010c893c7f6fbfc1593b4a31d74cabb57af'

export function readBoundedWindowsCodexFile(path: string, maxBytes: number): Buffer | null {
  const fd = openSync(path, 'r')
  try {
    const stats = fstatSync(fd)
    if (!stats.isFile() || stats.size > maxBytes) {
      return null
    }
    const buffer = Buffer.alloc(maxBytes + 1)
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0)
    if (bytesRead !== stats.size || bytesRead > maxBytes) {
      return null
    }
    return Buffer.from(buffer.subarray(0, bytesRead))
  } finally {
    closeSync(fd)
  }
}

export function isAbsoluteWindowsCodexPath(path: string): boolean {
  return win32.isAbsolute(path) && win32.parse(path).root.length > 1
}

export function sameWindowsCodexPath(left: string, right: string): boolean {
  return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase()
}

function isWithinWindowsPath(parent: string, child: string): boolean {
  const relative = win32.relative(win32.resolve(parent).toLowerCase(), win32.resolve(child).toLowerCase())
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${win32.sep}`) && !win32.isAbsolute(relative))
  )
}

function fileStats(path: string): Stats | null {
  try {
    const stats = statSync(path)
    return stats.isFile() ? stats : null
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJsonFile(path: string): JsonObject | null {
  const bytes = readBoundedWindowsCodexFile(path, MAX_MANIFEST_BYTES)
  if (!bytes) {
    return null
  }
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

function hasString(value: unknown, expected: string): boolean {
  return value === expected
}

function hasStringArrayItem(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.some((item) => item === expected)
}

function machineArchitecture(machine: number | null): CodexWindowsMachine | null {
  if (machine === PE_MACHINE.x64) {
    return 'x64'
  }
  if (machine === PE_MACHINE.arm64) {
    return 'arm64'
  }
  return null
}

function validateRootManifest(packageRoot: string, path: string): JsonObject | null {
  const manifest = readJsonFile(path)
  if (
    !manifest ||
    !hasString(manifest.name, CODEX_PACKAGE_NAME) ||
    !hasString(manifest.version, CODEX_PACKAGE_VERSION) ||
    !hasString(manifest.type, 'module') ||
    !isRecord(manifest.bin) ||
    !hasString(manifest.bin.codex, 'bin/codex.js') ||
    !isWithinWindowsPath(packageRoot, realpathSync(path))
  ) {
    return null
  }
  return manifest
}

function validatePlatformManifest(
  manifest: JsonObject,
  architecture: CodexWindowsMachine
): boolean {
  const suffix = `win32-${architecture}`
  const alias = `@openai/codex-${suffix}`
  return (
    isRecord(manifest.optionalDependencies) &&
    hasString(
      manifest.optionalDependencies[alias],
      `npm:${CODEX_PACKAGE_NAME}@${CODEX_PACKAGE_VERSION}-${suffix}`
    )
  )
}

type NativeExecutableResult =
  | { nativeExecutable: string }
  | { fallbackReason: 'unverified_install' | 'native_unavailable' }

function resolveNativeExecutable(
  entrypoint: string,
  packageRoot: string,
  packageRootCanonical: string,
  manifest: JsonObject,
  architecture: CodexWindowsMachine
): NativeExecutableResult {
  if (!validatePlatformManifest(manifest, architecture)) {
    return { fallbackReason: 'unverified_install' }
  }
  const suffix = `win32-${architecture}`
  const alias = `@openai/codex-${suffix}`
  let platformManifestPath: string
  try {
    platformManifestPath = createRequire(entrypoint).resolve(`${alias}/package.json`)
  } catch {
    return { fallbackReason: 'native_unavailable' }
  }
  const expectedManifest = join(packageRoot, 'node_modules', alias, 'package.json')
  if (!fileStats(expectedManifest)) {
    return { fallbackReason: 'native_unavailable' }
  }
  const resolvedManifestCanonical = realpathSync(platformManifestPath)
  const expectedManifestCanonical = realpathSync(expectedManifest)
  if (
    !sameWindowsCodexPath(resolvedManifestCanonical, expectedManifestCanonical) ||
    !isWithinWindowsPath(packageRootCanonical, resolvedManifestCanonical)
  ) {
    return { fallbackReason: 'unverified_install' }
  }
  const platformManifest = readJsonFile(platformManifestPath)
  if (
    !platformManifest ||
    !hasString(platformManifest.name, CODEX_PACKAGE_NAME) ||
    !hasString(platformManifest.version, `${CODEX_PACKAGE_VERSION}-${suffix}`) ||
    !hasStringArrayItem(platformManifest.os, 'win32') ||
    !hasStringArrayItem(platformManifest.cpu, architecture)
  ) {
    return { fallbackReason: 'unverified_install' }
  }
  const platformRoot = dirname(platformManifestPath)
  const canonicalPlatformRoot = realpathSync(platformRoot)
  const triple = architecture === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc'
  const nativeExecutable = win32.join(platformRoot, 'vendor', triple, 'bin', 'codex.exe')
  if (!fileStats(nativeExecutable)) {
    return { fallbackReason: 'native_unavailable' }
  }
  const canonicalExecutable = realpathSync(nativeExecutable)
  if (
    !isWithinWindowsPath(packageRootCanonical, canonicalPlatformRoot) ||
    !isWithinWindowsPath(canonicalPlatformRoot, canonicalExecutable)
  ) {
    return { fallbackReason: 'unverified_install' }
  }
  return readPeMachine(nativeExecutable) === PE_MACHINE[architecture]
    ? { nativeExecutable }
    : { fallbackReason: 'native_unavailable' }
}

export function resolveWindowsCodexNativeInstall(
  entrypoint: string,
  node: string,
  env: NodeJS.ProcessEnv
): WindowsCodexNativeInstallResult {
  const packageRoot = win32.dirname(win32.dirname(entrypoint))
  if (win32.relative(packageRoot, entrypoint).toLowerCase() !== 'bin\\codex.js') {
    return { fallbackReason: 'unverified_install' }
  }
  const canonicalPackageRoot = realpathSync(packageRoot)
  const canonicalEntrypoint = realpathSync(entrypoint)
  if (!isWithinWindowsPath(canonicalPackageRoot, canonicalEntrypoint)) {
    return { fallbackReason: 'unverified_install' }
  }
  const launcherBytes = readBoundedWindowsCodexFile(entrypoint, MAX_LAUNCHER_BYTES)
  if (
    !launcherBytes ||
    createHash('sha256').update(launcherBytes).digest('hex') !== CODEX_LAUNCHER_SHA256
  ) {
    return { fallbackReason: 'unverified_install' }
  }

  const rootManifestPath = join(packageRoot, 'package.json')
  const rootManifest = validateRootManifest(canonicalPackageRoot, rootManifestPath)
  if (!rootManifest || !fileStats(node)) {
    return { fallbackReason: rootManifest ? 'native_unavailable' : 'unverified_install' }
  }
  const architecture = machineArchitecture(readPeMachine(node))
  if (!architecture) {
    return { fallbackReason: 'native_unavailable' }
  }
  if (hasUnsupportedWindowsCodexOwner(canonicalPackageRoot, entrypoint, env)) {
    return { fallbackReason: 'unverified_install' }
  }

  const native = resolveNativeExecutable(
    entrypoint,
    packageRoot,
    canonicalPackageRoot,
    rootManifest,
    architecture
  )
  if ('fallbackReason' in native) {
    return native
  }
  return { ...native, managedPackageRoot: canonicalPackageRoot }
}
