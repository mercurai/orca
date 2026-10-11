import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { renameFileWithWindowsRetry } from '../../shared/windows-retry-file-operations'
import { isProcessAlive } from './daemon-process-inspection'
import {
  ensureOwnedPrivateDir,
  SHORT_DAEMON_SOCKET_DIR_PREFIX
} from './daemon-socket-endpoint-path'

// Why 256: half of macOS's machine-wide pty limit (kern.tty.ptmx_max = 511), so other terminal
// programs and the ptys agents open inside Orca terminals keep room; five times the deleted SSH
// relay's 50, which users with many worktrees did reach.
export const DEFAULT_MAX_HOST_TERMINALS = 256
const MAX_HOST_TERMINALS_ENV_VAR = 'ORCA_DAEMON_MAX_HOST_TERMINALS'
const MAX_OVERRIDE_TERMINALS = 4096

const REFRESH_INTERVAL_MS = 60_000
// Why: a daemon wedged this long is not forking either; its entry must not block others forever.
const STALE_AFTER_MS = 5 * 60_000

export function resolveMaxHostTerminals(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MAX_HOST_TERMINALS_ENV_VAR]?.trim()
  if (!raw || !/^\d+$/.test(raw)) {
    return DEFAULT_MAX_HOST_TERMINALS
  }
  const parsed = Number(raw)
  return parsed >= 1 && parsed <= MAX_OVERRIDE_TERMINALS ? parsed : DEFAULT_MAX_HOST_TERMINALS
}

/** Machine-local and per user: every daemon this user runs on the host, whatever its profile. */
export function defaultHostTerminalLedgerDir(
  platform: NodeJS.Platform = process.platform,
  uid: number | undefined = process.getuid?.()
): string | null {
  if (platform === 'win32') {
    return join(tmpdir(), 'orca-daemon-host-terminals')
  }
  // Why /tmp, not the data root: a home on a network share can be mounted by several machines.
  return uid === undefined
    ? null
    : posix.join(`${SHORT_DAEMON_SOCKET_DIR_PREFIX}${uid}`, 'terminals')
}

function ensureLedgerDir(dir: string, platform: NodeJS.Platform = process.platform): void {
  const uid = process.getuid?.()
  if (platform === 'win32' || uid === undefined) {
    mkdirSync(dir, { recursive: true })
    return
  }
  // Why validated: the /tmp path is predictable, so a dir another user planted is refused.
  ensureOwnedPrivateDir(posix.dirname(dir), uid)
  ensureOwnedPrivateDir(dir, uid)
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // A leftover entry is ignored once its owner is gone.
  }
}

type LedgerEntry = { schemaVersion: 1; pid: number; terminals: number; updatedAt: number }

function parseEntry(raw: string): LedgerEntry | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (
      typeof value === 'object' &&
      value !== null &&
      'schemaVersion' in value &&
      value.schemaVersion === 1 &&
      'pid' in value &&
      Number.isSafeInteger(value.pid) &&
      'terminals' in value &&
      Number.isSafeInteger(value.terminals) &&
      'updatedAt' in value &&
      typeof value.updatedAt === 'number'
    ) {
      return {
        schemaVersion: 1,
        pid: Number(value.pid),
        terminals: Math.max(0, Number(value.terminals)),
        updatedAt: value.updatedAt
      }
    }
  } catch {
    // Unreadable entries are skipped below.
  }
  return null
}

type HostTerminalLedgerOptions = {
  /** Null keeps the cap to this daemon's own terminals. */
  dir: string | null
  maxTerminals: number
  pid?: number
  now?: () => number
  isProcessAlive?: (pid: number) => boolean
  createDir?: (dir: string) => void
  log: (event: string, details: Record<string, unknown>) => void
}

/**
 * One cap on terminals for the whole execution host. Each daemon owns one file holding its
 * live-plus-starting count and sums everyone else's. It writes its reservation before reading
 * the others, so two daemons racing for the last slot cannot both see room.
 * Fail-open: an entry or directory that cannot be read never blocks a terminal.
 */
