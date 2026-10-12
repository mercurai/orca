/**
 * The activation fence tokens this desktop's processes hold, kept beside the profile so a later
 * launch can tell a fence its own quit or crash left from one another desktop holds (BUG-23).
 * Best effort: a lost entry only costs the early reclaim, never a fence operation.
 */
import { readFileSync } from 'node:fs'
import { hostname, uptime } from 'node:os'
import { dirname, join } from 'node:path'
import { writeSecureFileAsync } from '../../shared/secure-file-async-write'
import { serializePathWrite } from '../../shared/path-write-serializer'

export const ORCAD_HELD_FENCE_TOKENS_FILE_NAME = 'orcad-held-fence-tokens.json'
// Older entries are leaks from releases never confirmed; the fence went stale long ago anyway.
const MAX_AGE_MS = 24 * 60 * 60_000
// Boot time from uptime drifts by the clock's resolution; a reboot moves it far more.
const BOOT_TOLERANCE_MS = 60_000

/** `host` and `bootedAt` pin the pid to one machine and one boot: a shared profile dir is not. */
type HeldFence = { token: string; pid: number; host: string; bootedAt: number; at: number }

let file: string | null = null

export function initOrcadHeldFenceTokenFile(dataFile: string): void {
  file = join(dirname(dataFile), ORCAD_HELD_FENCE_TOKENS_FILE_NAME)
}

function bootedAt(): number {
  return Date.now() - uptime() * 1000
}

function readHeld(): HeldFence[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file ?? '', 'utf-8'))
    const fresh = Date.now() - MAX_AGE_MS
    return Array.isArray(parsed)
      ? parsed.filter((entry) => isHeldFence(entry) && entry.at > fresh)
      : []
  } catch {
    return []
  }
}

function isHeldFence(entry: unknown): entry is HeldFence {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    'token' in entry &&
    typeof entry.token === 'string' &&
    'pid' in entry &&
    Number.isSafeInteger(entry.pid) &&
    'host' in entry &&
    typeof entry.host === 'string' &&
    'bootedAt' in entry &&
    typeof entry.bootedAt === 'number' &&
    'at' in entry &&
    typeof entry.at === 'number'
  )
}

async function updateHeld(change: (held: HeldFence[]) => HeldFence[] | null): Promise<void> {
  const target = file
  if (!target) {
    return
  }
  try {
    // Read-modify-write in one lane, so two concurrent updates cannot drop each other's token.
    await serializePathWrite(`${target}#read-modify-write`, async () => {
      const next = change(readHeld())
      if (next) {
        await writeSecureFileAsync(target, JSON.stringify(next, null, 2), { durable: true })
      }
    })
  } catch (error) {
    console.warn(`[orcad] Could not update the held fence token file: ${String(error)}`)
  }
}

/** Await before the lock command: a reply lost after the lock landed still leaves a provable token. */
export async function rememberHeldOrcadFence(token: string): Promise<void> {
  await updateHeld((held) => [
    ...held,
    { token, pid: process.pid, host: hostname(), bootedAt: bootedAt(), at: Date.now() }
  ])
}

export async function forgetHeldOrcadFence(token: string): Promise<void> {
  await updateHeld((held) =>
    held.some((entry) => entry.token === token)
      ? held.filter((entry) => entry.token !== token)
      : null
  )
}

/** Tokens only positively exited earlier processes of this machine and boot held; any other may live. */
export function orcadFenceTokensHeldByExitedProcesses(): string[] {
  return file
    ? readHeld()
        .filter(heldByExitedProcess)
        .map((entry) => entry.token)
    : []
}

function heldByExitedProcess(entry: HeldFence): boolean {
  if (
    entry.pid === process.pid ||
    entry.host !== hostname() ||
    Math.abs(entry.bootedAt - bootedAt()) > BOOT_TOLERANCE_MS
  ) {
    return false
  }
  try {
    process.kill(entry.pid, 0)
    return false
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH'
  }
}
