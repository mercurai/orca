import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLUGIN_STORAGE_VALUE_MAX_BYTES } from '../../shared/plugins/plugin-host-api'
import { expectNoSyncSpawnOnWin32 } from '../../shared/windows-spawn-test-harness'
import { PluginKvStore } from './plugin-storage-store'

vi.mock('../../shared/child-process/run-process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/child-process/run-process')>()
  return {
    ...actual,
    runProcess: vi.fn(actual.runProcess),
    runProcessSync: vi.fn(actual.runProcessSync)
  }
})

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PluginKvStore limits', () => {
  it('enforces the value cap in UTF-8 bytes rather than JavaScript code units', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-storage-'))
    roots.push(root)
    const store = new PluginKvStore(root, 'orca-samples.demo', 'storage.json')
    const value = '😀'.repeat(Math.ceil(PLUGIN_STORAGE_VALUE_MAX_BYTES / 4) + 1)

    expect(await store.set('large', value)).toMatchObject({
      ok: false,
      error: expect.stringContaining('exceeds')
    })
    expect(store.get('large')).toBeUndefined()
  })

  it('persists a value on win32 with no synchronous spawn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-storage-'))
    roots.push(root)
    const store = new PluginKvStore(root, 'orca-samples.demo', 'storage.json')
    await expectNoSyncSpawnOnWin32(async () => {
      expect(await store.set('alpha', 1)).toEqual({ ok: true })
      await store.delete('alpha')
    })
  })
})
