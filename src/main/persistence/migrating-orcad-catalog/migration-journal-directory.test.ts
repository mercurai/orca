import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as bounded from '../../../shared/bounded-secure-json-file'
import * as durable from '../../durable-file-write'
import { createMigrationJournalDirectory } from './migration-journal-directory'

describe('orphaned migration journal temporaries', () => {
  type JournalRecord = { migrationId: string }

  const journalOptions = {
    directoryName: 'journal',
    maxFileBytes: 1024,
    parse: (value: unknown): JournalRecord => {
      if (typeof value !== 'object' || value === null || !('migrationId' in value)) {
        throw new Error('not a record')
      }
      return { migrationId: String(value.migrationId) }
    },
    unreadable: (detail: string) => new Error(detail)
  }
  const journal = createMigrationJournalDirectory<JournalRecord>({
    ...journalOptions,
    sweepOrphanedTemporaries: true
  })

  // The sweep compares a file's mtime with the clock, so both read this fixed time.
  const NOW = Date.UTC(2026, 9, 24, 12)

  let userDataPath: string
  let dir: string
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    userDataPath = mkdtempSync(join(tmpdir(), 'migration-journal-'))
    dir = join(userDataPath, 'journal')
    mkdirSync(dir)
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  function temporary(pid: number, ageMs: number): string {
    const path = join(dir, `move-1.json.${pid}.1792672615854.b6fca333.tmp`)
    writeFileSync(path, '{')
    const at = (NOW - ageMs) / 1000
    utimesSync(path, at, at)
    return path
  }

  describe('migration journal directory', () => {
    it("removes another process's write that died before its rename", () => {
      // A killed journal write left `<id>.json.<pid>.<ts>.tmp` behind forever.
      const orphan = temporary(process.pid + 1, 120_000)
      expect(journal.list(userDataPath)).toEqual([])
      expect(existsSync(orphan)).toBe(false)
    })

    it("keeps this process's own write and one another process may still be finishing", () => {
      const own = temporary(process.pid, 120_000)
      const recent = temporary(process.pid + 1, 0)
      expect(journal.list(userDataPath)).toEqual([])
      expect(existsSync(own)).toBe(true)
      expect(existsSync(recent)).toBe(true)
    })

    it('leaves temporaries alone in a journal that does not sweep, as SSH migration journals do', () => {
      const orphan = temporary(process.pid + 1, 120_000)
      const unswept = createMigrationJournalDirectory<JournalRecord>(journalOptions)
      expect(unswept.list(userDataPath)).toEqual([])
      expect(existsSync(orphan)).toBe(true)
    })
  })
})

