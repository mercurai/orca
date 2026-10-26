import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeviceRegistry } from '../device-registry'
import { OrcaRuntimeService } from '../orca-runtime'
import type { RelayRevokeOutboxItem } from '../mobile-cloud-relay/relay-revoke-outbox'
import { OrcaRuntimeRpcServer } from '../runtime-rpc'

const dirs: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function serverWithRegistry() {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-revoke-window-'))
  dirs.push(userDataPath)
  const server = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath,
    enableWebSocket: false
  })
  const registry = new DeviceRegistry(userDataPath)
  server['deviceRegistry'] = registry
  return { server, registry }
}

/** Holds the Relay outbox write open until the test settles it. */
function holdRelayOutboxWrite(server: OrcaRuntimeRpcServer) {
  let fail: (error: Error) => void = () => undefined
  const write = new Promise<RelayRevokeOutboxItem>((_resolve, reject) => (fail = reject))
  vi.spyOn(server.getRelayRevokeOutbox(), 'enqueue').mockReturnValue(write)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  return { fail: () => fail(new Error('disk full')) }
}

describe('mobile revoke fails closed', () => {
  it('refuses the phone token while the push-unregister outbox write is still pending', async () => {
    const { server, registry } = serverWithRegistry()
    const device = await registry.addDevice('phone', 'mobile')

    let releaseOutbox: () => void = () => undefined
    const outboxWrite = new Promise<void>((resolve) => (releaseOutbox = resolve))
    // The outbox write is the first await of the revoke; hold it open.
    server['queuePushUnregister'] = async () => await outboxWrite

    const revoke = server.revokeMobileDevice(device.deviceId)
    expect(registry.validateToken(device.token)).toBeNull()
    releaseOutbox()

    await expect(revoke).resolves.toBe(true)
    expect(registry.validateToken(device.token)).toBeNull()
  })

  it('refuses the phone token during a pending Relay outbox write and accepts it again when that write fails', async () => {
    const { server, registry } = serverWithRegistry()
    const device = await registry.addDevice('phone', 'mobile')
    await registry.setRelayBinding(device.deviceId, {
      relayHostId: 'host',
      relayDeviceId: device.deviceId,
      ownerIdentityKey: 'owner'
    })
    const outbox = holdRelayOutboxWrite(server)

    const revoke = server.revokeMobileDevice(device.deviceId)
    expect(registry.validateToken(device.token)).toBeNull()
    expect(registry.lookupDeviceKey(device.deviceId)).toEqual({ kind: 'unavailable' })
    outbox.fail()

    await expect(revoke).resolves.toBe(false)
    expect(registry.getDevice(device.deviceId)).not.toBeNull()
    expect(registry.validateToken(device.token)).not.toBeNull()
  })

  it('refuses a runtime device and its delegated phones while a child cleanup write is pending, and mints no new child', async () => {
    const { server, registry } = serverWithRegistry()
    const parent = await registry.addDevice('desktop', 'runtime')
    const [child] = await registry.upsertDelegatedMobileDevices(parent, [
      { phoneKey: 'p', name: 'p' }
    ])
    await registry.setRelayBinding(child!.deviceId, {
      relayHostId: 'host',
      relayDeviceId: child!.deviceId,
      ownerIdentityKey: 'owner'
    })
    const outbox = holdRelayOutboxWrite(server)

    const revoke = server.revokeRuntimeAccess(parent.deviceId)
    expect(registry.validateToken(parent.token)).toBeNull()
    expect(registry.validateToken(child!.token)).toBeNull()
    await expect(
      registry.upsertDelegatedMobileDevices(parent, [{ phoneKey: 'q', name: 'q' }])
    ).rejects.toThrow('delegated_device_parent_unavailable')
    outbox.fail()

    await expect(revoke).resolves.toBe(false)
    expect(registry.validateToken(parent.token)).not.toBeNull()
    expect(registry.listDelegatedMobileDevices(parent.deviceId)).toHaveLength(1)
  })
})
