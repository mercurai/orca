import { randomBytes } from 'node:crypto'
import { renameSync } from 'node:fs'
import { chmod, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { serializePathWrite } from './path-write-serializer'
import {
  hardenSecurePathOnce,
  rememberHardenedPath,
  UNSUPPORTED_DIRECTORY_FSYNC_CODES,
  type HardeningOutcome
} from './secure-file'
import { recordHardeningOutcome } from './secure-path-hardening-retry-budget'
import { restrictNewFileAsync } from './secure-path-windows-acl'

/** Async lane. Use this from anything an IPC handler can await; see `writeSecureFileAsync`. */
export async function writeSecureJsonFileAsync(
  targetPath: string,
  value: unknown
): Promise<boolean> {
  return await writeSecureFileAsync(targetPath, JSON.stringify(value, null, 2))
}

/** Async lane for the stores that fsync before they report a write as committed. */
export async function writeDurableSecureJsonFileAsync(
  targetPath: string,
  value: unknown
): Promise<boolean> {
  return await writeSecureFileAsync(targetPath, JSON.stringify(value, null, 2), { durable: true })
}

/**
 * `writeSecureFile` off the event loop, and the lane every IPC-reachable caller should use: the
 * durable variant's fsync costs tens of milliseconds on NTFS behind a filter driver, and it runs on
 * the single thread answering every pending `ipcRenderer.invoke`.
 *
 * Syscall order, flags, modes and error/cleanup paths are identical to the synchronous twin —
 * mkdir(0o700) → harden dir → write tmp(0o600) → fsync file → ACL the staged file → rename →
 * fsync directory, with the temp removed on every throwing path.
 *
 * The Windows ACL apply moves to the async icacls lane too — the ordering guarantee was never
 * "synchronously", it was "before the rename publishes the file", which an await preserves. Only
 * the metadata cache's chmod/stat stay synchronous; those are microseconds.
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

export async function writeSecureFileAsync(
  targetPath: string,
  contents: string,
  options: { durable?: boolean; shouldPublish?: () => boolean } = {}
): Promise<boolean> {
  return await serializePathWrite(targetPath, async () => {
    const dir = dirname(targetPath)
    // recursive mkdir is a no-op on an existing directory, so no exists-then-create race.
    await mkdir(dir, { recursive: true, mode: 0o700 })
    // Windows dir hardening stays async + path-cached (it stormed the main thread, #4901); POSIX keeps the metadata cache to catch chmod/ctime drift.
    hardenSecurePathOnce(dir, true)

    const tmpFile = `${targetPath}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`
    try {
      await writeFile(tmpFile, contents, { encoding: 'utf-8', mode: 0o600 })
      if (options.durable) {
        await fsyncFile(tmpFile)
      }
      // Why: writeFile mode is a no-op on Windows, so the credential's ACL must land before the rename publishes it under inherited ACLs.
      let outcome = await applyWritePathRestriction(tmpFile, targetPath)
      if (options.shouldPublish) {
        if (!options.shouldPublish()) {
          throw new SecureWriteSupersededError(targetPath)
        }
        renameSync(tmpFile, targetPath)
      } else {
        await rename(tmpFile, targetPath)
      }
      // The staged file's protected DACL travels with the rename (same volume), so a successful
      // staged pass needs no second one; a failed one gets the published path's retry the tag had.
      if (outcome === 'failed') {
        outcome = await applyWritePathRestriction(targetPath, targetPath)
      }
      if (outcome === 'applied') {
        rememberHardenedPath(targetPath, false)
      }
      if (options.durable) {
        await bestEffortFsyncDirectory(dir)
      }
      return outcome === 'applied'
    } catch (error) {
      await rm(tmpFile, { force: true })
      throw error
    }
  })
}

/** Restricts a directory to the current user, off the event loop; false when the ACL did not take. */
export async function hardenSecureDirectoryAsync(directory: string): Promise<boolean> {
  if (process.platform !== 'win32') {
    await chmod(directory, 0o700)
    return true
  }
  return await restrictNewFileAsync(directory, true)
}

/**
 * The write path's ACL apply, off the event loop. Budget-exempt like its synchronous twin: the
 * write path is user-driven rather than polled, so a failed apply must still be retried on the next
 * write of the same credential instead of falling under the read path's backoff.
 */
async function applyWritePathRestriction(
  stagedPath: string,
  targetPath: string
): Promise<HardeningOutcome> {
  if (process.platform !== 'win32') {
    await chmod(stagedPath, 0o600)
    return 'applied'
  }
  const restricted = await restrictNewFileAsync(stagedPath)
  if (restricted) {
    // Success only: this is how a recovered host clears the read path's backoff (and reports
    // `recovered`). Recording a failure here would put the exempt lane back under the budget.
    recordHardeningOutcome(targetPath, true)
  }
  return restricted ? 'applied' : 'failed'
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
