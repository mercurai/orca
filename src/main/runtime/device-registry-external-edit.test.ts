// An admin's device removal on the host (or the pairing CLI's add) lands in the file while orcad
// runs; a later save from orcad's memory must never resurrect a removed device.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as secureFile from '../../shared/secure-file-async-write'
import { DeviceRegistry } from './device-registry'
import { DeviceRegistryStorage } from './device-registry-storage'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-device-registry-edit-'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

function fileIds(): string[] {
  const rows: { deviceId: string }[] = JSON.parse(
    readFileSync(join(dir, DEVICE_REGISTRY_FILENAME), 'utf8')
  )
  return rows.map((row) => row.deviceId)
}

/** What an admin does on the host: drop one row from the file, outside orcad. */
function removeOnDisk(deviceId: string): void {
  const path = join(dir, DEVICE_REGISTRY_FILENAME)
  const rows: { deviceId: string }[] = JSON.parse(readFileSync(path, 'utf8'))
  writeFileSync(path, JSON.stringify(rows.filter((row) => row.deviceId !== deviceId)))
}

/** A registry with two devices that have both connected once, so later sightings are deferred. */
async function pairedRegistry() {
  const registry = new DeviceRegistry(dir)
  const desktop = await registry.addDevice('desktop', 'runtime')
  const phone = await registry.addDevice('phone', 'mobile')
  await registry.updateLastSeen(desktop.deviceId)
  await registry.updateLastSeen(phone.deviceId)
  return { registry, desktop, phone }
}

