import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as bounded from '../../../shared/bounded-secure-json-file'
import * as serialized from '../../../shared/path-write-serializer'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../shared/wsl-host-internal-gate'
import { wslMoveCutoverFixture } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import type { OrcadMigrationDestinationCatalog } from '../../ssh/orcad-migration-cutover-coordinator'
import {
  listWslMoveCutovers,
  writeWslMoveCutover,
  wslMoveJournalDirectory
} from './wsl-move-cutover-journal'
import { resolveWslMoveFence } from './wsl-move-fence'
import {
  listWslMoveOwedHostAborts,
  recordWslMoveOwedHostAbort,
  settleWslMoveOwedHostAborts
} from './wsl-move-owed-host-aborts'
import { recoverInterruptedWslMoves, resetWslMoveToZero } from './wsl-move-reset'

let userDataPath: string
beforeEach(() => {
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-owed-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(userDataPath, { recursive: true, force: true })
})

/** A record walked to `phase` through the journal's compare-and-swap. */
async function seed(phase: 'source-fenced' | 'quiesced' | 'destination-staged'): Promise<string> {
  const phases = ['prepared', 'source-fenced', 'quiesced', 'destination-staged'] as const
  const base = wslMoveCutoverFixture('move-1', 'prepared')
  for (const step of phases.slice(0, phases.indexOf(phase) + 1)) {
    await writeWslMoveCutover(userDataPath, {
      ...base,
      phase: step,
      ...(step === 'quiesced' || step === 'destination-staged' ? { terminalRestoreHints: [] } : {})
    })
  }
  return base.migrationId
}

