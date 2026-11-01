import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as osModule from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, it, vi } from 'vitest'
import { expectNoSyncSpawnOnWin32 } from '../../shared/windows-spawn-test-harness'
import type * as runProcessModule from '@orca/process-host'

const home = vi.hoisted(() => ({ dir: '' }))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof osModule>()),
  homedir: () => home.dir
}))

vi.mock('@orca/process-host', async (importOriginal) => {
  const actual = await importOriginal<typeof runProcessModule>()
  return {
    ...actual,
    runProcess: vi.fn(actual.runProcess),
    runProcessSync: vi.fn(actual.runProcessSync)
  }
})

home.dir = mkdtempSync(join(tmpdir(), 'orca-credential-writers-'))

afterAll(() => rmSync(home.dir, { recursive: true, force: true }))

describe('credential file writers on win32', () => {
  it('saves the encrypted api-key store with no synchronous spawn', async () => {
    const { createEncryptedApiKeyFileStore } = await import('./encrypted-api-key-file-store')
    const store = createEncryptedApiKeyFileStore({
      fileName: 'win32-spawn-test.enc',
      envelopePrefix: 'orca-win32-spawn-test:v1:',
      providerLabel: 'Test',
      logScope: 'test'
    })
    await expectNoSyncSpawnOnWin32(async () => {
      await store.save('sk-test-1234567890')
    })
  })

  it('saves the MiniMax session cookie with no synchronous spawn', async () => {
    const { saveMiniMaxSessionCookie } = await import('../minimax/minimax-cookie-store')
    await expectNoSyncSpawnOnWin32(async () => {
      await saveMiniMaxSessionCookie('_token=abc; minimax_group_id_v2=42')
    })
  })

  it('saves the GLM Coding Plan key with no synchronous spawn', async () => {
    const { saveZcodePlanApiKey } = await import('../zcode/zcode-plan-api-key-store')
    await expectNoSyncSpawnOnWin32(async () => {
      await saveZcodePlanApiKey('glm-secret')
    })
  })
})
