import { existsSync } from 'node:fs'
import path from 'node:path'
import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import { parseWslPath } from '../../wsl'
import { isWslDirectGitReadCommand } from '../wsl-direct-git-read-commands'
import {
  disableWslGitReadEnvironment,
  getWslGitReadEnvironment,
  invalidateWslGitReadEnvironment,
  isWslGitReadEnvironmentSettled,
  peekWslGitReadEnvironment,
  WSL_GIT_READ_ENVIRONMENT_WAIT_MS
} from '../wsl-git-read-environment'
import { usesHostGitForWslLinkedWorktree } from '../wsl-linked-worktree-git-routing'
import { withWslWindowsCheckoutGitConfig } from '../wsl-windows-checkout-git-config'
import { resolveWslExecutablePath } from '../../wsl/wsl-executable-path'
import { resolveCommand, type ResolvedCommand } from './wsl-command-resolution'
import type { GitExecOptions } from './git-exec-options'

// Linux Git needs Windows-checkout settings; classify original args and inject only at spawn.
function wslGitArgs(args: string[], options: GitExecOptions): string[] {
  return withWslWindowsCheckoutGitConfig(args, options.cwd, options.wslDistro)
}

/** The WSL distro a Git command with this cwd runs in, or null when it runs on the host. */
export function wslDistroForCommand(cwd: string | undefined, override?: string): string | null {
  if (process.platform !== 'win32') {
    return null
  }
  return (cwd ? parseWslPath(cwd)?.distro : undefined) ?? override ?? null
}

const BARE_HOST_BINARIES = new Set(['git', 'gh', 'wsl.exe'])
const MAX_PATH_GENERATIONS = 8
// Why PATH-keyed: shell-PATH hydration rewrites PATH, so a new PATH is a new generation.
const hostBinariesByPath = new Map<string, Map<string, string>>()

function searchPathForExecutable(binary: string, pathValue: string): string | null {
  // Why this order: libuv's search tries .com before .exe, and skips relative PATH entries here.
  for (const entry of pathValue.split(';')) {
    const dir = entry.replace(/^"(.*)"$/, '$1')
    for (const extension of ['.com', '.exe']) {
      const candidate = path.join(dir, binary + extension)
      if (dir && path.isAbsolute(candidate) && existsSync(candidate)) {
        return candidate
      }
    }
  }
  return null
}

/**
 * Absolute path for a bare git, gh or wsl.exe on Windows, found once per PATH generation, so
 * CreateProcess stops searching a long hydrated PATH on every spawn. Anything else, and a
 * binary that is not found, comes back unchanged for the OS to resolve as before.
 */
export function resolveHostBinaryOnce(
  binary: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (process.platform !== 'win32' || !BARE_HOST_BINARIES.has(binary)) {
    return binary
  }
  if (binary === 'wsl.exe') {
    return resolveWslExecutablePath()
  }
  const pathValue = env.PATH ?? env.Path ?? ''
  let resolved = hostBinariesByPath.get(pathValue)
  if (!resolved) {
    if (hostBinariesByPath.size >= MAX_PATH_GENERATIONS) {
      hostBinariesByPath.clear()
    }
    resolved = new Map()
    hostBinariesByPath.set(pathValue, resolved)
  }
  const known = resolved.get(binary)
  // Why re-stat a hit: PATH stays the same when the binary is removed or moved.
  if (known !== undefined && (known === binary || existsSync(known))) {
    return known
  }
  // A miss is cached too, so a host without gh does not search the PATH on every call.
  const found = searchPathForExecutable(binary, pathValue) ?? binary
  resolved.set(binary, found)
  return found
}

export function resolveGitCommand(
  args: string[],
  options: GitExecOptions,
  forceLoginShell = false,
  captureLoginShellOutput = false
): ResolvedCommand {
  return withAbsoluteBinary(
    resolveGitCommandUnresolved(args, options, forceLoginShell, captureLoginShellOutput),
    options.env
  )
}

function withAbsoluteBinary(resolved: ResolvedCommand, env?: NodeJS.ProcessEnv): ResolvedCommand {
  const binary = resolveHostBinaryOnce(resolved.binary, env)
  return binary === resolved.binary ? resolved : { ...resolved, binary }
}

