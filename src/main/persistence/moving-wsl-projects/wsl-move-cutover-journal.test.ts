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
import { computeOrcadMigrationManifestSha256 } from '../../orcad/orcad-migration-manifest-digest'
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

  it('rejects phase regression and rebinding, and allows an unchanged finished link', async () => {
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
    await expect(
      writeWslMoveCutover(
        userDataPath,
        cutover('move-9', 'prepared', { supersedesMigrationId: 'gone' })
      )
    ).rejects.toThrow('wsl_move_must_extend_its_chain')
    await writeWslMoveCutover(userDataPath, cutover('move-1'))
    const debian = cutover('move-1')
    const other = { ...debian, journalKey: wslMoveJournalKey('Debian') }
    other.manifest = { ...debian.manifest, source: { ...debian.manifest.source, distro: 'Debian' } }
    const { manifestSha256: _digest, ...unsigned } = other.manifest
    other.manifest.manifestSha256 = computeOrcadMigrationManifestSha256(unsigned)
    other.manifestSha256 = other.manifest.manifestSha256
    await expect(writeWslMoveCutover(userDataPath, other)).rejects.toThrow('wsl_move_id_in_use')
  })

  it('refuses a later phase whose record is missing or was lifted, or that skips a phase', async () => {
    await expect(
      writeWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced'))
    ).rejects.toThrow('wsl_move_record_missing')
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
      status: 'rejected',
      reason: new Error('wsl_move_record_missing')
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
      status: 'rejected',
      reason: new Error('wsl_move_in_flight')
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

  it('refuses to remove a move a later move of its distro supersedes, so the chain stays readable', async () => {
    await seedWslMoveCutover(userDataPath, cutover('move-1', 'retained'))
    await seedWslMoveCutover(
      userDataPath,
      cutover('move-2', 'retained', { supersedesMigrationId: 'move-1' }, { repoIds: ['repo-2'] })
    )
    await seedWslMoveCutover(
      userDataPath,
      cutover('move-3', 'retained', { supersedesMigrationId: 'move-2' }, { repoIds: ['repo-3'] })
    )

    await expect(removeWslMoveCutover(userDataPath, 'move-2')).rejects.toThrow(
      'wsl_move_superseded'
    )
    await expect(removeWslMoveCutover(userDataPath, 'move-1')).rejects.toThrow(
      'wsl_move_superseded'
    )
    expect(
      listWslMoveCutoverChain(userDataPath, 'local-wsl:ubuntu').map((c) => c.migrationId)
    ).toEqual(['move-1', 'move-2', 'move-3'])
    // Newest first, one at a time, and the chain reads after every step.
    await removeWslMoveCutover(userDataPath, 'move-3')
    expect(listWslMoveCutoverChain(userDataPath, 'local-wsl:ubuntu')).toHaveLength(2)
    await removeWslMoveCutover(userDataPath, 'move-2')
    await removeWslMoveCutover(userDataPath, 'move-1')
    expect(listWslMoveCutovers(userDataPath)).toEqual([])
  })
  describe('restore hints', () => {
    const hints = [{ paneKey: 'tab-1:11111111-1111-4111-8111-111111111111', cwd: '/home/dev/a' }]

    it('records them once, with the quiesced record, and keeps them unchanged after', async () => {
      await seedWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced'))
      await writeWslMoveCutover(
        userDataPath,
        cutover('move-1', 'quiesced', { terminalRestoreHints: hints })
      )
      expect(listWslMoveCutovers(userDataPath)[0].terminalRestoreHints).toEqual(hints)
      await writeWslMoveCutover(
        userDataPath,
        cutover('move-1', 'destination-staged', { terminalRestoreHints: hints })
      )
      await expect(
        writeWslMoveCutover(
          userDataPath,
          cutover('move-1', 'blobs-transferred', { terminalRestoreHints: [] })
        )
      ).rejects.toThrow('wsl_move_restore_hints_changed')
      await expect(
        writeWslMoveCutover(userDataPath, cutover('move-1', 'blobs-transferred'))
      ).rejects.toThrow('wsl_move_restore_hints_changed')
    })

    it('refuses them on a new record or outside the quiesce step', async () => {
      await expect(
        writeWslMoveCutover(
          userDataPath,
          cutover('move-1', 'prepared', { terminalRestoreHints: hints })
        )
      ).rejects.toThrow('wsl_move_restore_hints_changed')
      await writeWslMoveCutover(userDataPath, cutover('move-1', 'prepared'))
      await expect(
        writeWslMoveCutover(
          userDataPath,
          cutover('move-1', 'source-fenced', { terminalRestoreHints: hints })
        )
      ).rejects.toThrow('wsl_move_restore_hints_changed')
    })

    it('reads a record without them (an older build) and a malformed list as absent', () => {
      mkdirSync(wslMoveJournalDirectory(userDataPath), { recursive: true })
      writeFileSync(journalPath('move-1'), JSON.stringify(cutover('move-1', 'quiesced')))
      expect(listWslMoveCutovers(userDataPath)[0].terminalRestoreHints).toBeUndefined()
      writeFileSync(
        journalPath('move-1'),
        JSON.stringify({
          ...cutover('move-1', 'quiesced'),
          terminalRestoreHints: [{ paneKey: 'not a pane', cwd: 'relative' }]
        })
      )
      expect(listWslMoveCutovers(userDataPath)[0].phase).toBe('quiesced')
      expect(listWslMoveCutovers(userDataPath)[0].terminalRestoreHints).toBeUndefined()
    })
  })
  it('keeps the automations to turn back on exactly as the move recorded them', async () => {
    await writeWslMoveCutover(
      userDataPath,
      cutover('move-1', 'prepared', { automationsToReenable: ['auto-1'] })
    )
    await expect(
      writeWslMoveCutover(
        userDataPath,
        cutover('move-1', 'source-fenced', { automationsToReenable: [] })
      )
    ).rejects.toThrow('wsl_move_binding_changed')
    await expect(
      writeWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced'))
    ).rejects.toThrow('wsl_move_binding_changed')
    await writeWslMoveCutover(
      userDataPath,
      cutover('move-1', 'source-fenced', { automationsToReenable: ['auto-1'] })
    )
    expect(listWslMoveCutovers(userDataPath)[0].automationsToReenable).toEqual(['auto-1'])
  })
})
