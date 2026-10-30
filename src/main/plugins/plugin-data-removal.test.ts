import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { capturePluginDataLifetime } from './plugin-data-mutation'
import { removeInstalledPlugin } from './installation/plugin-removal'
import { PluginKvStore } from './plugin-storage-store'
import { PluginSecretsStore } from './plugin-secrets-store'

const writes = vi.hoisted(
  (): {
    hold:
      | undefined
      | {
          entered: () => void
          release: Promise<void>
        }
  } => ({ hold: undefined })
)

vi.mock('../../shared/secure-file-async-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/secure-file-async-write')>()
  return {
    ...actual,
    writeSecureFileAsync: async (...args: Parameters<typeof actual.writeSecureFileAsync>) => {
      const hold = writes.hold
      writes.hold = undefined
      if (hold) {
        hold.entered()
        await hold.release
      }
      return actual.writeSecureFileAsync(...args)
    }
  }
})

vi.mock('../host/safe-storage-availability', () => ({
  guardedSafeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`synthetic-encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString().slice('synthetic-encrypted:'.length)
  }
}))

const roots: string[] = []
afterEach(async () => {
  writes.hold = undefined
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it.each(['storage.json', 'settings.json', 'secrets.json.enc'] as const)(
  'drains and retires old %s mutations across removal and fresh reinstall',
  async (fileName) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-data-removal-'))
    roots.push(root)
    const pluginsDir = join(root, 'plugins')
    const pluginsDataDir = join(root, 'data')
    const pluginKey = 'samples.lifetime'
    const directory = join(pluginsDataDir, pluginKey)
    const create = () =>
      fileName === 'secrets.json.enc'
        ? new PluginSecretsStore(pluginsDataDir, pluginKey)
        : new PluginKvStore(pluginsDataDir, pluginKey, fileName)
    await mkdir(join(pluginsDir, pluginKey), { recursive: true })
    const old = create()
    const queuedOld = create()
    const lifetime = capturePluginDataLifetime(directory)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    writes.hold = { entered: entered.resolve, release: release.promise }
    const active = old.set('active', 'synthetic-old')
    await entered.promise
    const queued = queuedOld.set('queued', 'synthetic-queued')
    const queuedDelete = queuedOld.delete('fresh')
    let removed = false
    const removal = removeInstalledPlugin({ pluginsDir, pluginsDataDir, pluginKey }).then(() => {
      removed = true
    })
    try {
      await vi.waitFor(() => expect(lifetime()).toBe(false))
      const duringRemoval = create()
      expect(removed).toBe(false)
      release.resolve()
      expect(await active).toMatchObject({ ok: false })
      expect(await queued).toMatchObject({ ok: false })
      await queuedDelete
      await removal
      await expect(readFile(join(directory, fileName))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await duringRemoval.set('late', 'synthetic-middle')).toMatchObject({ ok: false })
      await mkdir(join(pluginsDir, pluginKey), { recursive: true })
      const fresh = create()
      expect(await fresh.set('fresh', 'synthetic-current')).toMatchObject({ ok: true })
      expect(old.get('fresh')).toEqual(
        fileName === 'secrets.json.enc'
          ? { ok: false, error: 'plugin data lifetime expired' }
          : undefined
      )
      expect(queuedOld.get('fresh')).toEqual(
        fileName === 'secrets.json.enc'
          ? { ok: false, error: 'plugin data lifetime expired' }
          : undefined
      )
      if (old instanceof PluginKvStore) {
        expect(old.getAll()).toEqual({})
        expect(old.keys()).toEqual([])
      }
      expect(await old.set('late', 'synthetic-retired')).toMatchObject({ ok: false })
      await old.delete('fresh')
      await queuedOld.delete('fresh')
      const current = fresh.get('fresh')
      expect(current).toEqual(
        fileName === 'secrets.json.enc'
          ? { ok: true, value: 'synthetic-current' }
          : 'synthetic-current'
      )
      const bytes = await readFile(join(directory, fileName), 'utf8')
      expect(bytes).not.toContain('synthetic-retired')
      expect(bytes).not.toContain('synthetic-middle')
      expect(bytes).not.toContain('synthetic-queued')
    } finally {
      release.resolve()
      await Promise.allSettled([active, queued, queuedDelete, removal])
    }
  }
)
