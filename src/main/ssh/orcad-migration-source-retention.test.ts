import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Repo } from '../../shared/repo-types'
import type { PersistedOpenFile } from '../../shared/workspace-session-state-types'
import { closeTestStores, createSqliteTestStore } from '../persistence/persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import {
  listOrcadMigrationSourceCutovers,
  removeOrcadMigrationSourceCutover,
  updateOrcadMigrationSourceCutover,
  writeOrcadMigrationSourceCutover
} from './orcad-migration-cutover-journal'
import { orcadMigrationCutoverFixture } from './orcad-migration-cutover-fixture'
import { listPendingManagedOrcadMigrations } from '../managed-server/lifecycle/orcad-managed-migration-status'
import {
  retainUnretainedOrcadMigrationSources,
  retainOrcadMigrationSource
} from './orcad-migration-source-retention'
import {
  enableMovedOrcadAutomations,
  enableMovedOrcadAutomationsForTarget
} from './orcad-migration-moved-automations'
import { createOrcadMigrationManifest } from './orcad-migration-manifest-export'
import * as boundedWrites from '../../shared/bounded-secure-json-file'
import * as cutoverJournal from './orcad-migration-cutover-journal'
import { drainPendingPathWrites, serializePathWrite } from '../../shared/path-write-serializer'

const TARGET_ID = 'ssh-1'
const SOURCE_HOST = `ssh:${TARGET_ID}`
const SERVER_HOST = 'runtime:env-1'
const WORKTREE = 'repo-1::/srv/app'
const REPO: Repo = {
  id: 'repo-1',
  path: '/srv/app',
  displayName: 'app',
  badgeColor: '#737373',
  addedAt: 1,
  kind: 'git',
  connectionId: TARGET_ID
}

let userDataPath: string
let store: Store

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orcad-retention-'))
  store = createSqliteTestStore(Store, { dataFile: join(userDataPath, 'orca-data.json') })
})

afterEach(async () => {
  await drainPendingPathWrites()
  vi.restoreAllMocks()
  await closeTestStores()
  rmSync(userDataPath, { recursive: true, force: true })
})

function committed(migrationId = 'm-1') {
  const cutover = orcadMigrationCutoverFixture(migrationId, TARGET_ID)
  return {
    ...cutover,
    phase: 'destination-committed' as const,
    manifest: {
      ...cutover.manifest,
      payload: { ...cutover.manifest.payload, repositories: [REPO] }
    }
  }
}

function draftedFile(filePath: string, draft: string): PersistedOpenFile {
  return {
    filePath,
    relativePath: filePath.slice('/srv/app/'.length),
    worktreeId: WORKTREE,
    language: 'markdown',
    dirtyDraftContent: draft,
    lastKnownDiskSignature: 'base-1'
  }
}

function saveFiles(hostId: string, files: PersistedOpenFile[]): void {
  store.setWorkspaceSession(
    { ...store.getWorkspaceSession(hostId), openFilesByWorktree: { [WORKTREE]: files } },
    hostId
  )
}

async function restart(): Promise<void> {
  await store.flushPendingOrThrowAsync()
  await closeTestStores()
  store = createSqliteTestStore(Store, { dataFile: join(userDataPath, 'orca-data.json') })
}

const serverFiles = () => store.getWorkspaceSession(SERVER_HOST).openFilesByWorktree?.[WORKTREE]