export class HostTerminalLedger {
  private readonly pid: number
  private readonly now: () => number
  private readonly isAlive: (pid: number) => boolean
  private dirReady = false
  private dirFailed = false
  private published: number | null = null
  private refreshTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly options: HostTerminalLedgerOptions) {
    this.pid = options.pid ?? process.pid
    this.now = options.now ?? Date.now
    this.isAlive = options.isProcessAlive ?? isProcessAlive
  }

  get maxTerminals(): number {
    return this.options.maxTerminals
  }

  /** `ownTerminals` excludes the one being reserved; on false nothing was published. */
  tryReserve(ownTerminals: number): boolean {
    if (ownTerminals + 1 > this.options.maxTerminals) {
      return false
    }
    this.write(ownTerminals + 1)
    if (ownTerminals + 1 + this.readOthers() <= this.options.maxTerminals) {
      return true
    }
    this.write(ownTerminals)
    return false
  }

  /** Whether one more terminal would fit, without reserving it. */
  hasRoom(ownTerminals: number): boolean {
    return ownTerminals + 1 + this.readOthers() <= this.options.maxTerminals
  }

  publish(ownTerminals: number): void {
    if (ownTerminals !== this.published) {
      this.write(ownTerminals)
    }
  }

  start(): void {
    if (this.refreshTimer || this.options.dir === null) {
      return
    }
    this.refreshTimer = setInterval(() => {
      if (this.published !== null) {
        this.write(this.published)
      }
    }, REFRESH_INTERVAL_MS)
    this.refreshTimer.unref?.()
  }

  close(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
    const path = this.entryPath()
    if (path) {
      removeQuietly(path)
    }
    this.published = null
  }

  private entryPath(): string | null {
    return this.options.dir === null ? null : join(this.options.dir, `${this.pid}.json`)
  }

  private usableDir(): string | null {
    const dir = this.options.dir
    if (dir === null || this.dirFailed) {
      return null
    }
    if (!this.dirReady) {
      try {
        ;(this.options.createDir ?? ensureLedgerDir)(dir)
        this.dirReady = true
      } catch (error) {
        this.dirFailed = true
        this.options.log('host-terminal-ledger-unavailable', {
          error: error instanceof Error ? error.message : String(error)
        })
        return null
      }
    }
    return dir
  }

  private write(terminals: number, retried = false): void {
    this.published = terminals
    const dir = this.usableDir()
    if (dir === null) {
      return
    }
    const path = join(dir, `${this.pid}.json`)
    const entry: LedgerEntry = { schemaVersion: 1, pid: this.pid, terminals, updatedAt: this.now() }
    try {
      writeFileSync(`${path}.tmp`, JSON.stringify(entry), { mode: 0o600 })
      renameFileWithWindowsRetry(`${path}.tmp`, path)
    } catch (error) {
      // Why: a periodic /tmp cleaner can remove the directory under a long-lived daemon.
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT' && !retried) {
        this.dirReady = false
        this.write(terminals, true)
      }
      // Otherwise others undercount this daemon; its own cap still holds.
    }
  }

  private readOthers(): number {
    const dir = this.usableDir()
    if (dir === null) {
      return 0
    }
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return 0
    }
    const now = this.now()
    let total = 0
    for (const name of names) {
      const match = /^(\d+)\.json$/.exec(name)
      if (!match || Number(match[1]) === this.pid) {
        continue
      }
      let entry: LedgerEntry | null
      try {
        entry = parseEntry(readFileSync(join(dir, name), 'utf8'))
      } catch {
        continue
      }
      if (!entry || entry.pid !== Number(match[1])) {
        continue
      }
      if (!this.isAlive(entry.pid)) {
        removeQuietly(join(dir, name))
        continue
      }
      if (now - entry.updatedAt > STALE_AFTER_MS) {
        continue
      }
      total += entry.terminals
    }
    return total
  }
}