describe('durable migration journal transactions', () => {
  type Record = { migrationId: string; detail: { value: string } }
  const directories: string[] = []
  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(
      directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    )
  })

  async function fixture() {
    const path = await mkdtemp(join(tmpdir(), 'orca-migration-journal-'))
    directories.push(path)
    const changed = vi.fn()
    const journal = createMigrationJournalDirectory<Record>({
      directoryName: 'journals',
      maxFileBytes: 256,
      parse: (value) => {
        if (
          typeof value !== 'object' ||
          value === null ||
          !('migrationId' in value) ||
          typeof value.migrationId !== 'string' ||
          !('detail' in value) ||
          typeof value.detail !== 'object' ||
          value.detail === null ||
          !('value' in value.detail) ||
          typeof value.detail.value !== 'string'
        ) {
          throw new Error('invalid journal')
        }
        return { migrationId: value.migrationId, detail: { value: value.detail.value } }
      },
      unreadable: (detail) => new Error(`unreadable: ${detail}`),
      onChange: changed
    })
    return { path, journal, changed }
  }

  function record(value = 'original'): Record {
    return { migrationId: 'migration-1', detail: { value } }
  }

  describe('async migration journal directory transactions', () => {
    it('awaits secure publication and directory durability before notifying followers', async () => {
      const { path, journal, changed } = await fixture()
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const realWrite = bounded.writeSecureJsonFileWithinLimitAsync
      const writer = vi.spyOn(bounded, 'writeSecureJsonFileWithinLimitAsync')
      writer.mockImplementationOnce(async (...args) => {
        entered.resolve()
        await release.promise
        await realWrite(...args)
      })
      const realSync = durable.syncDirectoryDurably
      const syncEntered = Promise.withResolvers<void>()
      const syncRelease = Promise.withResolvers<void>()
      const sync = vi.spyOn(durable, 'syncDirectoryDurably')
      sync.mockImplementationOnce(async (directory) => {
        syncEntered.resolve()
        await syncRelease.promise
        await realSync(directory)
      })
      const syncWriter = vi.spyOn(bounded, 'writeSecureJsonFileWithinLimit')
      const pending = journal.write(path, record())
      await entered.promise
      expect(changed).not.toHaveBeenCalled()
      release.resolve()
      await syncEntered.promise
      expect(changed).not.toHaveBeenCalled()
      syncRelease.resolve()
      await pending
      expect(sync.mock.calls.map(([directory]) => directory)).toEqual([
        journal.directory(path),
        path
      ])
      expect(writer).toHaveBeenCalledWith(expect.any(String), record(), 256, { durable: true })
      expect(syncWriter).not.toHaveBeenCalled()
      expect(changed).toHaveBeenCalledExactlyOnceWith(path)
      expect(journal.list(path)).toEqual([record()])
    })

    it('holds the directory lane across fresh reads and scoped mutations, then serializes removal', async () => {
      const { path, journal, changed } = await fixture()
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const transaction = journal.transact(path, async ({ write }) => {
        expect(journal.list(path)).toEqual([])
        entered.resolve()
        await release.promise
        await write(record())
        expect(journal.list(path)).toEqual([record()])
        return 'committed'
      })
      await entered.promise
      const removal = journal.remove(path, 'migration-1')
      expect(changed).not.toHaveBeenCalled()
      release.resolve()
      expect(await transaction).toBe('committed')
      await removal
      expect(journal.list(path)).toEqual([])
      expect(changed).toHaveBeenCalledTimes(2)
    })

    it('snapshots caller records before a queued write and invalidates cached records after rewriting', async () => {
      const { path, journal } = await fixture()
      await journal.write(path, record('old'))
      expect(journal.list(path)).toEqual([record('old')])
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const held = journal.transact(path, async () => {
        entered.resolve()
        await release.promise
      })
      await entered.promise
      const input = record()
      const pending = journal.write(path, input)
      input.detail.value = 'mutated after queue'
      release.resolve()
      await Promise.all([held, pending])
      expect(journal.list(path)).toEqual([record()])
      const saved = await readFile(join(journal.directory(path), 'migration-1.json'), 'utf8')
      expect(JSON.parse(saved)).toEqual(record())
    })

    it('releases a failed directory lane without notifying or replacing the prior bounded record', async () => {
      const { path, journal, changed } = await fixture()
      await journal.write(path, record())
      changed.mockClear()
      await expect(journal.write(path, record('x'.repeat(512)))).rejects.toThrow()
      expect(changed).not.toHaveBeenCalled()
      expect(journal.list(path)).toEqual([record()])
      await journal.write(path, record('recovered'))
      expect(journal.list(path)).toEqual([record('recovered')])
      expect(changed).toHaveBeenCalledOnce()
    })

    it('awaits removal durability and does not notify on a failed durable operation', async () => {
      const { path, journal, changed } = await fixture()
      await journal.write(path, record())
      changed.mockClear()
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const realSync = durable.syncDirectoryDurably
      vi.spyOn(durable, 'syncDirectoryDurably').mockImplementationOnce(async (directory) => {
        entered.resolve()
        await release.promise
        await realSync(directory)
      })
      const removal = journal.remove(path, 'migration-1')
      await entered.promise
      expect(changed).not.toHaveBeenCalled()
      release.resolve()
      await removal
      expect(changed).toHaveBeenCalledOnce()
      changed.mockClear()
      vi.spyOn(bounded, 'writeSecureJsonFileWithinLimitAsync').mockRejectedValueOnce(
        new Error('synthetic disk failure')
      )
      await expect(journal.write(path, record())).rejects.toThrow('synthetic disk failure')
      expect(changed).not.toHaveBeenCalled()
      await journal.write(path, record('retry'))
      expect(journal.list(path)).toEqual([record('retry')])
    })

    it('retains fail-closed synchronous listing for malformed or mismatched records', async () => {
      const { path, journal } = await fixture()
      await journal.write(path, record())
      const file = join(journal.directory(path), 'migration-1.json')
      await writeFile(file, '{')
      expect(() => journal.list(path)).toThrow('unreadable:')
      await writeFile(file, JSON.stringify({ ...record(), migrationId: 'different' }))
      expect(() => journal.list(path)).toThrow('file name does not match its migration id')
    })
  })
})