describe('retaining a committed migration source', () => {
  it('marks only a committed cutover, idempotently, and stops counting it as pending', async () => {
    await writeOrcadMigrationSourceCutover(userDataPath, orcadMigrationCutoverFixture('m-1'))
    await expect(retainOrcadMigrationSource(userDataPath, 'm-1', store)).rejects.toThrow(
      'orcad_migration_retain_before_commit'
    )
    await writeOrcadMigrationSourceCutover(userDataPath, {
      ...orcadMigrationCutoverFixture('m-1'),
      phase: 'destination-committed'
    })
    const at = () => new Date('2026-10-03T00:00:00.000Z')
    await retainOrcadMigrationSource(userDataPath, 'm-1', store, at)
    await retainOrcadMigrationSource(
      userDataPath,
      'm-1',
      store,
      () => new Date('2026-12-01T00:00:00.000Z')
    )
    expect(listOrcadMigrationSourceCutovers(userDataPath)[0]?.sourceRetainedAt).toBe(
      '2026-10-03T00:00:00.000Z'
    )
    expect(listPendingManagedOrcadMigrations(userDataPath)).toEqual([])
  })

  it('does not recreate a journal when cleanup was queued before retention', async () => {
    await writeOrcadMigrationSourceCutover(userDataPath, {
      ...orcadMigrationCutoverFixture('m-removed'),
      phase: 'destination-committed'
    })
    const results = await Promise.allSettled([
      removeOrcadMigrationSourceCutover(userDataPath, 'm-removed'),
      retainOrcadMigrationSource(userDataPath, 'm-removed', store)
    ])
    expect(results[0]).toEqual({ status: 'fulfilled', value: undefined })
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: 'orcad_migration_retain_before_commit' })
    })
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toEqual([])
  })

  it('does not count retained cutovers against the in-flight journal capacity', async () => {
    for (let index = 0; index < 4; index += 1) {
      const id = `m-${index}`
      await writeOrcadMigrationSourceCutover(userDataPath, {
        ...orcadMigrationCutoverFixture(id, `ssh-${index}`),
        phase: 'destination-committed',
        sourceRetainedAt: '2026-10-03T00:00:00.000Z'
      })
    }
    await expect(
      writeOrcadMigrationSourceCutover(userDataPath, orcadMigrationCutoverFixture('m-new', 'ssh-9'))
    ).resolves.toBeUndefined()
  })
})

