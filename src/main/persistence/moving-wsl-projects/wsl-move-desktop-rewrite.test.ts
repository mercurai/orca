import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as bounded from '../../../shared/bounded-secure-json-file'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../shared/wsl-host-internal-gate'
import type { WslMoveCutoverPhase } from '../../../shared/wsl-move/wsl-move-cutover'
import { WSL_MOVE_RENDERER_REWRITE_STORE_IDS } from '../../../shared/wsl-move/wsl-move-renderer-rewrite-types'
import { wslMoveCutoverFixture as cutover } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { listWslMoveCutovers, wslMoveJournalDirectory } from './wsl-move-cutover-journal'
import {
  listPendingWslMoveRendererRewrites,
  recordWslMoveRendererStoreRewritten,
  runGatedWslMoveDesktopRewritePass,
  runWslMoveDesktopRewritePass
} from './wsl-move-desktop-rewrite'
import {
  registerWslMoveDesktopRewriteStore,
  registerWslMoveRendererRewriteStores,
  resetWslMoveDesktopRewriteStoresForTests,
  setWslMoveDesktopRewriteRegistryCompleteForTests,
  type WslMoveDesktopRewriteContext
} from './wsl-move-desktop-rewrite-stores'

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-rewrite-'))
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  setWslMoveDesktopRewriteRegistryCompleteForTests(true)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  resetWslMoveDesktopRewriteStoresForTests()
  rmSync(userDataPath, { recursive: true, force: true })
})

const record = () => listWslMoveCutovers(userDataPath)[0]

type Trace = { events: string[]; failAt: Set<string> }

function mainStore(id: string, trace: Trace): void {
  registerWslMoveDesktopRewriteStore({
    id,
    side: 'main',
    run: () => {
      trace.events.push(`run:${id}`)
      if (trace.failAt.has(`run:${id}`)) {
        throw new Error(`run ${id} failed`)
      }
    },
    flush: () => {
      trace.events.push(`flush:${id}`)
      if (trace.failAt.has(`flush:${id}`)) {
        throw new Error(`flush ${id} failed`)
      }
    }
  })
}

