import { randomBytes } from 'node:crypto'
import { renameSync, rmSync } from 'node:fs'
import { chmod, mkdir, open, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  discardPendingPathWrites,
  pathDiscardEpoch,
  serializePathWrite
} from './path-write-serializer'
import {
  hardenSecurePathOnce,
  rememberHardenedPath,
  UNSUPPORTED_DIRECTORY_FSYNC_CODES
} from './secure-file'
import { recordHardeningOutcome } from './secure-path-hardening-retry-budget'
import { restrictNewFileAsync, writeRestrictedWindowsFile } from './secure-path-windows-acl'

type RestrictionOutcome = 'applied' | 'failed'

/** Async lane. Use this from anything an IPC handler can await; see `writeSecureFileAsync`. */
export async function writeSecureJsonFileAsync(
  targetPath: string,
  value: unknown,
  options: { shouldPublish?: () => boolean } = {}
): Promise<boolean> {
  return await writeSecureFileAsync(targetPath, JSON.stringify(value, null, 2), options)
}

/** Async lane for the stores that fsync before they report a write as committed. */
export async function writeDurableSecureJsonFileAsync(
  targetPath: string,
  value: unknown
): Promise<boolean> {
  return await writeSecureFileAsync(targetPath, JSON.stringify(value, null, 2), { durable: true })
}

/**
 * The only secure-file write lane: it keeps spawns and fsyncs off the event loop. The
 * durable variant's fsync costs tens of milliseconds on NTFS behind a filter driver, and it runs on
 * the single thread answering every pending `ipcRenderer.invoke`.
 *
 * Syscall order: mkdir(0o700) → harden dir → write tmp(0o600, born restricted on Windows) → fsync
 * file → rename → fsync directory, with the temp removed on every throwing path.
 *
 * On Windows the staged file is created through the in-process ACL addon, so it never exists under
 * the directory's inherited DACL and no process is spawned. Only the metadata cache's chmod/stat
 * stay synchronous; those are microseconds.
 *
 * Serialized per `targetPath`: the tmp/fsync/rename dance is several awaits wide, so two concurrent
 * writers could otherwise interleave and publish a file neither of them wrote.
 *
 * `shouldPublish` is a synchronous veto checked immediately before the rename (a sync rename, so
 * nothing can run between check and publish): a read-modify-write caller whose snapshot went stale
 * while the ACL spawned gets `SecureWriteSupersededError` and the staged file is discarded.
 */
export class SecureWriteSupersededError extends Error {
  constructor(path: string) {
    super(`Secure write to ${path} was superseded before it published`)
    this.name = 'SecureWriteSupersededError'
  }
}

/** A delete of the path landed after this write was requested; callers drop it, never retry. */
export class SecureWriteDiscardedError extends Error {
  // Why: the path names the OS user; it stays on the error for main-process logs, not in its message.
  readonly targetPath: string

  constructor(path: string) {
    super('Secure write was discarded by a later delete')
    this.name = 'SecureWriteDiscardedError'
    this.targetPath = path
  }
}

/** For saves whose caller cleared the secret meanwhile: the clear wins and the save is a no-op. */
export async function ignoreDiscardedSecureWrite(save: () => Promise<void>): Promise<void> {
  try {
    await save()
  } catch (error) {
    if (!(error instanceof SecureWriteDiscardedError)) {
      throw error
    }
  }
}

/** Deletes a secure file and discards every write to it still in flight (save-then-clear stays cleared). */
export function removeSecureFile(targetPath: string): void {
  discardPendingPathWrites(targetPath)
  rmSync(targetPath, { force: true })
}

export async function writeSecureFileAsync(
  targetPath: string,
  contents: string,
  options: { durable?: boolean; shouldPublish?: () => boolean } = {}
): Promise<boolean> {
  // Captured at call time: a delete after the request but before the lane runs must still win.
  const discardEpoch = pathDiscardEpoch(targetPath)
  return await serializePathWrite(targetPath, async () => {
    const dir = dirname(targetPath)
    // recursive mkdir is a no-op on an existing directory, so no exists-then-create race.
    await mkdir(dir, { recursive: true, mode: 0o700 })
    // Windows dir hardening stays async + path-cached (it stormed the main thread, #4901); POSIX keeps the metadata cache to catch chmod/ctime drift.
    hardenSecurePathOnce(dir, true)

    const tmpFile = `${targetPath}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`
    try {
      let outcome = await stageRestrictedFile(tmpFile, contents)
      if (options.durable) {
        await fsyncFile(tmpFile)
      }
      // Checks and the rename are synchronous and adjacent, so nothing runs between veto and publish.
      if (pathDiscardEpoch(targetPath) !== discardEpoch) {
        throw new SecureWriteDiscardedError(targetPath)
      }
      if (options.shouldPublish && !options.shouldPublish()) {
        throw new SecureWriteSupersededError(targetPath)
      }
      renameSync(tmpFile, targetPath)
      // The staged file's protected DACL travels with the rename (same volume), so a successful
      // staged pass needs no second one; a failed one gets one retry on the published path.
      if (outcome === 'failed') {
        outcome = await restrictPublishedFile(targetPath)
      }
      if (outcome === 'applied') {
        rememberHardenedPath(targetPath, false)
        // Why: a confirmed success clears the read path's backoff (and reports `recovered`).
        recordHardeningOutcome(targetPath, true)
      }
      if (options.durable) {
        await bestEffortFsyncDirectory(dir)
      }
      // Why: a delete during the post-rename awaits already removed the file; callers must not cache it.
      if (pathDiscardEpoch(targetPath) !== discardEpoch) {
        throw new SecureWriteDiscardedError(targetPath)
      }
      return outcome === 'applied'
    } catch (error) {
      await rm(tmpFile, { force: true })
      throw error
    }
  })
}

/**
 * Creates the staged file already restricted. Windows ignores `mode`, so the addon creates it with
 * its DACL; without the addon the file is written plainly and reported as `failed`. Budget-exempt:
 * the write path is user-driven rather than polled, so a failed apply is retried on the next write.
 */
async function stageRestrictedFile(
  stagedPath: string,
  contents: string
): Promise<RestrictionOutcome> {
  if (process.platform === 'win32') {
    return writeRestrictedWindowsFile(stagedPath, contents) ? 'applied' : 'failed'
  }
  await writeFile(stagedPath, contents, { encoding: 'utf-8', mode: 0o600 })
  // The umask can strip bits from `mode` but never add them; chmod sets exactly 0o600.
  await chmod(stagedPath, 0o600)
  return 'applied'
}

async function restrictPublishedFile(targetPath: string): Promise<RestrictionOutcome> {
  if (process.platform !== 'win32') {
    return 'failed'
  }
  return (await restrictNewFileAsync(targetPath)) ? 'applied' : 'failed'
}

async function fsyncPath(path: string, flags: 'r' | 'r+'): Promise<void> {
  const handle = await open(path, flags)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function fsyncFile(path: string): Promise<void> {
  // FlushFileBuffers requires a write-capable handle on Windows.
  await fsyncPath(path, process.platform === 'win32' ? 'r+' : 'r')
}

async function bestEffortFsyncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') {
    return
  }
  try {
    await fsyncPath(directory, 'r')
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (typeof code === 'string' && UNSUPPORTED_DIRECTORY_FSYNC_CODES.has(code)) {
      return
    }
    throw error
  }
}
