/**
 * Boots the distro of the WSL host the last run had focused, at the very start of the next launch,
 * so the boot (seconds on a slow PC) overlaps the app's own startup instead of following it. Only
 * the focused host is listed (E9: a launch boots the focused host, never others with saved tabs).
 */
import { join } from 'node:path'
import { z } from 'zod'
import { spawnProcess } from '@orca/process-host'
import { writeSecureJsonFileWithinLimitAsync } from '../../shared/bounded-secure-json-file'
import {
  readNodeFileSyncWithinLimit,
  readNodeFileWithinLimit
} from '../../shared/node-bounded-file-reader'
import { serializePathWrite } from '../../shared/path-write-serializer'
import {
  removeSecureFile,
  SecureWriteDiscardedError,
  SecureWriteSupersededError
} from '../../shared/secure-file-async-write'
import { readWslHostDeployments } from '../../shared/wsl-host-deployment-store'
import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'
import { WslDistroNameSchema } from '../../shared/wsl-host-deployment-link'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'
import { wslDistroHolderKey } from './wsl-distro-holder-record'
import { resolveWslExecutablePath } from './wsl-executable-path'

const WAKE_FILE = 'orca-wsl-host-wake.json'
const MAX_WAKE_FILE_BYTES = 16 * 1024

const WakeListSchema = z.object({ version: z.literal(1), distros: z.array(WslDistroNameSchema) })

function wakeFile(userDataPath: string): string {
  return join(userDataPath, WAKE_FILE)
}

function readWakeList(userDataPath: string): string[] {
  try {
    const { buffer } = readNodeFileSyncWithinLimit(wakeFile(userDataPath), MAX_WAKE_FILE_BYTES)
    return WakeListSchema.parse(JSON.parse(buffer.toString('utf8'))).distros
  } catch {
    return []
  }
}

type WakeIntent = {
  desired: string[] | null
  removed: Set<string>
  disabled: boolean
  deleted: boolean
  revision: number
  pending: number
}

// Only profiles with an unsettled mutation stay here; this is not a persisted-list cache.
const activeIntents = new Map<string, WakeIntent>()

async function readWakeListAsync(path: string): Promise<string[]> {
  try {
    const { buffer } = await readNodeFileWithinLimit(path, MAX_WAKE_FILE_BYTES)
    return WakeListSchema.parse(JSON.parse(buffer.toString('utf8'))).distros
  } catch {
    return []
  }
}

async function persistWakeIntent(
  path: string,
  intent: WakeIntent,
  revision: number
): Promise<void> {
  const current = (): boolean => intent.revision === revision
  if (!current() || (intent.disabled && intent.deleted)) {
    return
  }
  const saved = await readWakeListAsync(path)
  if (!current()) {
    return
  }
  const next =
    intent.desired ?? saved.filter((distro) => !intent.removed.has(wslDistroHolderKey(distro)))
  if (
    !intent.disabled &&
    saved.length === next.length &&
    saved.every((distro, index) => distro === next[index])
  ) {
    return
  }
  await writeSecureJsonFileWithinLimitAsync(
    path,
    { version: 1, distros: next },
    MAX_WAKE_FILE_BYTES,
    {
      shouldPublish: current
    }
  )
}

function updateWakeIntent(
  userDataPath: string,
  update: (intent: WakeIntent, path: string) => void
): Promise<void> {
  const path = wakeFile(userDataPath)
  let intent = activeIntents.get(path)
  if (!intent) {
    intent = {
      desired: null,
      removed: new Set(),
      disabled: false,
      deleted: false,
      revision: 0,
      pending: 0
    }
    activeIntents.set(path, intent)
  }
  update(intent, path)
  const revision = ++intent.revision
  intent.pending += 1
  const owner = intent
  // Register the whole read/compare/write before its first await so quit can drain it.
  return serializePathWrite(`${path}#wake-mutation`, () => persistWakeIntent(path, owner, revision))
    .catch((error: unknown) => {
      if (
        error instanceof SecureWriteDiscardedError ||
        error instanceof SecureWriteSupersededError
      ) {
        return
      }
      console.warn('[wsl-hosts] Could not save the distros to wake at next launch:', error)
    })
    .finally(() => {
      owner.pending -= 1
      if (owner.pending === 0 && activeIntents.get(path) === owner) {
        activeIntents.delete(path)
      }
    })
}

/** Saves the focused host without blocking the IPC thread on its profile file. */
export function rememberWslHostsToWake(
  userDataPath: string,
  distros: readonly string[]
): Promise<void> {
  return updateWakeIntent(userDataPath, (intent) => {
    intent.desired = [...new Set(distros)].sort()
    intent.removed.clear()
    intent.disabled = false
    intent.deleted = false
  })
}

/** Revokes queued saves before deleting the next launch's early-wake intent. */
export function forgetWslHostsToWake(userDataPath: string): Promise<void> {
  return updateWakeIntent(userDataPath, (intent, path) => {
    intent.desired = []
    intent.removed.clear()
    intent.disabled = true
    try {
      removeSecureFile(path)
      intent.deleted = true
    } catch (error) {
      intent.deleted = false
      console.warn('[wsl-hosts] Could not delete the early-wake list; emptying it:', error)
    }
  })
}

/** Removes only this host, including from a focused-host save that has not reached disk yet. */
export function forgetWslHostToWake(userDataPath: string, distro: string): Promise<void> {
  const key = wslDistroHolderKey(distro)
  return updateWakeIntent(userDataPath, (intent) => {
    intent.removed.add(key)
    if (intent.desired) {
      intent.desired = intent.desired.filter((entry) => wslDistroHolderKey(entry) !== key)
    }
  })
}

export type WslWakeSpawn = (distro: string) => void

function spawnWake(distro: string): void {
  const child = spawnProcess({
    program: resolveWslExecutablePath(),
    args: buildWslExecArgs(distro, ['true']),
    cwd: resolveWslInteropSpawnCwd(),
    env: { ...process.env, WSL_UTF8: '1' },
    stdio: 'ignore'
  })
  child.on('error', () => {})
  child.unref()
}

/**
 * Starts booting each remembered distro that is still a registered WSL host. Fire and forget: the
 * connect that follows does the real work and reports any failure.
 */
export function wakeRememberedWslHosts(
  userDataPath: string,
  spawn: WslWakeSpawn = spawnWake
): string[] {
  const intent = activeIntents.get(wakeFile(userDataPath))
  const remembered = intent?.disabled
    ? []
    : readWakeList(userDataPath).filter(
        (distro) => !intent?.removed.has(wslDistroHolderKey(distro))
      )
  if (remembered.length === 0) {
    return []
  }
  let registered: Set<string>
  try {
    // A host whose Remove is pending must not be booted: that would undo its stop's proof.
    registered = new Set(
      readWslHostDeployments(userDataPath)
        .deployments.filter((record) => !record.pendingStop)
        .map((record) => wslDistroHolderKey(record.distro))
    )
  } catch {
    return []
  }
  const woken = remembered.filter((distro) => registered.has(wslDistroHolderKey(distro)))
  for (const distro of woken) {
    try {
      spawn(distro)
    } catch (error) {
      console.warn(`[wsl-hosts] Could not start waking ${distro}:`, error)
    }
  }
  return woken
}