describe('renaming unsaved drafts to the server on commit', () => {
  beforeEach(() => {
    store.addSshTarget({
      id: TARGET_ID,
      label: 'Prod',
      host: 'h',
      port: 22,
      username: 'u',
      generation: 2
    })
    store.addRepo(REPO)
  })

  it('moves the host and desktop drafts, with their baseline, and leaves the source as it was', async () => {
    saveFiles(SOURCE_HOST, [draftedFile('/srv/app/host.md', 'host draft')])
    saveFiles('local', [draftedFile('/srv/app/desktop.md', 'desktop draft')])
    const source = JSON.stringify(store.getWorkspaceSession(SOURCE_HOST))
    await writeOrcadMigrationSourceCutover(userDataPath, committed())

    await retainOrcadMigrationSource(userDataPath, 'm-1', store)

    expect(serverFiles()).toEqual([
      { ...draftedFile('/srv/app/host.md', 'host draft'), runtimeEnvironmentId: 'env-1' },
      { ...draftedFile('/srv/app/desktop.md', 'desktop draft'), runtimeEnvironmentId: 'env-1' }
    ])
    expect(listOrcadMigrationSourceCutovers(userDataPath)[0]?.sourceRetainedAt).toBeDefined()
    expect(JSON.stringify(store.getWorkspaceSession(SOURCE_HOST))).toBe(source)
    await store.flushPendingOrThrowAsync()
    await closeTestStores()
    store = createSqliteTestStore(Store, { dataFile: join(userDataPath, 'orca-data.json') })
    expect(serverFiles()?.map((file) => file.dirtyDraftContent)).toEqual([
      'host draft',
      'desktop draft'
    ])
  })

  it('keeps what the server partition already holds, and never revives a discarded draft', async () => {
    saveFiles(SOURCE_HOST, [
      draftedFile('/srv/app/a.md', 'source A'),
      draftedFile('/srv/app/b.md', 'source B')
    ])
    saveFiles(SERVER_HOST, [{ ...draftedFile('/srv/app/a.md', 'newer A') }])
    await writeOrcadMigrationSourceCutover(userDataPath, committed())

    await retainOrcadMigrationSource(userDataPath, 'm-1', store)
    expect(serverFiles()?.map((file) => file.dirtyDraftContent)).toEqual(['newer A', 'source B'])

    saveFiles(SERVER_HOST, [])
    await retainOrcadMigrationSource(userDataPath, 'm-1', store)
    expect(serverFiles()).toEqual([])
    await restart()
    await retainUnretainedOrcadMigrationSources(userDataPath, store)
    await retainOrcadMigrationSource(userDataPath, 'm-1', store)
    expect(serverFiles()).toEqual([])
  })

  it('renames and retains at startup after a cut-off commit, so a draft closed later stays closed', async () => {
    saveFiles(SOURCE_HOST, [draftedFile('/srv/app/a.md', 'source A')])
    await writeOrcadMigrationSourceCutover(userDataPath, committed())
    await restart()

    await retainUnretainedOrcadMigrationSources(userDataPath, store)
    expect(serverFiles()?.map((file) => file.dirtyDraftContent)).toEqual(['source A'])
    expect(listOrcadMigrationSourceCutovers(userDataPath)[0]?.sourceRetainedAt).toBeDefined()
    // Later retain/start must not resurrect a draft closed before connect.
    saveFiles(SERVER_HOST, [])
    await retainOrcadMigrationSource(userDataPath, 'm-1', store)
    await retainUnretainedOrcadMigrationSources(userDataPath, store)
    await restart()
    await retainUnretainedOrcadMigrationSources(userDataPath, store)
    expect(serverFiles()).toEqual([])
  })

  it('shares one retain between concurrent callers, so a later one never renames again', async () => {
    saveFiles(SOURCE_HOST, [draftedFile('/srv/app/a.md', 'source A')])
    await writeOrcadMigrationSourceCutover(userDataPath, committed())
    const first = retainOrcadMigrationSource(userDataPath, 'm-1', store)
    expect(retainOrcadMigrationSource(userDataPath, 'm-1', store)).toBe(first)
    await first
    saveFiles(SERVER_HOST, [])
    await retainOrcadMigrationSource(userDataPath, 'm-1', store)
    expect(serverFiles()).toEqual([])
  })

  it("never retains another profile's migration at startup", async () => {
    await writeOrcadMigrationSourceCutover(userDataPath, {
      ...orcadMigrationCutoverFixture('m-9', 'ssh-other-profile'),
      phase: 'destination-committed'
    })
    await retainUnretainedOrcadMigrationSources(userDataPath, store)
    expect(listOrcadMigrationSourceCutovers(userDataPath)[0]?.sourceRetainedAt).toBeUndefined()
  })

  it('keeps newer typing in the server copy when the connect retains first', async () => {
    saveFiles(SOURCE_HOST, [draftedFile('/srv/app/a.md', 'source A')])
    saveFiles(SERVER_HOST, [
      { ...draftedFile('/srv/app/a.md', 'typed after'), runtimeEnvironmentId: 'env-1' }
    ])
    await writeOrcadMigrationSourceCutover(userDataPath, committed())
    await retainOrcadMigrationSource(userDataPath, 'm-1', store)
    await retainUnretainedOrcadMigrationSources(userDataPath, store)
    expect(serverFiles()?.map((file) => file.dirtyDraftContent)).toEqual(['typed after'])
  })

  it('makes the startup rename durable before its retained mark', async () => {
    saveFiles(SOURCE_HOST, [draftedFile('/srv/app/a.md', 'source A')])
    await writeOrcadMigrationSourceCutover(userDataPath, committed())
    await restart()
    await retainUnretainedOrcadMigrationSources(userDataPath, store)
    expect(listOrcadMigrationSourceCutovers(userDataPath)[0]?.sourceRetainedAt).toBeDefined()
    // Reopen from disk to model a crash before pending writes land.
    const crashed = createSqliteTestStore(Store, { dataFile: join(userDataPath, 'orca-data.json') })
    expect(
      crashed.getWorkspaceSession(SERVER_HOST).openFilesByWorktree?.[WORKTREE]?.[0]
        ?.dirtyDraftContent
    ).toBe('source A')
  })

  it("leaves another host's file and another project's draft where they are", async () => {
    saveFiles(SOURCE_HOST, [
      { ...draftedFile('/srv/app/remote.md', 'other host'), runtimeEnvironmentId: 'env-9' }
    ])
    store.setWorkspaceSession(
      {
        ...store.getWorkspaceSession(SOURCE_HOST),
        openFilesByWorktree: {
          ...store.getWorkspaceSession(SOURCE_HOST).openFilesByWorktree,
          'repo-2::/srv/other': [draftedFile('/srv/other/x.md', 'other project')]
        }
      },
      SOURCE_HOST
    )
    await writeOrcadMigrationSourceCutover(userDataPath, committed())

    await retainOrcadMigrationSource(userDataPath, 'm-1', store)
    expect(store.getWorkspaceSession(SERVER_HOST).openFilesByWorktree ?? {}).toEqual({})
  })
})

