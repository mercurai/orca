import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  WSL_MOVE_CUTOVER_PHASES,
  wslMoveJournalKey
} from '../../../shared/wsl-move/wsl-move-cutover'
import { wslMoveCutoverFixture as cutover } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { orcadMigrationCutoverJournalDirectory } from '../../ssh/orcad-migration-cutover-journal'
import {
  listWslMoveCutoverChain,
  listWslMoveCutovers,
  removeWslMoveCutover,
  writeWslMoveCutover,
  wslMoveJournalDirectory
} from './wsl-move-cutover-journal'
import {
  resetWslMoveDesktopRewriteStoresForTests,
  setWslMoveDesktopRewriteRegistryCompleteForTests
} from './wsl-move-desktop-rewrite-stores'

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-journal-'))
})
afterEach(() => {
  resetWslMoveDesktopRewriteStoresForTests()
  rmSync(userDataPath, { recursive: true, force: true })
})

const journalPath = (id: string) => join(wslMoveJournalDirectory(userDataPath), `${id}.json`)

describe('WSL move journal', () => {
  it('round-trips a move in an owner-only file of its own directory', async () => {
    await writeWslMoveCutover(userDataPath, cutover())
    expect(listWslMoveCutovers(userDataPath)).toEqual([cutover()])
    expect(wslMoveJournalDirectory(userDataPath)).not.toBe(
      orcadMigrationCutoverJournalDirectory(userDataPath)
    )
    if (process.platform !== 'win32') {
      expect(statSync(journalPath('move-1')).mode & 0o077).toBe(0)
    }
    await removeWslMoveCutover(userDataPath, 'move-1')
    expect(listWslMoveCutovers(userDataPath)).toEqual([])
  })

  it.each([
    ['corrupt JSON', '{not json'],
    ['another distro key', JSON.stringify({ ...cutover(), journalKey: 'local-wsl:debian' })],
    ['a tampered manifest', JSON.stringify({ ...cutover(), manifestSha256: 'f'.repeat(64) })],
    ['an unknown phase', JSON.stringify({ ...cutover(), phase: 'teleported' })]
  ])('fails closed on %s', (_label, contents) => {
    mkdirSync(wslMoveJournalDirectory(userDataPath), { recursive: true })
    writeFileSync(journalPath('move-1'), contents)
    expect(() => listWslMoveCutovers(userDataPath)).toThrow('stay fenced')
  })

  it('refuses a second move into a distro while the first is in flight', async () => {
    await seedWslMoveCutover(userDataPath, cutover('move-1', 'quiesced'))
    await expect(
      writeWslMoveCutover(
        userDataPath,
        cutover('move-2', 'prepared', { supersedesMigrationId: 'move-1' })
      )
    ).rejects.toThrow('wsl_move_already_in_flight')
  })

  it('chains a delta move after a finished one, and only onto the head', async () => {
    await seedWslMoveCutover(userDataPath, cutover('move-1', 'retained'))
    await expect(writeWslMoveCutover(userDataPath, cutover('move-2'))).rejects.toThrow(
      'wsl_move_must_extend_its_chain'
    )
    await writeWslMoveCutover(
      userDataPath,
      cutover('move-2', 'prepared', { supersedesMigrationId: 'move-1' })
    )
    expect(
      listWslMoveCutoverChain(userDataPath, wslMoveJournalKey('ubuntu')).map((c) => c.migrationId)
    ).toEqual(['move-1', 'move-2'])
  })

  it('advances its own record through the phases', async () => {
    await writeWslMoveCutover(userDataPath, cutover('move-1', 'prepared'))
    await writeWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced'))
    expect(listWslMoveCutovers(userDataPath)[0]?.phase).toBe('source-fenced')
  })

  it('never moves a record backwards, rebinds it, or advances a superseded one', async () => {
    setWslMoveDesktopRewriteRegistryCompleteForTests(true)
    await seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
    await expect(writeWslMoveCutover(userDataPath, cutover('move-1', 'prepared'))).rejects.toThrow(
      'wsl_move_phase_regressed'
    )
    await expect(
      writeWslMoveCutover(
        userDataPath,
        cutover('move-1', 'retained', {}, { repoIds: ['repo-1', 'repo-2'] })
      )
    ).rejects.toThrow('wsl_move_binding_changed')
    await writeWslMoveCutover(userDataPath, cutover('move-1', 'client-rewritten'))
    await writeWslMoveCutover(userDataPath, cutover('move-1', 'retained'))
    await writeWslMoveCutover(
      userDataPath,
      cutover('move-2', 'prepared', { supersedesMigrationId: 'move-1' })
    )
    // Rewriting the finished link unchanged is fine; nothing may restart it.
    await writeWslMoveCutover(userDataPath, cutover('move-1', 'retained'))
  })

  it('hands out records a caller cannot edit into the next comparison', async () => {
    await seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
    const [listed] = listWslMoveCutovers(userDataPath)
    if (listed) {
      listed.phase = 'prepared'
    }
    expect(listWslMoveCutovers(userDataPath)[0]?.phase).toBe('destination-committed')
    await expect(writeWslMoveCutover(userDataPath, cutover('move-1', 'prepared'))).rejects.toThrow(
      'wsl_move_phase_regressed'
    )
  })

  it('refuses one id for two distros, and a first move that names a predecessor', async () => {
    await writeWslMoveCutover(userDataPath, cutover('move-1'))
    const debian = cutover('move-1')
    const other = { ...debian, journalKey: wslMoveJournalKey('Debian') }
    other.manifest = { ...debian.manifest, source: { ...debian.manifest.source, distro: 'Debian' } }
    await expect(writeWslMoveCutover(userDataPath, other)).rejects.toThrow()
    await expect(
      writeWslMoveCutover(
        userDataPath,
        cutover('move-9', 'prepared', { supersedesMigrationId: 'gone' })
      )
    ).rejects.toThrow()
  })

  it('refuses a later phase whose record is missing or was lifted, or that skips a phase', async () => {
    await expect(writeWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced'))).rejects.toThrow(
      'wsl_move_record_missing'
    )
    await seedWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced'))
    await removeWslMoveCutover(userDataPath, 'move-1')
    await expect(writeWslMoveCutover(userDataPath, cutover('move-1', 'quiesced'))).rejects.toThrow(
      'wsl_move_record_missing'
    )
    expect(listWslMoveCutovers(userDataPath)).toEqual([])
    await writeWslMoveCutover(userDataPath, cutover('move-1', 'prepared'))
    await expect(writeWslMoveCutover(userDataPath, cutover('move-1', 'quiesced'))).rejects.toThrow(
      'wsl_move_phase_skipped'
    )
  })

  it.each(WSL_MOVE_CUTOVER_PHASES.slice(2, -1))('refuses to remove a %s record', async (phase) => {
    await seedWslMoveCutover(userDataPath, cutover('move-1', phase))
    await expect(removeWslMoveCutover(userDataPath, 'move-1')).rejects.toThrow('wsl_move_in_flight')
    expect(listWslMoveCutovers(userDataPath)[0]?.phase).toBe(phase)
  })

  it('keeps the fence: a record past quiesce cannot be removed', async () => {
    await seedWslMoveCutover(userDataPath, cutover('move-1', 'quiesced'))
    await expect(removeWslMoveCutover(userDataPath, 'move-1')).rejects.toThrow('wsl_move_in_flight')
    expect(listWslMoveCutovers(userDataPath)).toHaveLength(1)
  })

  it('lifts a fence whose quiesce refused: nothing reached the destination yet', async () => {
    await seedWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced'))
    await removeWslMoveCutover(userDataPath, 'move-1')
    expect(listWslMoveCutovers(userDataPath)).toEqual([])
  })

  it('does not recreate a removed fence from an already-queued later phase', async () => {
    await seedWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced'))
    const outcomes = await Promise.allSettled([
      removeWslMoveCutover(userDataPath, 'move-1'),
      writeWslMoveCutover(userDataPath, cutover('move-1', 'quiesced'))
    ])
    expect(outcomes[0]).toEqual({ status: 'fulfilled', value: undefined })
    expect(outcomes[1]).toMatchObject({
      status: 'rejected', reason: new Error('wsl_move_record_missing')
    })
    expect(listWslMoveCutovers(userDataPath)).toEqual([])
  })

  it('refuses queued removal after a competing writer advances past the removable phase', async () => {
    await seedWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced'))
    const outcomes = await Promise.allSettled([
      writeWslMoveCutover(userDataPath, cutover('move-1', 'quiesced')),
      removeWslMoveCutover(userDataPath, 'move-1')
    ])
    expect(outcomes[0]).toEqual({ status: 'fulfilled', value: undefined })
    expect(outcomes[1]).toMatchObject({
      status: 'rejected', reason: new Error('wsl_move_in_flight')
    })
    expect(listWslMoveCutovers(userDataPath)[0]?.phase).toBe('quiesced')
  })

  it('fails closed on a manifest edited without re-signing it', () => {
    const record = cutover()
    const edited = {
      ...record,
      manifest: {
        ...record.manifest,
        source: { ...record.manifest.source, scopeRepoIds: ['repo-2'] },
        payload: {
          ...record.manifest.payload,
          repositories: [{ ...record.manifest.payload.repositories[0], id: 'repo-2' }]
        }
      }
    }
    mkdirSync(wslMoveJournalDirectory(userDataPath), { recursive: true })
    writeFileSync(journalPath('move-1'), JSON.stringify(edited))
    expect(() => listWslMoveCutovers(userDataPath)).toThrow('stay fenced')
  })
})
