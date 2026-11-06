import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, win32 } from 'node:path'
import { resolveWindowsCmdShim } from './windows-cmd-shim-resolution'
import {
  isAbsoluteWindowsCodexPath,
  readBoundedWindowsCodexFile,
  resolveWindowsCodexNativeInstall,
  sameWindowsCodexPath
} from './windows-codex-native-install'

export type WindowsCodexNativeFallbackReason =
  | 'unsupported_context'
  | 'unrecognized_launcher'
  | 'unverified_install'
  | 'native_unavailable'
  | 'resolver_failure'

export type WindowsCodexNativeEnvironmentDelta = {
  managedPackageRoot: string
  manager: 'npm'
}

export type WindowsCodexNativeLaunchResult =
  | {
      outcome: 'native'
      nativeExecutable: string
      environmentDelta: WindowsCodexNativeEnvironmentDelta
    }
  | { outcome: 'fallback'; reason: WindowsCodexNativeFallbackReason }

export type ResolveWindowsCodexNativeLaunchOptions = {
  launcher: string
  node?: string
  env: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  customNodeEnv?: boolean
}

const MAX_SHIM_BYTES = 64 * 1024
const NPM_SHELL_SHA256 = '4a32e1d78c9645ce143f478939a813283aa6c3f3c2f9988658a1e09c66c501c3'
const NPM_POWERSHELL_SHA256 = '96fb9eb7969ccc722a05c38212b87dab2854b81a88d43308cc9cd4d3cda6b01c'
const MANAGER_FLAGS = [
  'CODEX_MANAGED_BY_NPM',
  'CODEX_MANAGED_BY_BUN',
  'CODEX_MANAGED_BY_PNPM',
  'CODEX_MANAGED_BY_VITE_PLUS',
  'CODEX_MANAGED_PACKAGE_ROOT'
]

type SelectedLaunch = { entrypoint: string; node: string }

function fallback(reason: WindowsCodexNativeFallbackReason): WindowsCodexNativeLaunchResult {
  return { outcome: 'fallback', reason }
}

function envValues(env: NodeJS.ProcessEnv, name: string): string[] {
  const lowerName = name.toLowerCase()
  return Object.keys(env)
    .filter((key) => key.toLowerCase() === lowerName)
    .map((key) => env[key])
    .filter((value): value is string => typeof value === 'string')
}

function hasNonemptyEnv(env: NodeJS.ProcessEnv, name: string): boolean {
  return envValues(env, name).some((value) => value.length > 0)
}