// #29083: a moved automation must run on the server, never again from this desktop.
describe('moving automations that ran on this desktop', () => {
  const TARGET = { id: TARGET_ID, label: 'Prod', host: 'h', port: 22, username: 'u', generation: 2 }

  async function committedWithAutomation() {
    store.addSshTarget(TARGET)
    store.addRepo(REPO)
    const automation = store.createAutomation({
      name: 'Nightly check',
      prompt: 'Check the repo',
      agentId: 'claude',
      projectId: REPO.id,
      workspaceMode: 'new_per_run',
      timezone: 'UTC',
      rrule: 'FREQ=DAILY',
      dtstart: 1
    })
    const manifest = createOrcadMigrationManifest(store, TARGET, {
      migrationId: 'm-1',
      destinationEnvironmentId: 'env-1'
    })
    await writeOrcadMigrationSourceCutover(userDataPath, {
      ...orcadMigrationCutoverFixture('m-1', TARGET_ID),
      phase: 'destination-committed',
      manifestSha256: manifest.manifestSha256,
      manifest
    })
    return automation
  }

  function holdJournalWrite() {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const execute = boundedWrites.writeSecureJsonFileWithinLimitAsync
    let held = false
    const spy = vi
      .spyOn(boundedWrites, 'writeSecureJsonFileWithinLimitAsync')
      .mockImplementation(async (...args) => {
        if (args[0] === join(userDataPath, 'orcad-migration-cutovers', 'm-1.json') && !held) {
          held = true
          entered.resolve()
          await release.promise
        }
        return execute(...args)
      })
    return { entered: entered.promise, release: () => release.resolve(), spy }
  }

  async function retainedWithAutomation() {
    const automation = await committedWithAutomation()
    await updateOrcadMigrationSourceCutover(userDataPath, 'm-1', (current) => ({
      ...current,
      sourceRetainedAt: '2026-10-03T00:00:00.000Z',
      automationsToEnableOnServer: [automation.id]
    }))
    store.disableAutomations(new Set([automation.id]))
    return automation
  }

  it('saves enable intent durably before disabling a retained automation', async () => {
    const automation = await committedWithAutomation()
    const disable = vi.spyOn(store, 'disableAutomations')
    const held = holdJournalWrite()
    const operations: Promise<unknown>[] = []
    try {
      const retaining = retainOrcadMigrationSource(userDataPath, 'm-1', store)
      operations.push(retaining)
      await Promise.race([held.entered, retaining])
      expect(disable).not.toHaveBeenCalled()
      expect(store.listAutomations()[0]?.enabled).toBe(true)
      expect(
        listOrcadMigrationSourceCutovers(userDataPath)[0]?.automationsToEnableOnServer
      ).toBeUndefined()
      held.release()
      await retaining
      expect(disable).toHaveBeenCalledOnce()
      expect(
        listOrcadMigrationSourceCutovers(userDataPath)[0]?.automationsToEnableOnServer
      ).toEqual([automation.id])
      await restart()
      expect(store.listAutomations()[0]?.enabled).toBe(false)
    } finally {
      held.release()
      await Promise.allSettled(operations)
    }
  })

  it('preserves the enabled source and unretained journal when saving enable intent fails', async () => {
    await committedWithAutomation()
    await store.flushPendingOrThrowAsync()
    vi.spyOn(boundedWrites, 'writeSecureJsonFileWithinLimitAsync').mockRejectedValueOnce(
      new Error('journal intent save refused')
    )
    await expect(retainOrcadMigrationSource(userDataPath, 'm-1', store)).rejects.toThrow(
      'journal intent save refused'
    )
    const cutover = listOrcadMigrationSourceCutovers(userDataPath)[0]
    expect(cutover?.automationsToEnableOnServer).toBeUndefined()
    expect(cutover?.sourceRetainedAt).toBeUndefined()
    await restart()
    expect(store.listAutomations()[0]?.enabled).toBe(true)
  })

  it('keeps a queued journal update and its recorded enable intent during retention', async () => {
    await committedWithAutomation()
    const held = holdJournalWrite()
    const operations: Promise<unknown>[] = []
    try {
      const updating = updateOrcadMigrationSourceCutover(userDataPath, 'm-1', (current) => ({
        ...current,
        linkedRepositoryIds: [REPO.id],
        automationsToEnableOnServer: []
      }))
      operations.push(updating)
      await held.entered
      const retaining = retainOrcadMigrationSource(userDataPath, 'm-1', store)
      operations.push(retaining)
      held.release()
      await Promise.all([updating, retaining])
      expect(listOrcadMigrationSourceCutovers(userDataPath)[0]).toMatchObject({
        linkedRepositoryIds: [REPO.id],
        automationsToEnableOnServer: [],
        sourceRetainedAt: expect.any(String)
      })
      expect(store.listAutomations()[0]?.enabled).toBe(false)
    } finally {
      held.release()
      await Promise.allSettled(operations)
    }
  })

  it('waits for the durable enable acknowledgement before reporting completion', async () => {
    const automation = await retainedWithAutomation()
    const held = holdJournalWrite()
    const operations: Promise<unknown>[] = []
    try {
      let finished = false
      const enabling = enableMovedOrcadAutomations(userDataPath, 'm-1', async () => true).then(
        (result) => {
          finished = true
          return result
        }
      )
      operations.push(enabling)
      await Promise.race([held.entered, enabling])
      expect(finished).toBe(false)
      expect(
        listOrcadMigrationSourceCutovers(userDataPath)[0]?.automationsToEnableOnServer
      ).toEqual([automation.id])
      held.release()
      await expect(enabling).resolves.toBe(0)
      expect(
        listOrcadMigrationSourceCutovers(userDataPath)[0]?.automationsToEnableOnServer
      ).toEqual([])
    } finally {
      held.release()
      await Promise.allSettled(operations)
    }
  })

  it('keeps pending enable intent when the acknowledgement cannot be journaled', async () => {
    const automation = await retainedWithAutomation()
    vi.spyOn(boundedWrites, 'writeSecureJsonFileWithinLimitAsync').mockRejectedValueOnce(
      new Error('journal acknowledgement refused')
    )
    await expect(
      enableMovedOrcadAutomations(userDataPath, 'm-1', async () => true)
    ).rejects.toThrow('journal acknowledgement refused')
    expect(listOrcadMigrationSourceCutovers(userDataPath)[0]?.automationsToEnableOnServer).toEqual([
      automation.id
    ])
    expect(listOrcadMigrationSourceCutovers(userDataPath)[0]?.sourceRetainedAt).toBeDefined()
  })

  it('does not restore enable intent cleared while its request was in flight', async () => {
    await retainedWithAutomation()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const operations: Promise<unknown>[] = []
    try {
      const enabling = enableMovedOrcadAutomations(userDataPath, 'm-1', async () => {
        entered.resolve()
        await release.promise
        throw new Error('server became unreachable')
      })
      operations.push(enabling)
      await entered.promise
      await updateOrcadMigrationSourceCutover(userDataPath, 'm-1', (current) => ({
        ...current,
        linkedRepositoryIds: [REPO.id],
        automationsToEnableOnServer: []
      }))
      release.resolve()
      await enabling
      await drainPendingPathWrites()
      expect(listOrcadMigrationSourceCutovers(userDataPath)[0]).toMatchObject({
        linkedRepositoryIds: [REPO.id],
        automationsToEnableOnServer: []
      })
    } finally {
      release.resolve()
      await Promise.allSettled(operations)
    }
  })

  it('accepts an obsolete enable acknowledgement when queued cleanup removes its journal', async () => {
    await retainedWithAutomation()
    const directoryEntered = Promise.withResolvers<void>()
    const releaseDirectory = Promise.withResolvers<void>()
    const providerEntered = Promise.withResolvers<void>()
    const releaseProvider = Promise.withResolvers<boolean>()
    const acknowledgementQueued = Promise.withResolvers<void>()
    const execute = cutoverJournal.updateOrcadMigrationSourceCutover
    vi.spyOn(cutoverJournal, 'updateOrcadMigrationSourceCutover').mockImplementation((...args) => {
      const updating = execute(...args)
      acknowledgementQueued.resolve()
      return updating
    })
    const operations: Promise<unknown>[] = []
    try {
      const blocking = serializePathWrite(
        cutoverJournal.orcadMigrationCutoverJournalDirectory(userDataPath),
        async () => {
          directoryEntered.resolve()
          await releaseDirectory.promise
        }
      )
      operations.push(blocking)
      await directoryEntered.promise
      const enabling = enableMovedOrcadAutomations(userDataPath, 'm-1', () => {
        providerEntered.resolve()
        return releaseProvider.promise
      })
      operations.push(enabling)
      await expect(Promise.race([providerEntered.promise, enabling])).resolves.toBeUndefined()
      const removing = removeOrcadMigrationSourceCutover(userDataPath, 'm-1')
      operations.push(removing)
      releaseProvider.resolve(true)
      await expect(Promise.race([acknowledgementQueued.promise, enabling])).resolves.toBeUndefined()
      releaseDirectory.resolve()
      await expect(Promise.all([removing, enabling])).resolves.toEqual([undefined, 0])
      expect(listOrcadMigrationSourceCutovers(userDataPath)).toEqual([])
    } finally {
      releaseProvider.resolve(true)
      releaseDirectory.resolve()
      await Promise.allSettled(operations)
    }
  })

  it('disables the retained copy at commit and re-enables it on the server once', async () => {
    const automation = await committedWithAutomation()

    await retainOrcadMigrationSource(userDataPath, 'm-1', store)
    expect(store.listAutomations()[0]?.enabled).toBe(false)
    await restart()
    expect(store.listAutomations()[0]?.enabled).toBe(false)

    const enable = vi.fn(async () => true)
    await expect(enableMovedOrcadAutomations(userDataPath, 'm-1', enable)).resolves.toBe(0)
    await enableMovedOrcadAutomations(userDataPath, 'm-1', enable)
    expect(enable).toHaveBeenCalledOnce()
    expect(enable).toHaveBeenCalledWith(
      expect.objectContaining({ id: automation.id, dtstart: automation.dtstart })
    )
  })

  it('retries a server it could not reach, but not one that refused', async () => {
    await committedWithAutomation()
    await retainOrcadMigrationSource(userDataPath, 'm-1', store)

    const unreachable = vi.fn(async () => {
      throw new Error('offline')
    })
    await expect(enableMovedOrcadAutomations(userDataPath, 'm-1', unreachable)).resolves.toBe(0)
    const refused = vi.fn(async () => false)
    await expect(enableMovedOrcadAutomations(userDataPath, 'm-1', refused)).resolves.toBe(1)
    await enableMovedOrcadAutomations(userDataPath, 'm-1', refused)
    expect(refused).toHaveBeenCalledOnce()
  })

  it('retries an earlier move a later delta move superseded', async () => {
    await committedWithAutomation()
    await retainOrcadMigrationSource(userDataPath, 'm-1', store)
    await writeOrcadMigrationSourceCutover(userDataPath, {
      ...orcadMigrationCutoverFixture('m-2', TARGET_ID),
      phase: 'destination-committed',
      sourceRetainedAt: '2026-10-03T00:00:00.000Z',
      supersedesMigrationId: 'm-1'
    })

    const enable = vi.fn(async () => false)
    await expect(
      enableMovedOrcadAutomationsForTarget(userDataPath, TARGET_ID, enable)
    ).resolves.toBe(1)
    expect(enable).toHaveBeenCalledOnce()
  })

  it('leaves a copy the user had turned off alone, and asks the server for nothing', async () => {
    const automation = await committedWithAutomation()
    store.disableAutomations(new Set([automation.id]))
    const before = store.listAutomations()[0]

    await retainOrcadMigrationSource(userDataPath, 'm-1', store)
    const enable = vi.fn(async () => true)
    await enableMovedOrcadAutomations(userDataPath, 'm-1', enable)

    expect(store.listAutomations()[0]).toEqual(before)
    expect(enable).not.toHaveBeenCalled()
  })
})
