import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PluginAuditLog } from './plugin-audit-log'
import { PluginKvStore } from './plugin-storage-store'
import { getPluginsDataDir, getUserPluginsDir } from './plugin-discovery'
import { installPluginFromLocalPath } from './installation/plugin-install'
import {
  createUninstallFixture,
  prepareUninstallFixture,
  removeThroughPluginIpc,
  resetUninstallFixtures
} from './__mocks__/plugin-uninstall-log-test-fixture'

beforeEach(prepareUninstallFixture)
afterEach(resetUninstallFixtures)

async function settingsPlugin() {
  const fixture = await createUninstallFixture()
  const key = await fixture.install('data-lifetime')
  const sourcePath = join(fixture.root, 'sources', 'data-lifetime')
  const manifestPath = join(sourcePath, 'orca-plugin.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.capabilities = [{ kind: 'settings:own' }]
  await writeFile(manifestPath, JSON.stringify(manifest))
  const reinstall = async () => {
    const result = await installPluginFromLocalPath({
      pluginsDir: getUserPluginsDir(fixture.root),
      sourcePath,
      hostVersion: '1.4.0'
    })
    if (!result.ok) {
      throw new Error(result.error)
    }
    fixture.store.updateSettings({
      pluginConsents: {
        ...fixture.store.getSettings().pluginConsents,
        [key]: result.consentFingerprint
      }
    })
    await fixture.service.refresh()
  }
  await reinstall()
  fixture.service.setRuntimeDelegate({
    resolveActiveWorktreeContext: async () => null,
    listTerminals: async () => ({ terminals: [] }),
    sendTerminal: async () => ({ accepted: false }),
    dispatchPluginNotification: async () => ({ delivered: false })
  })
  return { ...fixture, key, reinstall }
}

it('cannot publish a call held in audit after removal and an identical reinstall', async () => {
  const { root, service, key, reinstall } = await settingsPlugin()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const original = PluginAuditLog.prototype.record
  let held = false
  vi.spyOn(PluginAuditLog.prototype, 'record').mockImplementation(async function (
    this: PluginAuditLog,
    entry
  ) {
    if (!held && entry.method === 'settings.set' && entry.outcome === 'attempt') {
      held = true
      entered.resolve()
      await release.promise
    }
    await original.call(this, entry)
  })
  const oldCall = service.executeHostCall(
    key, 'settings.set', { key: 'value', value: 'synthetic-old' }, 'worker'
  )
  try {
    await entered.promise
    await removeThroughPluginIpc(key)
    await reinstall()
    expect(await service.executeHostCall(
      key, 'settings.set', { key: 'value', value: 'synthetic-current' }, 'worker'
    )).toMatchObject({ ok: true })
    release.resolve()
    expect(await oldCall).toMatchObject({ ok: false, code: 'action_failed' })
    const current = new PluginKvStore(getPluginsDataDir(root), key, 'settings.json')
    expect(current.get('value')).toBe('synthetic-current')
  } finally {
    release.resolve()
    await oldCall
  }
})

it('denies host-call admission during removal without changing capability metadata', async () => {
  const { root, service, key } = await settingsPlugin()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const removal = service.removePlugin(key, async () => {
    entered.resolve()
    await release.promise
    throw new Error('Controlled removal failure')
  }).catch((error: unknown) => error)
  try {
    await entered.promise
    expect(service.getGrantedCapabilities(key)).toEqual(['settings:own'])
    expect(await service.executeHostCall(
      key, 'settings.set', { key: 'value', value: 'synthetic-rejected' }, 'worker'
    )).toMatchObject({ ok: false })
    expect(new PluginKvStore(getPluginsDataDir(root), key, 'settings.json').get('value'))
      .toBeUndefined()
  } finally {
    release.resolve()
  }
  expect(await removal).toEqual(new Error('Controlled removal failure'))
  expect(await service.executeHostCall(
    key, 'settings.set', { key: 'value', value: 'synthetic-recovered' }, 'worker'
  )).toMatchObject({ ok: true })
})