function selectLauncher(
  options: ResolveWindowsCodexNativeLaunchOptions
): SelectedLaunch | { fallback: WindowsCodexNativeLaunchResult } {
  const launcher = win32.resolve(options.launcher)
  const extension = win32.extname(launcher).toLowerCase()
  if (extension === '.cmd') {
    const shim = resolveWindowsCmdShim(launcher, options.env)
    if (!shim || shim.prefixArgs.length !== 1) {
      return { fallback: fallback('unrecognized_launcher') }
    }
    const entrypoint = shim.prefixArgs[0]
    if (!entrypoint) {
      return { fallback: fallback('unrecognized_launcher') }
    }
    if (shim.env || !shim.program.toLowerCase().endsWith('.exe')) {
      return { fallback: fallback('unverified_install') }
    }
    if (
      options.node !== undefined &&
      (!isAbsoluteWindowsCodexPath(options.node) ||
        !sameWindowsCodexPath(options.node, shim.program))
    ) {
      return { fallback: fallback('unverified_install') }
    }
    return { entrypoint, node: shim.program }
  }

  if (extension !== '' && extension !== '.ps1') {
    return { fallback: fallback('unrecognized_launcher') }
  }
  const launcherBytes = readBoundedWindowsCodexFile(launcher, MAX_SHIM_BYTES)
  if (!launcherBytes) {
    return { fallback: fallback('unrecognized_launcher') }
  }
  const canonicalText = launcherBytes
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
  const launcherHash = createHash('sha256').update(canonicalText).digest('hex')
  const expectedHash = extension === '.ps1' ? NPM_POWERSHELL_SHA256 : NPM_SHELL_SHA256
  if (launcherHash !== expectedHash) {
    return { fallback: fallback('unrecognized_launcher') }
  }
  const siblingNode = win32.join(dirname(launcher), 'node')
  const siblingNodeExe = win32.join(dirname(launcher), 'node.exe')
  let selectedSibling: string | undefined
  if (extension === '.ps1') {
    selectedSibling = existsSync(siblingNodeExe) ? siblingNodeExe : undefined
  } else if (existsSync(siblingNode)) {
    selectedSibling = siblingNode
  } else {
    selectedSibling = existsSync(siblingNodeExe) ? siblingNodeExe : undefined
  }
  let node: string
  if (options.node !== undefined && !isAbsoluteWindowsCodexPath(options.node)) {
    return { fallback: fallback('unverified_install') }
  }
  if (selectedSibling) {
    if (options.node !== undefined && !sameWindowsCodexPath(options.node, selectedSibling)) {
      return { fallback: fallback('unverified_install') }
    }
    node = selectedSibling
  } else if (options.node && isAbsoluteWindowsCodexPath(options.node)) {
    node = options.node
  } else {
    return { fallback: fallback('unverified_install') }
  }
  return {
    entrypoint: win32.resolve(
      dirname(launcher),
      'node_modules',
      '@openai',
      'codex',
      'bin',
      'codex.js'
    ),
    node
  }
}

export function resolveWindowsCodexNativeLaunch(
  options: ResolveWindowsCodexNativeLaunchOptions
): WindowsCodexNativeLaunchResult {
  if ((options.platform ?? process.platform) !== 'win32') {
    return fallback('unsupported_context')
  }
  if (!isAbsoluteWindowsCodexPath(options.launcher)) {
    return fallback('unrecognized_launcher')
  }
  if (
    options.customNodeEnv ||
    hasNonemptyEnv(options.env, 'NODE_OPTIONS') ||
    hasNonemptyEnv(options.env, 'NODE_PATH') ||
    hasNonemptyEnv(options.env, 'ORCA_NODE_OPTIONS') ||
    envValues(options.env, 'ORCA_DISABLE_CODEX_NATIVE_LAUNCH').includes('1') ||
    hasNonemptyEnv(options.env, 'ORCA_DISABLE_CMD_SHIM_RESOLUTION')
  ) {
    return fallback('unverified_install')
  }

  try {
    const selected = selectLauncher(options)
    if ('fallback' in selected) {
      return selected.fallback
    }
    const expectedEntry = win32.resolve(
      dirname(win32.resolve(options.launcher)),
      'node_modules',
      '@openai',
      'codex',
      'bin',
      'codex.js'
    )
    if (!sameWindowsCodexPath(selected.entrypoint, expectedEntry)) {
      return fallback('unrecognized_launcher')
    }
    const install = resolveWindowsCodexNativeInstall(
      selected.entrypoint,
      selected.node,
      options.env
    )
    if ('fallbackReason' in install) {
      return fallback(install.fallbackReason)
    }
    return {
      outcome: 'native',
      nativeExecutable: install.nativeExecutable,
      environmentDelta: { managedPackageRoot: install.managedPackageRoot, manager: 'npm' }
    }
  } catch {
    return fallback('resolver_failure')
  }
}

export function applyWindowsCodexNativeEnvironment(
  env: NodeJS.ProcessEnv,
  delta: WindowsCodexNativeEnvironmentDelta
): NodeJS.ProcessEnv {
  const managedNames = new Set(MANAGER_FLAGS.map((name) => name.toLowerCase()))
  const childEnv: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (!managedNames.has(key.toLowerCase())) {
      childEnv[key] = value
    }
  }
  childEnv.CODEX_MANAGED_PACKAGE_ROOT = delta.managedPackageRoot
  childEnv.CODEX_MANAGED_BY_NPM = '1'
  return childEnv
}
