import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeviceRegistry } from './device-registry'
import { DeviceRegistryStorage } from './device-registry-storage'
import { devicePrincipalOf } from './device-principal'

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function paired() {
  const directory = await mkdtemp(join(tmpdir(), 'orca-first-sighting-'))
  directories.push(directory)
  const registry = new DeviceRegistry(directory)
  const row = await registry.addDevice('Synthetic phone', 'mobile')
  const principal = { ...devicePrincipalOf(row), deviceToken: row.token }
  return { directory, registry, row, principal }
}

function gatedWrite() {
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const realWrite = DeviceRegistryStorage.prototype.write
  const write = vi.spyOn(DeviceRegistryStorage.prototype, 'write')
  write.mockImplementationOnce(async function (this: DeviceRegistryStorage, devices, options) {
    entered.resolve()
    await gate.promise
    await realWrite.call(this, devices, options)
  })
  return { entered, gate, write }
}

describe('durable first-sighting admission', () => {
  it('shares one durable commit across concurrent sockets and publishes only after it settles', async () => {
    const { directory, registry, row, principal } = await paired()
    const { entered, gate, write } = gatedWrite()
    const first = registry.prepareDeviceAuthentication(principal)
    const second = registry.prepareDeviceAuthentication(principal)
    await entered.promise
    expect(write).toHaveBeenCalledOnce()
    expect(write.mock.calls[0][1]).toEqual({ durable: true })
    expect(registry.getDevice(row.deviceId)?.lastSeenAt).toBe(0)
    gate.resolve()
    await Promise.all([first, second])
    expect(registry.getDevice(row.deviceId)?.lastSeenAt).toBeGreaterThan(0)
    expect(new DeviceRegistry(directory).getDevice(row.deviceId)?.lastSeenAt).toBeGreaterThan(0)
    expect(write).toHaveBeenCalledOnce()
    // Settled first-sighting state leaves no pending admission or extra write on reconnect.
    expect(registry.prepareDeviceAuthentication(principal)).toBeUndefined()
    expect(write).toHaveBeenCalledOnce()
  })

  it('clears a failed shared write so a reconnect can retry without marking the phone seen', async () => {
    const { registry, row, principal } = await paired()
    const write = vi.spyOn(DeviceRegistryStorage.prototype, 'write')
    write.mockRejectedValueOnce(new Error('Synthetic first-sighting disk failure'))
    const first = registry.prepareDeviceAuthentication(principal)
    const second = registry.prepareDeviceAuthentication(principal)
    const outcomes = await Promise.allSettled([first, second])
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected'])
    expect(write).toHaveBeenCalledOnce()
    expect(registry.getDevice(row.deviceId)?.lastSeenAt).toBe(0)

    await registry.prepareDeviceAuthentication(principal)
    expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.calls[1][1]).toEqual({ durable: true })
    expect(registry.getDevice(row.deviceId)?.lastSeenAt).toBeGreaterThan(0)
  })

  it('rechecks the credential after taking the mutation lane instead of resurrecting a removed row', async () => {
    const { registry, row, principal } = await paired()
    const rotating = registry.rotatePendingDevice('Replacement phone', 'mobile')
    // Rotation has queued ahead of admission but has not replaced its row yet.
    const admission = Promise.resolve(registry.prepareDeviceAuthentication(principal)).then(
      () => null,
      (error: unknown) => error
    )
    expect((await rotating).deviceId).not.toBe(row.deviceId)
    expect(await admission).toBeInstanceOf(Error)
    expect(registry.getDevice(row.deviceId)).toBeNull()
  })

  it('refuses acceptance if revocation starts while the durable write is pending', async () => {
    const { registry, row, principal } = await paired()
    const { entered, gate } = gatedWrite()
    const admission = Promise.resolve(registry.prepareDeviceAuthentication(principal)).then(
      () => null,
      (error: unknown) => error
    )
    await entered.promise
    const release = registry.beginRevocation(row.deviceId)
    try {
      gate.resolve()
      expect(await admission).toBeInstanceOf(Error)
      expect(registry.resolveAuthenticatedPrincipal(principal)).toBeNull()
    } finally {
      release()
    }
  })

  it('does not queue or write on the established-phone synchronous fast path', async () => {
    const { registry, row, principal } = await paired()
    await registry.updateLastSeen(row.deviceId)
    const write = vi.spyOn(DeviceRegistryStorage.prototype, 'write')
    for (let socket = 0; socket < 10; socket += 1) {
      expect(registry.prepareDeviceAuthentication(principal)).toBeUndefined()
    }
    expect(write).not.toHaveBeenCalled()
  })
})