describe('device registry saves over an externally edited file', () => {
  it('does not republish a revocation observed after rename while the write is settling', async () => {
    const { registry, desktop, phone } = await pairedRegistry()
    const published = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const original = DeviceRegistryStorage.prototype.write
    vi.spyOn(DeviceRegistryStorage.prototype, 'write').mockImplementationOnce(async function (
      this: DeviceRegistryStorage,
      devices,
      options,
      before
    ) {
      const written = await original.call(this, devices, options, before)
      published.resolve()
      await gate.promise
      return written
    })
    const saving = registry.updateLastSeen(phone.deviceId)
    await published.promise
    removeOnDisk(desktop.deviceId)
    expect(registry.validateToken(desktop.token)).toBeNull()
    gate.resolve()
    await saving
    expect(fileIds()).not.toContain(desktop.deviceId)
    expect(registry.validateToken(desktop.token)).toBeNull()
  })

  it('never republishes an external revocation observed during a staged write', async () => {
    const { registry, desktop, phone } = await pairedRegistry()
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const original = secureFile.writeSecureFileAsync
    vi.spyOn(secureFile, 'writeSecureFileAsync').mockImplementationOnce(
      async (path, content, options) => {
        entered.resolve()
        await gate.promise
        return original(path, content, options)
      }
    )
    const saving = registry.updateLastSeen(phone.deviceId)
    const outcome = expect(saving).rejects.toThrow()
    await entered.promise
    removeOnDisk(desktop.deviceId)
    expect(registry.validateToken(desktop.token)).toBeNull()
    gate.resolve()
    await outcome
    expect(fileIds()).not.toContain(desktop.deviceId)
    expect(registry.validateToken(desktop.token)).toBeNull()
  })

  it('does not return an externally revoked pending offer when re-advertised', async () => {
    const registry = new DeviceRegistry(dir)
    const prior = await registry.getOrCreatePendingDevice('phone', 'mobile')
    removeOnDisk(prior.deviceId)
    const replacement = await registry.getOrCreatePendingDevice('phone', 'mobile')
    expect(replacement.deviceId).not.toBe(prior.deviceId)
    expect(registry.validateToken(prior.token)).toBeNull()
  })

  it('keeps a device removed on disk removed through a pending lastSeen flush', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { registry, desktop, phone } = await pairedRegistry()
    registry.updateLastSeenDeferred(desktop.deviceId)

    removeOnDisk(desktop.deviceId)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(fileIds()).toEqual([phone.deviceId])
    expect(registry.getDevice(desktop.deviceId)).toBeNull()
    expect(registry.validateToken(desktop.token)).toBeNull()
  })

  it('keeps it removed through the shutdown flush', async () => {
    const { registry, desktop, phone } = await pairedRegistry()
    registry.updateLastSeenDeferred(desktop.deviceId)

    removeOnDisk(desktop.deviceId)
    // What RPC shutdown calls after closing transports.
    await registry.flushPendingLastSeen()

    expect(fileIds()).toEqual([phone.deviceId])
    expect(new DeviceRegistry(dir).getDevice(desktop.deviceId)).toBeNull()
  })

  it('keeps it removed when this process adds a device meanwhile', async () => {
    const { registry, desktop, phone } = await pairedRegistry()

    removeOnDisk(desktop.deviceId)
    const added = await registry.addDevice('second desktop', 'runtime')

    expect(fileIds()).toEqual([phone.deviceId, added.deviceId])
    expect(registry.getDevice(desktop.deviceId)).toBeNull()
  })

  it('keeps a device another writer added, and removes what this process removes', async () => {
    const { registry, desktop, phone } = await pairedRegistry()
    // E.g. the pairing CLI on the host, writing through its own registry instance.
    const added = await new DeviceRegistry(dir).addDevice('cli pairing', 'runtime')

    await registry.removeDevice(phone.deviceId)

    expect(fileIds()).toEqual([desktop.deviceId, added.deviceId])
    expect(registry.getDevice(added.deviceId)).not.toBeNull()
  })

  it('still drops the previous run’s session-only rows at load, not re-adding them from disk', async () => {
    const registry = new DeviceRegistry(dir)
    const desktop = await registry.addDevice('desktop', 'runtime')
    const fork = await registry.forkDeviceKey(
      desktop.deviceId,
      Buffer.alloc(32, 1).toString('base64'),
      'Tab',
      {
        ephemeral: true
      }
    )
    expect(fileIds()).toContain(fork.deviceId)

    const reloaded = new DeviceRegistry(dir)
    await reloaded.removeDevice('missing')

    expect(reloaded.getDevice(fork.deviceId)).toBeNull()
    expect(fileIds()).not.toContain(fork.deviceId)
  })

  // Review of #35483: a stale writer (an old orcad's flush during an upgrade overlap) puts back a
  // device this process revoked; the next save must not adopt it.
  it('never re-adopts a device this process removed when a stale writer puts it back', async () => {
    const { registry, desktop, phone } = await pairedRegistry()
    const path = join(dir, DEVICE_REGISTRY_FILENAME)
    const snapshot = readFileSync(path, 'utf8')

    expect(await registry.removeDevice(desktop.deviceId)).toBe(true)
    writeFileSync(path, snapshot)
    await registry.updateLastSeen(phone.deviceId)

    expect(fileIds()).toEqual([phone.deviceId])
    expect(registry.getDevice(desktop.deviceId)).toBeNull()
    expect(registry.validateToken(desktop.token)).toBeNull()
  })

  it('never re-adopts a session-only row whose load-time cleanup save failed', async () => {
    const registry = new DeviceRegistry(dir)
    const desktop = await registry.addDevice('desktop', 'runtime')
    const fork = await registry.forkDeviceKey(
      desktop.deviceId,
      Buffer.alloc(32, 1).toString('base64'),
      'Tab',
      { ephemeral: true }
    )
    const cleanupAttempt = Promise.withResolvers<void>()
    const writes = vi.spyOn(secureFile, 'writeSecureFileAsync').mockImplementationOnce(async () => {
      cleanupAttempt.resolve()
      throw new Error('disk full')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const reloaded = new DeviceRegistry(dir)
    await cleanupAttempt.promise
    expect(fileIds()).toContain(fork.deviceId)
    expect(reloaded.getDevice(fork.deviceId)).toBeNull()
    const added = await reloaded.addDevice('second desktop', 'runtime')

    expect(writes).toHaveBeenCalledTimes(2)
    expect(fileIds()).toEqual([desktop.deviceId, added.deviceId])
    expect(reloaded.getDevice(fork.deviceId)).toBeNull()
  })

  it('reports a row update as not applied when the row was removed on disk, and keeps it removed', async () => {
    const { registry, phone } = await pairedRegistry()

    removeOnDisk(phone.deviceId)
    const applied = await registry.setMobilePairingConnectionMode(phone.deviceId, 'local-only')

    expect(applied).toBe(false)
    expect(fileIds()).not.toContain(phone.deviceId)
    expect(registry.getDevice(phone.deviceId)).toBeNull()
  })

  // Review of #35483: a parent must never be handed the token of a child the file had dropped.
  it('returns no delegated child the save dropped because it was removed on disk', async () => {
    const { registry, desktop } = await pairedRegistry()
    const [child] = await registry.upsertDelegatedMobileDevices(desktop, [
      { phoneKey: 'phone-1', name: 'Pixel' }
    ])
    if (!child) {
      throw new Error('expected a delegated child')
    }

    removeOnDisk(child.deviceId)
    // A rename makes the plan rewrite the child row, which the merge then drops.
    const returned = await registry.upsertDelegatedMobileDevices(desktop, [
      { phoneKey: 'phone-1', name: 'Pixel 9' }
    ])

    expect(returned).toEqual([])
    expect(fileIds()).not.toContain(child.deviceId)
    expect(registry.validateToken(child.token)).toBeNull()
  })
})