describe('owed host aborts', () => {
  it('keeps a move that advances to the commit barrier while its reset outbox write waits', async () => {
    await seed('destination-staged')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const write = bounded.writeSecureJsonFileWithinLimitAsync
    vi.spyOn(bounded, 'writeSecureJsonFileWithinLimitAsync').mockImplementation(async (...args) => {
      if (String(args[0]).includes('orcad-migration-wsl-owed-aborts')) {
        entered.resolve()
        await release.promise
      }
      await write(...args)
    })
    const pending = resetWslMoveToZero({ userDataPath, destination: null }, 'move-1')
    try {
      await entered.promise
      const current = listWslMoveCutovers(userDataPath)[0]
      if (!current) {
        throw new Error('missing cutover fixture')
      }
      await writeWslMoveCutover(userDataPath, { ...current, phase: 'blobs-transferred' })
    } finally {
      release.resolve()
      await pending
    }
    expect(await pending).toEqual({ outcome: 'unverifiable', reason: 'wsl_move_cutover_changed' })
    expect(listWslMoveCutovers(userDataPath)[0]?.phase).toBe('blobs-transferred')
    const live = listWslMoveCutovers(userDataPath)[0]
    if (!live) {
      throw new Error('missing live cutover')
    }
    const abortByReference = vi.fn<OrcadMigrationDestinationCatalog['abortByReference']>(
      async (reference) => ({ ...reference, state: 'absent', aborted: true, durableAbsent: true })
    )
    await settleWslMoveOwedHostAborts(userDataPath, live.journalKey, { abortByReference })
    expect(abortByReference).not.toHaveBeenCalled()
    expect(listWslMoveOwedHostAborts(userDataPath)).toHaveLength(1)
    expect(resolveWslMoveFence(userDataPath).fenced.repoIds.has('repo-1')).toBe(true)

    const unexpected = async () => {
      throw new Error('unexpected recovery operation')
    }
    const destination: OrcadMigrationDestinationCatalog = {
      readState: async (manifest) => ({
        migrationId: manifest.migrationId,
        manifestSha256: manifest.manifestSha256,
        state: 'staged',
        stagedAt: '2026-10-29T00:00:00.000Z'
      }),
      abort: async (manifest) => ({
        migrationId: manifest.migrationId,
        manifestSha256: manifest.manifestSha256,
        state: 'absent',
        aborted: true
      }),
      stage: unexpected,
      commit: unexpected,
      stageChunk: unexpected,
      abortByReference
    }
    expect(await resetWslMoveToZero({ userDataPath, destination }, live.migrationId)).toEqual({
      outcome: 'reset',
      evidence: 'catalog-absent'
    })
    await settleWslMoveOwedHostAborts(userDataPath, live.journalKey, { abortByReference })
    expect(abortByReference).toHaveBeenCalledOnce()
    expect(listWslMoveCutovers(userDataPath)).toEqual([])
    expect(listWslMoveOwedHostAborts(userDataPath)).toEqual([])
  })

  it.each(['prepared', 'blobs-transferred'] as const)(
    'retains crash-surviving intent beside a live %s cutover',
    async (phase) => {
      const cutover = wslMoveCutoverFixture('move-1', phase)
      await seedWslMoveCutover(userDataPath, cutover)
      await recordWslMoveOwedHostAbort(userDataPath, {
        ...cutover,
        manifestSha256: 'f'.repeat(64)
      })
      const abortByReference = vi.fn()
      await settleWslMoveOwedHostAborts(userDataPath, cutover.journalKey, { abortByReference })
      expect(abortByReference).not.toHaveBeenCalled()
      expect(listWslMoveCutovers(userDataPath)[0]?.phase).toBe(phase)
      expect(listWslMoveOwedHostAborts(userDataPath)).toHaveLength(1)
    }
  )

  it('retains intent without contacting the host when the live journal is unreadable', async () => {
    await seed('source-fenced')
    const cutover = wslMoveCutoverFixture('move-1', 'prepared')
    await recordWslMoveOwedHostAbort(userDataPath, cutover)
    writeFileSync(join(wslMoveJournalDirectory(userDataPath), 'move-1.json'), '{')
    const abortByReference = vi.fn()
    const warn = vi.fn()
    await settleWslMoveOwedHostAborts(userDataPath, cutover.journalKey, { abortByReference }, warn)
    expect(abortByReference).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()
    expect(listWslMoveOwedHostAborts(userDataPath)).toHaveLength(1)
    expect(() => resolveWslMoveFence(userDataPath)).toThrow()
  })

  it('holds new journal publication behind an admitted remote abort and its retirement', async () => {
    const cutover = wslMoveCutoverFixture('move-1', 'prepared')
    await recordWslMoveOwedHostAbort(userDataPath, cutover)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const serialize = serialized.serializePathWrite
    let publishing = false
    let abortFinished = false
    vi.spyOn(serialized, 'serializePathWrite').mockImplementation(
      <T>(path: string, work: () => Promise<T>): Promise<T> =>
        serialize(path, async () => {
          if (publishing && path === wslMoveJournalDirectory(userDataPath)) {
            expect(abortFinished).toBe(true)
            expect(listWslMoveOwedHostAborts(userDataPath)).toEqual([])
          }
          return work()
        })
    )
    const pending = settleWslMoveOwedHostAborts(userDataPath, cutover.journalKey, {
      abortByReference: async (reference) => {
        entered.resolve()
        await release.promise
        abortFinished = true
        return { ...reference, state: 'absent', aborted: true, durableAbsent: true }
      }
    })
    await entered.promise
    publishing = true
    const publication = writeWslMoveCutover(userDataPath, cutover)
    release.resolve()
    await Promise.all([pending, publication])
    expect(listWslMoveCutovers(userDataPath)[0]?.phase).toBe('prepared')
    expect(listWslMoveOwedHostAborts(userDataPath)).toEqual([])
  })

  it('retains an owed abort when the host answers for another migration', async () => {
    const cutover = wslMoveCutoverFixture('move-1', 'prepared')
    await recordWslMoveOwedHostAbort(userDataPath, cutover)
    const warn = vi.fn()
    await settleWslMoveOwedHostAborts(
      userDataPath,
      cutover.journalKey,
      {
        abortByReference: async () => ({
          migrationId: 'other-migration',
          manifestSha256: cutover.manifestSha256,
          state: 'absent',
          aborted: true,
          durableAbsent: true
        })
      },
      warn
    )
    expect(listWslMoveOwedHostAborts(userDataPath)).toHaveLength(1)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('keeps a replacement owed abort published while an older host answer is pending', async () => {
    const cutover = wslMoveCutoverFixture('move-1', 'prepared')
    await recordWslMoveOwedHostAbort(userDataPath, cutover)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const pending = settleWslMoveOwedHostAborts(userDataPath, cutover.journalKey, {
      abortByReference: async () => {
        entered.resolve()
        await release.promise
        return {
          migrationId: cutover.migrationId,
          manifestSha256: cutover.manifestSha256,
          state: 'absent',
          aborted: true,
          durableAbsent: true
        }
      }
    })
    const replacement = { ...cutover, manifestSha256: 'f'.repeat(64) }
    try {
      await entered.promise
      await recordWslMoveOwedHostAbort(userDataPath, replacement)
    } finally {
      release.resolve()
      await pending
    }
    expect(listWslMoveOwedHostAborts(userDataPath)).toEqual([
      {
        migrationId: replacement.migrationId,
        manifestSha256: replacement.manifestSha256,
        journalKey: replacement.journalKey
      }
    ])
  })

  it('keeps the fence until the owed abort has been published durably', async () => {
    await seed('quiesced')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const write = bounded.writeSecureJsonFileWithinLimitAsync
    vi.spyOn(bounded, 'writeSecureJsonFileWithinLimitAsync').mockImplementation(async (...args) => {
      if (String(args[0]).includes('orcad-migration-wsl-owed-aborts')) {
        entered.resolve()
        await release.promise
      }
      await write(...args)
    })
    let settled = false
    const pending = recoverInterruptedWslMoves(userDataPath, () => {}).then(() => {
      settled = true
    })
    try {
      await entered.promise
      expect(settled).toBe(false)
      expect(listWslMoveCutovers(userDataPath)[0]?.phase).toBe('quiesced')
    } finally {
      release.resolve()
      await pending
    }
    expect(listWslMoveCutovers(userDataPath)).toEqual([])
    expect(listWslMoveOwedHostAborts(userDataPath)).toHaveLength(1)
  })

  it.each(['quiesced', 'destination-staged'] as const)(
    'a reset at %s without the host owes the host an abort, written before the record goes',
    async (phase) => {
      await seed(phase)
      await recoverInterruptedWslMoves(userDataPath, () => {})

      expect(listWslMoveCutovers(userDataPath)).toEqual([])
      expect(listWslMoveOwedHostAborts(userDataPath).map((entry) => entry.migrationId)).toEqual([
        'move-1'
      ])
    }
  )

  it('a reset before the stage request owes nothing', async () => {
    await seed('source-fenced')
    await recoverInterruptedWslMoves(userDataPath, () => {})

    expect(listWslMoveOwedHostAborts(userDataPath)).toEqual([])
  })

  it("settles only this distro's, keeps one the host could not answer, and drops answered ones", async () => {
    const cutover = wslMoveCutoverFixture('move-1', 'prepared')
    await recordWslMoveOwedHostAbort(userDataPath, cutover)
    await recordWslMoveOwedHostAbort(userDataPath, { ...cutover, migrationId: 'move-2' })
    await recordWslMoveOwedHostAbort(userDataPath, {
      ...cutover,
      migrationId: 'move-other',
      journalKey: 'local-wsl:debian'
    })
    const abortByReference = vi.fn(async (reference: { migrationId: string }) => {
      if (reference.migrationId === 'move-2') {
        throw new Error('socket closed')
      }
      return {
        migrationId: reference.migrationId,
        manifestSha256: cutover.manifestSha256,
        state: 'absent' as const,
        aborted: true,
        durableAbsent: true as const
      }
    })

    await settleWslMoveOwedHostAborts(
      userDataPath,
      cutover.journalKey,
      { abortByReference },
      () => {}
    )

    expect(abortByReference.mock.calls.map(([reference]) => reference.migrationId).sort()).toEqual([
      'move-1',
      'move-2'
    ])
    expect(
      listWslMoveOwedHostAborts(userDataPath)
        .map((entry) => entry.migrationId)
        .sort()
    ).toEqual(['move-2', 'move-other'])
  })
})
