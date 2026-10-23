import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { removeTreeSync } from './windows-transient-lock-removal'
import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const openedPaths = vi.hoisted(
  () => [] as { path: string; flags: string | number; ownerWritable: boolean }[]
)

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  return {
    ...actual,
    openSync: (path: NodeFs.PathLike, flags: string | number, mode?: NodeFs.Mode) => {
      openedPaths.push({
        path: String(path),
        flags,
        ownerWritable: Boolean(actual.statSync(path).mode & 0o200)
      })
      return actual.openSync(path, flags, mode)
    }
  }
})

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises')
  return {
    ...actual,
    open: (path: NodeFs.PathLike, flags: string | number, mode?: NodeFs.Mode) => {
      openedPaths.push({
        path: String(path),
        flags,
        ownerWritable: Boolean(statSync(path).mode & 0o200)
      })
      return actual.open(path, flags, mode)
    }
  }
})

import { bestEffortFsyncDirectorySync, fsyncFileSync } from './secure-file'
import { writeDurableSecureJsonFileAsync } from './secure-file-async-write'

const createdPaths: string[] = []

afterEach(() => {
  openedPaths.length = 0
  for (const path of createdPaths.splice(0)) {
    removeTreeSync(path)
  }
})

describe('secure file fsync flags', () => {
  const windowsIt = process.platform === 'win32' ? it : it.skip
  windowsIt('opens files read/write before fsync on Windows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-file-fsync-'))
    createdPaths.push(directory)
    const path = join(directory, 'record.json')
    writeFileSync(path, '{}')

    fsyncFileSync(path)

    expect(openedPaths).toMatchObject([{ path, flags: 'r+' }])
  })

  const posixIt = process.platform === 'win32' ? it.skip : it
  posixIt('fsyncs files without owner-write permission', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-file-fsync-read-only-'))
    createdPaths.push(directory)
    const path = join(directory, 'record.json')
    writeFileSync(path, '{}')
    chmodSync(path, 0o400)

    expect(() => fsyncFileSync(path)).not.toThrow()
    expect(openedPaths).toEqual([{ path, flags: 'r', ownerWritable: false }])
  })

  posixIt('durably writes when umask removes owner-write from the temporary file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-durable-file-fsync-read-only-'))
    createdPaths.push(directory)
    const path = join(directory, 'record.json')
    const originalUmask = process.umask(0o200)

    try {
      await expect(writeDurableSecureJsonFileAsync(path, { ok: true })).resolves.toBe(true)
    } finally {
      process.umask(originalUmask)
    }

    // The temp file is chmodded to 0o600 before the fsync, so the fsync also covers the mode change;
    // what matters is that it opens read-only and the published file lands at exactly 0o600.
    expect(openedPaths[0]).toMatchObject({ flags: 'r' })
    expect(openedPaths[0]?.path).toMatch(/record\.json\.\d+\.\d+\.[0-9a-f]+\.tmp$/)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  posixIt('opens directories read-only before fsync', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-directory-fsync-'))
    createdPaths.push(directory)

    bestEffortFsyncDirectorySync(directory)

    expect(openedPaths).toMatchObject([{ path: directory, flags: 'r' }])
  })
})
