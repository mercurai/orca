import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { readPluginDeclaredSettings, writePluginDeclaredSetting } from './plugin-declared-settings'
import { PluginKvStore, type PluginKvWriteResult } from './plugin-storage-store'

const settings = [
  { key: 'apiUrl', title: 'Server URL', type: 'string' as const, default: 'https://example.com' },
  { key: 'pageSize', title: 'Page size', type: 'integer' as const, minimum: 1 }
]

function host() {
  const plugin = { manifest: { contributes: { settings } } }
  return {
    findValidPlugin: (key: string) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: settings code reads only manifest.contributes.settings.
      key === 'acme.todos' ? (plugin as never as ValidDiscoveredPlugin) : null,
    userDataPath: mkdtempSync(join(tmpdir(), 'orca-declared-settings-')),
    dataChanged: vi.fn()
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('declared plugin settings in Orca Settings', () => {
  it('shows defaults until the person sets a value, then theirs, and tells the plugin', async () => {
    const settingsHost = host()
    expect(readPluginDeclaredSettings(settingsHost, 'acme.todos')?.values).toEqual({
      apiUrl: 'https://example.com'
    })
    await expect(
      writePluginDeclaredSetting(settingsHost, 'acme.todos', 'pageSize', 50)
    ).resolves.toEqual({ ok: true })
    expect(settingsHost.dataChanged).toHaveBeenCalledWith('acme.todos', 'pageSize')
    await expect(
      writePluginDeclaredSetting(settingsHost, 'acme.todos', 'apiUrl', null)
    ).resolves.toEqual({ ok: true })
    expect(readPluginDeclaredSettings(settingsHost, 'acme.todos')?.values).toEqual({
      apiUrl: 'https://example.com',
      pageSize: 50
    })
  })

  it('refuses undeclared keys and values that do not fit', async () => {
    const settingsHost = host()
    await expect(
      writePluginDeclaredSetting(settingsHost, 'acme.todos', 'other', 1)
    ).resolves.toMatchObject({ ok: false })
    await expect(
      writePluginDeclaredSetting(settingsHost, 'acme.todos', 'pageSize', 0)
    ).resolves.toEqual({
      ok: false,
      error: 'Page size must be at least 1'
    })
    expect(settingsHost.dataChanged).not.toHaveBeenCalled()
    expect(readPluginDeclaredSettings(settingsHost, 'acme.none')).toBeNull()
  })

  it('tells the plugin only after a held set is durable', async () => {
    const settingsHost = host()
    let release: (result: PluginKvWriteResult) => void = () => undefined
    vi.spyOn(PluginKvStore.prototype, 'set').mockImplementation(
      () => new Promise<PluginKvWriteResult>((resolve) => (release = resolve))
    )
    const pending = writePluginDeclaredSetting(settingsHost, 'acme.todos', 'pageSize', 50)
    await Promise.resolve()
    await Promise.resolve()
    expect(settingsHost.dataChanged).not.toHaveBeenCalled()
    release({ ok: true })
    await expect(pending).resolves.toEqual({ ok: true })
    expect(settingsHost.dataChanged).toHaveBeenCalledTimes(1)
    expect(settingsHost.dataChanged).toHaveBeenCalledWith('acme.todos', 'pageSize')
  })

  it('returns a rejected set without telling the plugin', async () => {
    const settingsHost = host()
    vi.spyOn(PluginKvStore.prototype, 'set').mockResolvedValue({ ok: false, error: 'disk full' })
    await expect(
      writePluginDeclaredSetting(settingsHost, 'acme.todos', 'pageSize', 50)
    ).resolves.toEqual({ ok: false, error: 'disk full' })
    expect(settingsHost.dataChanged).not.toHaveBeenCalled()
  })

  it('tells the plugin only after a held reset-to-default delete finishes', async () => {
    const settingsHost = host()
    let release: () => void = () => undefined
    vi.spyOn(PluginKvStore.prototype, 'delete').mockImplementation(
      () => new Promise<void>((resolve) => (release = resolve))
    )
    const pending = writePluginDeclaredSetting(settingsHost, 'acme.todos', 'apiUrl', null)
    await Promise.resolve()
    await Promise.resolve()
    expect(settingsHost.dataChanged).not.toHaveBeenCalled()
    release()
    await expect(pending).resolves.toEqual({ ok: true })
    expect(settingsHost.dataChanged).toHaveBeenCalledWith('acme.todos', 'apiUrl')
  })
})