describe('WSL move desktop rewrite', () => {
  it('publishes seeded workspace identities before flushing their store', async () => {
    await seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const write = bounded.writeSecureJsonFileWithinLimitAsync
    const spy = vi.spyOn(bounded, 'writeSecureJsonFileWithinLimitAsync')
    spy.mockImplementationOnce(async (...args) => {
      entered.resolve()
      await release.promise
      await write(...args)
    })
    const flush = vi.fn()
    registerWslMoveDesktopRewriteStore({
      id: 'seeded',
      side: 'main',
      run: async (context) => {
        await context.recordSeededHostWorkspaceIds(['workspace-1'])
      },
      flush
    })
    const pending = runWslMoveDesktopRewritePass({ userDataPath })
    try {
      await entered.promise
      expect(flush).not.toHaveBeenCalled()
      expect(record()?.rewrittenStores).toEqual([])
    } finally {
      release.resolve()
      await pending
      spy.mockRestore()
    }
    expect(record()?.seededHostWorkspaceIds).toEqual(['workspace-1'])
    expect(flush).toHaveBeenCalledOnce()
  })

  it('runs each store then flushes it before its ledger entry, and finishes the move', async () => {
    const trace: Trace = { events: [], failAt: new Set() }
    const contexts: WslMoveDesktopRewriteContext[] = []
    registerWslMoveDesktopRewriteStore({
      id: 'first',
      side: 'main',
      run: (context) => {
        contexts.push(context)
        trace.events.push(`ledger-before-run:${record()?.rewrittenStores.join(',')}`)
      },
      flush: () => {
        trace.events.push(`ledger-at-flush:${record()?.rewrittenStores.join(',')}`)
      }
    })
    mainStore('second', trace)
    await seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))

    await runWslMoveDesktopRewritePass({ userDataPath })

    expect(trace.events).toEqual([
      'ledger-before-run:',
      'ledger-at-flush:',
      'run:second',
      'flush:second'
    ])
    expect(record()?.rewrittenStores).toEqual(['first', 'second'])
    expect(record()?.phase).toBe('client-rewritten')
    expect(contexts[0]?.destinationHostId).toBe('runtime:wsl%3AUbuntu')
    expect(
      contexts[0]?.rewritePath.path('\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo-1', 'absolute')
    ).toBe('/home/dev/repo-1')
  })

  it.each(['run:b', 'flush:b'])(
    'after a failure at %s, the next pass redoes only unrecorded stores',
    async (failure) => {
      const trace: Trace = { events: [], failAt: new Set([failure]) }
      for (const id of ['a', 'b', 'c']) {
        mainStore(id, trace)
      }
      await seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
      const warn = vi.fn()

      await runWslMoveDesktopRewritePass({ userDataPath, warn })
      expect(record()?.rewrittenStores).toEqual(['a'])
      expect(record()?.phase).toBe('destination-committed')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(trace.events).not.toContain('run:c')

      trace.events.length = 0
      trace.failAt.clear()
      await runWslMoveDesktopRewritePass({ userDataPath, warn })
      expect(trace.events).toEqual(['run:b', 'flush:b', 'run:c', 'flush:c'])
      expect(record()?.rewrittenStores).toEqual(['a', 'b', 'c'])
      expect(record()?.phase).toBe('client-rewritten')
    }
  )

  it('stays in the rewrite phase while the store registry is incomplete', async () => {
    setWslMoveDesktopRewriteRegistryCompleteForTests(false)
    const trace: Trace = { events: [], failAt: new Set() }
    mainStore('a', trace)
    registerWslMoveDesktopRewriteStore({ id: 'r', side: 'renderer' })
    await seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
    await runWslMoveDesktopRewritePass({ userDataPath })
    await recordWslMoveRendererStoreRewritten(userDataPath, { migrationId: 'move-1', storeId: 'r' })
    expect(record()?.rewrittenStores).toEqual(['a', 'r'])
    expect(record()?.phase).toBe('destination-committed')

    setWslMoveDesktopRewriteRegistryCompleteForTests(true)
    await runWslMoveDesktopRewritePass({ userDataPath })
    expect(record()?.phase).toBe('client-rewritten')
  })

  it('times out a hung store like a failure, without blocking the next pass', async () => {
    let hang = true
    registerWslMoveDesktopRewriteStore({
      id: 'slow',
      side: 'main',
      run: () => (hang ? new Promise<void>(() => {}) : undefined),
      flush: () => {}
    })
    await seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
    const warn = vi.fn()
    vi.useFakeTimers()
    const running = runWslMoveDesktopRewritePass({ userDataPath, warn, storeTimeoutMs: 10 })
    await vi.advanceTimersByTimeAsync(10)
    await running
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('slow run timed out'))
    expect(record()?.rewrittenStores).toEqual([])

    hang = false
    await runWslMoveDesktopRewritePass({ userDataPath, warn, storeTimeoutMs: 10 })
    expect(record()?.rewrittenStores).toEqual(['slow'])
    expect(record()?.phase).toBe('client-rewritten')
  })

  it('is idempotent: a finished move is not rewritten again', async () => {
    const trace: Trace = { events: [], failAt: new Set() }
    mainStore('a', trace)
    await seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
    await runWslMoveDesktopRewritePass({ userDataPath })
    trace.events.length = 0
    await runWslMoveDesktopRewritePass({ userDataPath })
    expect(trace.events).toEqual([])
    expect(record()?.phase).toBe('client-rewritten')
    expect(record()?.rewrittenStores).toEqual(['a'])
  })

  it('leaves moves before commit, and waits on renderer stores before finishing', async () => {
    const trace: Trace = { events: [], failAt: new Set() }
    mainStore('a', trace)
    registerWslMoveDesktopRewriteStore({ id: 'r', side: 'renderer' })
    await seedWslMoveCutover(userDataPath, cutover('move-1', 'blobs-transferred'))
    await runWslMoveDesktopRewritePass({ userDataPath })
    expect(trace.events).toEqual([])
    await seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
    await runWslMoveDesktopRewritePass({ userDataPath })
    expect(record()?.rewrittenStores).toEqual(['a'])
    expect(record()?.phase).toBe('destination-committed')
  })

  it('preserves competing renderer acknowledgements while a main store finishes', async () => {
    let entered!: () => void
    let release!: () => void
    const running = new Promise<void>((resolve) => {
      entered = resolve
    })
    const finish = new Promise<void>((resolve) => {
      release = resolve
    })
    registerWslMoveDesktopRewriteStore({
      id: 'main-held',
      side: 'main',
      run: () => {
        entered()
        return finish
      },
      flush: () => {}
    })
    registerWslMoveDesktopRewriteStore({ id: 'renderer-a', side: 'renderer' })
    registerWslMoveDesktopRewriteStore({ id: 'renderer-b', side: 'renderer' })
    await seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
    const rewriting = runWslMoveDesktopRewritePass({ userDataPath })
    await running
    try {
      expect(
        await Promise.all([
          recordWslMoveRendererStoreRewritten(userDataPath, {
            migrationId: 'move-1',
            storeId: 'renderer-a'
          }),
          recordWslMoveRendererStoreRewritten(userDataPath, {
            migrationId: 'move-1',
            storeId: 'renderer-b'
          })
        ])
      ).toEqual([{ recorded: true }, { recorded: true }])
      expect(record()?.rewrittenStores).toEqual(['renderer-a', 'renderer-b'])
      expect(record()?.phase).toBe('destination-committed')
    } finally {
      release()
      await rewriting
    }
    expect(record()?.rewrittenStores).toEqual(['renderer-a', 'renderer-b', 'main-held'])
    expect(record()?.phase).toBe('client-rewritten')
    expect(listPendingWslMoveRendererRewrites(userDataPath)).toEqual([])
  })

  it('never throws when the journal cannot be read', async () => {
    const warn = vi.fn()
    await seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
    writeFileSync(join(wslMoveJournalDirectory(userDataPath), 'move-2.json'), '{not json')
    await expect(runWslMoveDesktopRewritePass({ userDataPath, warn })).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('does nothing at startup with the gate closed', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '')
    const trace: Trace = { events: [], failAt: new Set() }
    mainStore('a', trace)
    await seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
    await runGatedWslMoveDesktopRewritePass({ userDataPath })
    expect(trace.events).toEqual([])
    expect(record()?.phase).toBe('destination-committed')
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
    await runGatedWslMoveDesktopRewritePass({ userDataPath })
    expect(record()?.phase).toBe('client-rewritten')
  })
})

