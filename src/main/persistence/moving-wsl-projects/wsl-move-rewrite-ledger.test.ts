import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { wslMoveCutoverFixture as cutover } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { listWslMoveCutovers, writeWslMoveCutover } from './wsl-move-cutover-journal'
import {
  registerWslMoveDesktopRewriteStore,
  resetWslMoveDesktopRewriteStoresForTests,
  setWslMoveDesktopRewriteRegistryCompleteForTests
} from './wsl-move-desktop-rewrite-stores'

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-ledger-'))
})
afterEach(() => {
  resetWslMoveDesktopRewriteStoresForTests()
  rmSync(userDataPath, { recursive: true, force: true })
})

const committed = (rewrittenStores: string[]) =>
  cutover('move-1', 'destination-committed', { rewrittenStores })

describe('WSL move rewrite ledger', () => {
  it('grows append-only while the desktop rewrites', async () => {
    await seedWslMoveCutover(userDataPath, committed([]))
    await writeWslMoveCutover(userDataPath, committed(['a']))
    await writeWslMoveCutover(userDataPath, committed(['a', 'b']))
    // Rewriting the same ledger is a no-op, not a change.
    await writeWslMoveCutover(userDataPath, committed(['a', 'b']))
    expect(listWslMoveCutovers(userDataPath)[0]?.rewrittenStores).toEqual(['a', 'b'])
  })

  it.each([
    ['removes an entry', ['a']],
    ['reorders entries', ['b', 'a']],
    ['replaces an entry', ['a', 'c']],
    ['duplicates an entry', ['a', 'b', 'a']]
  ])('refuses a write that %s', async (_label, rewrittenStores) => {
    await seedWslMoveCutover(userDataPath, committed(['a', 'b']))
    await expect(writeWslMoveCutover(userDataPath, committed(rewrittenStores))).rejects.toThrow(
      'wsl_move_ledger_changed'
    )
    expect(listWslMoveCutovers(userDataPath)[0]?.rewrittenStores).toEqual(['a', 'b'])
  })

  it('refuses ledger entries outside the rewrite phase', async () => {
    await expect(
      writeWslMoveCutover(userDataPath, cutover('move-1', 'prepared', { rewrittenStores: ['a'] }))
    ).rejects.toThrow('wsl_move_ledger_changed')
    await seedWslMoveCutover(userDataPath, cutover('move-1', 'blobs-transferred'))
    await expect(writeWslMoveCutover(userDataPath, committed(['a']))).rejects.toThrow(
      'wsl_move_ledger_changed'
    )
  })

  it('advances to client-rewritten only once every registered store is recorded', async () => {
    setWslMoveDesktopRewriteRegistryCompleteForTests(true)
    registerWslMoveDesktopRewriteStore({ id: 'a', side: 'main', run: () => {}, flush: () => {} })
    registerWslMoveDesktopRewriteStore({ id: 'b', side: 'renderer' })
    await seedWslMoveCutover(userDataPath, committed(['a']))
    await expect(
      writeWslMoveCutover(
        userDataPath,
        cutover('move-1', 'client-rewritten', { rewrittenStores: ['a'] })
      )
    ).rejects.toThrow('wsl_move_rewrite_incomplete')
    await writeWslMoveCutover(userDataPath, committed(['a', 'b']))
    await writeWslMoveCutover(
      userDataPath,
      cutover('move-1', 'client-rewritten', { rewrittenStores: ['a', 'b'] })
    )
    expect(listWslMoveCutovers(userDataPath)[0]?.phase).toBe('client-rewritten')
  })

  it('refuses client-rewritten while the store registry is incomplete', async () => {
    await seedWslMoveCutover(userDataPath, committed([]))
    await expect(
      writeWslMoveCutover(userDataPath, cutover('move-1', 'client-rewritten'))
    ).rejects.toThrow('wsl_move_rewrite_incomplete')
    setWslMoveDesktopRewriteRegistryCompleteForTests(true)
    await writeWslMoveCutover(userDataPath, cutover('move-1', 'client-rewritten'))
    expect(listWslMoveCutovers(userDataPath)[0]?.phase).toBe('client-rewritten')
  })

  it('re-seeds a committed record to a later phase without dropping its ledger', async () => {
    await seedWslMoveCutover(userDataPath, committed(['a', 'b']))
    await seedWslMoveCutover(userDataPath, cutover('move-1', 'retained'))
    expect(listWslMoveCutovers(userDataPath)[0]).toMatchObject({
      phase: 'retained',
      rewrittenStores: ['a', 'b']
    })
  })
})