function resolveGitCommandUnresolved(
  args: string[],
  options: GitExecOptions,
  forceLoginShell: boolean,
  captureLoginShellOutput: boolean
): ResolvedCommand {
  if (usesHostGitForWslLinkedWorktree(options.cwd, options.wslDistro)) {
    // Why: WSL Git resolves a Windows-authored linked-worktree pointer relative to cwd.
    return { binary: 'git', args, cwd: options.cwd, wsl: null, wslMode: null }
  }
  const distro = directWslGitReadDistro(args, options, forceLoginShell)
  if (distro) {
    const environment = peekWslGitReadEnvironment(distro)
    if (environment) {
      return resolveCommand('git', wslGitArgs(args, options), options.cwd, distro, {
        wslGitReadEnvironment: environment,
        env: options.env,
        terminationBarrier: options.terminationBarrier
      })
    }
    void getWslGitReadEnvironment(distro)
  }
  return resolveGitCommandWithoutProbe(args, options, captureLoginShellOutput)
}

/** Infer the direct-read distro from overrides or UNC cwd so plain reads can bypass login rc output. */
function directWslGitReadDistro(
  args: string[],
  options: GitExecOptions,
  forceLoginShell: boolean
): string | null {
  if (forceLoginShell || !shouldAttemptWslDirectGit(args, options)) {
    return null
  }
  return wslDistroForCommand(options.cwd, options.wslDistro)
}

function shouldAttemptWslDirectGit(args: string[], options: GitExecOptions): boolean {
  return Boolean(
    process.platform === 'win32' &&
    // Known reads need no login environment; explicit callers may also opt in.
    (options.preferWslDirectGit || isWslDirectGitReadCommand(args)) &&
    !options.useConfiguredSshCommandForNetwork &&
    !Object.entries(options.env ?? {}).some(
      ([key, value]) =>
        key.startsWith('GIT_') && key !== 'GIT_OPTIONAL_LOCKS' && value !== process.env[key]
    )
  )
}

/** Wait once per distro for direct-read setup, bounded so cold or wedged WSL falls back to a login shell. */
export function pendingWslDirectGitReadEnvironment(
  args: string[],
  options: GitExecOptions
): Promise<unknown> | null {
  // Return null for settled/aborted probes: even awaiting a resolved promise would defer native spawning.
  const distro = directWslGitReadDistro(args, options, false)
  if (!distro || isWslGitReadEnvironmentSettled(distro) || options.signal?.aborted) {
    return null
  }
  // Absorb probe failures so setup cannot fail the read.
  return withTimeout(
    waitForPromiseWithSignal(getWslGitReadEnvironment(distro), options.signal),
    WSL_GIT_READ_ENVIRONMENT_WAIT_MS,
    null
  )
}

export function resolveGitCommandWithoutProbe(
  args: string[],
  options: GitExecOptions,
  captureLoginShellOutput = false
): ResolvedCommand {
  const resolved = resolveCommand(
    'git',
    wslGitArgs(args, options),
    options.cwd,
    options.wslDistro,
    {
      useWslLoginShell: Boolean(options.wslDistro),
      captureLoginShellOutput,
      env: options.env,
      terminationBarrier: options.terminationBarrier
    }
  )
  return withAbsoluteBinary(resolved, options.env)
}

function isDirectWslGitNotFound(error: unknown, resolved: ResolvedCommand): boolean {
  if (resolved.wslMode !== 'direct-git' || !error || typeof error !== 'object') {
    return false
  }
  const { code, stderr } = error as { code?: unknown; stderr?: unknown }
  const message = typeof stderr === 'string' ? stderr : String(stderr ?? '')
  return code === 127 && (message.includes('not found') || message.includes('No such file'))
}

export function directWslGitExitCode(error: unknown, resolved: ResolvedCommand): number | null {
  if (resolved.wslMode !== 'direct-git' || !error || typeof error !== 'object') {
    return null
  }
  const code = (error as { code?: unknown }).code
  return typeof code === 'number' ? code : null
}

/** Quiet exit 1 is Git control flow; WSL launch errors include diagnostics and may need shell fallback. */
export function isQuietGitControlFlowExit(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const record = error as Record<string, unknown>
  if (record.code !== 1) {
    return false
  }
  const stderr = record.stderr
  return stderr !== undefined && stderr !== null && String(stderr).trim().length === 0
}

export function invalidateMissingDirectWslGit(error: unknown, resolved: ResolvedCommand): boolean {
  const isMissing = isDirectWslGitNotFound(error, resolved)
  if (isMissing && resolved.wsl) {
    invalidateWslGitReadEnvironment(resolved.wsl.distro)
  }
  return isMissing
}

export function disableDirectWslGitAfterSuccessfulFallback(
  wasMissing: boolean,
  resolved: ResolvedCommand
): void {
  if (!wasMissing && resolved.wsl) {
    disableWslGitReadEnvironment(resolved.wsl.distro)
  }
}