describe('WSL move renderer rewrites', () => {
  beforeEach(async () => {
    registerWslMoveDesktopRewriteStore({
      id: 'main-a',
      side: 'main',
      run: () => {},
      flush: () => {}
    })
    registerWslMoveDesktopRewriteStore({ id: 'renderer-a', side: 'renderer' })
    registerWslMoveDesktopRewriteStore({ id: 'renderer-b', side: 'renderer' })
    await seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
  })

  it('lists the pending renderer stores of a committed move', () => {
    expect(listPendingWslMoveRendererRewrites(userDataPath)).toEqual([
      {
        migrationId: 'move-1',
        storeIds: ['renderer-a', 'renderer-b'],
        destinationEnvironmentId: 'wsl:Ubuntu',
        destinationHostId: 'runtime:wsl%3AUbuntu',
        distro: 'Ubuntu',
        scopeRepoIds: ['repo-1'],
        scopeFolderWorkspaceIds: [],
        scopeRootPaths: ['/home/dev/repo-1']
      }
    ])
  })

  it('lists a move from commit on for re-application, with nothing to record after its rewrite', () => {
    // One move per distro at a time, so each phase gets its own journal.
    const listedFor = async (phase: WslMoveCutoverPhase) => {
      rmSync(wslMoveJournalDirectory(userDataPath), { recursive: true, force: true })
      const rewrittenStores =
        phase === 'blobs-transferred' ? [] : ['main-a', 'renderer-a', 'renderer-b']
      await seedWslMoveCutover(userDataPath, cutover('move-1', phase, { rewrittenStores }))
      return listPendingWslMoveRendererRewrites(userDataPath).map((move) => move.storeIds)
    }
    expect(listedFor('blobs-transferred')).toEqual([])
    expect(listedFor('client-rewritten')).toEqual([[]])
    expect(listedFor('retained')).toEqual([[]])
  })

  it('writes the renderer storage to disk before the ledger entry, and not when refused', async () => {
    const flushed: string[][] = []
    const flush = () => {
      flushed.push([...(record()?.rewrittenStores ?? [])])
    }
    const request = { migrationId: 'move-1', storeId: 'renderer-a' }
    await recordWslMoveRendererStoreRewritten(userDataPath, request, flush)
    await recordWslMoveRendererStoreRewritten(userDataPath, request, flush)
    expect(flushed).toEqual([[]])
    expect(record()?.rewrittenStores).toEqual(['renderer-a'])
  })

  it('records a pending renderer store, and finishes the move with the last one', async () => {
    await runWslMoveDesktopRewritePass({ userDataPath })
    expect(
      await recordWslMoveRendererStoreRewritten(userDataPath, {
        migrationId: 'move-1',
        storeId: 'renderer-a'
      })
    ).toEqual({ recorded: true })
    expect(record()?.phase).toBe('destination-committed')
    await recordWslMoveRendererStoreRewritten(userDataPath, {
      migrationId: 'move-1',
      storeId: 'renderer-b'
    })
    expect(record()?.rewrittenStores).toEqual(['main-a', 'renderer-a', 'renderer-b'])
    expect(record()?.phase).toBe('client-rewritten')
    expect(listPendingWslMoveRendererRewrites(userDataPath)).toMatchObject([{ storeIds: [] }])
  })

  it.each([
    ['an unknown store', { migrationId: 'move-1', storeId: 'nope' }, 'unknown-store'],
    ['a main-side store', { migrationId: 'move-1', storeId: 'main-a' }, 'not-renderer-store'],
    ['an unknown move', { migrationId: 'move-9', storeId: 'renderer-a' }, 'not-pending']
  ])('refuses %s', async (_label, request, reason) => {
    expect(await recordWslMoveRendererStoreRewritten(userDataPath, request)).toEqual({
      recorded: false,
      reason
    })
    expect(record()?.rewrittenStores).toEqual([])
  })

  it('refuses a store already recorded', async () => {
    const request = { migrationId: 'move-1', storeId: 'renderer-a' }
    await recordWslMoveRendererStoreRewritten(userDataPath, request)
    expect(await recordWslMoveRendererStoreRewritten(userDataPath, request)).toEqual({
      recorded: false,
      reason: 'not-pending'
    })
    expect(record()?.rewrittenStores).toEqual(['renderer-a'])
  })

  it('lists nothing and records nothing with the gate closed', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '')
    expect(listPendingWslMoveRendererRewrites(userDataPath)).toEqual([])
    expect(
      await recordWslMoveRendererStoreRewritten(userDataPath, {
        migrationId: 'move-1',
        storeId: 'renderer-a'
      })
    ).toEqual({ recorded: false, reason: 'gated-off' })
    expect(record()?.rewrittenStores).toEqual([])
  })
})

describe('WSL move renderer store registration', () => {
  it('waits on every renderer store the renderer knows how to rewrite', async () => {
    registerWslMoveRendererRewriteStores()
    await seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
    expect(listPendingWslMoveRendererRewrites(userDataPath)[0]?.storeIds).toEqual([
      ...WSL_MOVE_RENDERER_REWRITE_STORE_IDS
    ])
  })
})
