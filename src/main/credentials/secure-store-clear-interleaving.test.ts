// A clear issued at any point of a save must leave no file and no cached secret: the save is driven
// one scheduler turn at a time and the clear lands after each turn, through every await of the lane
// (directory create, temp write, file fsync, ACL, publishing rename, post-rename ACL and fsync).
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as osModule from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type * as runProcessModule from '../../shared/child-process/run-process'

const dirs = vi.hoisted(() => ({ home: '', userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => dirs.userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof osModule>()),
  homedir: () => dirs.home
}))

vi.mock('../../shared/child-process/run-process', async (importOriginal) => {
  const actual = await importOriginal<typeof runProcessModule>()
  return { ...actual, runProcess: vi.fn(actual.runProcess), runProcessSync: vi.fn() }
})

dirs.home = mkdtempSync(join(tmpdir(), 'orca-clear-interleave-home-'))
dirs.userData = mkdtempSync(join(tmpdir(), 'orca-clear-interleave-data-'))

afterAll(() => {
  rmSync(dirs.home, { recursive: true, force: true })
  rmSync(dirs.userData, { recursive: true, force: true })
})

const MAX_TURNS = 80

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

type Store = {
  save: () => Promise<unknown>
  clear: () => void
  hasFile: () => boolean
  readCached: () => unknown
}

/** Clears after 0, 1, 2, ... turns of a save until it finishes before the clear twice in a row. */
async function expectClearAlwaysWins(store: Store): Promise<number> {
  let settledBeforeClear = 0
  let turns = 0
  for (; turns < MAX_TURNS && settledBeforeClear < 2; turns += 1) {
    let settled = false
    const save = store.save().then(
      () => (settled = true),
      () => (settled = true)
    )
    for (let i = 0; i < turns; i += 1) {
      await nextTurn()
    }
    const saveFinishedFirst = settled
    store.clear()
    await save
    expect({ turns, file: store.hasFile() }).toEqual({ turns, file: false })
    expect({ turns, cached: store.readCached() }).toEqual({ turns, cached: null })
    settledBeforeClear = saveFinishedFirst ? settledBeforeClear + 1 : 0
  }
  return turns
}

describe('a clear always wins over a save in flight', () => {
  it('encrypted API key store', async () => {
    const { createEncryptedApiKeyFileStore } = await import('./encrypted-api-key-file-store')
    const store = createEncryptedApiKeyFileStore({
      fileName: 'interleave.enc',
      envelopePrefix: 'orca-interleave-test:v1:',
      providerLabel: 'Test',
      logScope: 'test'
    })
    const turns = await expectClearAlwaysWins({
      save: () => store.save('sk-interleave-secret'),
      clear: () => store.clear(),
      hasFile: () => store.has(),
      readCached: () => store.read()
    })
    expect(turns).toBeGreaterThan(2)
  })

  it('MiniMax session cookie store', async () => {
    const cookies = await import('../minimax/minimax-cookie-store')
    await expectClearAlwaysWins({
      save: () => cookies.saveMiniMaxSessionCookie('_token=secret; minimax_group_id_v2=1'),
      clear: () => cookies.clearMiniMaxSessionCookie(),
      hasFile: () => cookies.hasMiniMaxSessionCookie(),
      readCached: () => cookies.readMiniMaxSessionCookie()
    })
  })

  it('GLM Coding Plan key store', async () => {
    const keys = await import('../zcode/zcode-plan-api-key-store')
    await expectClearAlwaysWins({
      save: () => keys.saveZcodePlanApiKey('glm-interleave-secret'),
      clear: () => keys.clearZcodePlanApiKey(),
      hasFile: () => keys.hasZcodePlanApiKey(),
      readCached: () => keys.readZcodePlanApiKey()
    })
  })

  it('Orca cloud session store', async () => {
    const sessions = await import('../orca-profiles/profile-cloud-session-store')
    const profileId = 'interleave-profile'
    await expectClearAlwaysWins({
      save: () =>
        sessions.saveOrcaCloudSession(profileId, dirs.userData, {
          accessToken: 'access-secret',
          refreshToken: 'refresh-secret',
          expiresAt: 9_999,
          organizations: [{ orgId: 'org-1', name: 'Acme', role: 'Admin' }],
          capabilities: { flags: { share: true }, refreshedAt: 1 }
        }),
      clear: () => sessions.clearOrcaCloudSession(profileId, dirs.userData),
      hasFile: () => existsSync(sessions.getOrcaCloudSessionPath(profileId, dirs.userData)),
      readCached: () => {
        const result = sessions.readOrcaCloudSession(profileId, dirs.userData)
        return result.status === 'found' ? result.session : null
      }
    })
  })
})
