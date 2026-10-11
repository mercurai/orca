import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DeviceRegistry } from '../device-registry'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime-rpc'

describe('mobile revoke fails closed', () => {
  it('refuses the phone token while the push-unregister outbox write is still pending', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-revoke-window-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
    const registry = new DeviceRegistry(userDataPath)
    const device = await registry.addDevice('phone', 'mobile')
    server['deviceRegistry'] = registry

    let releaseOutbox: () => void = () => undefined
    const outboxWrite = new Promise<void>((resolve) => (releaseOutbox = resolve))
    // The outbox write is the first await of the revoke; hold it open.
    server['queuePushUnregister'] = async () => await outboxWrite

    const revoke = server.revokeMobileDevice(device.deviceId)
    expect(registry.validateToken(device.token)).toBeNull()
    releaseOutbox()

    await expect(revoke).resolves.toBe(true)
    expect(registry.validateToken(device.token)).toBeNull()
    rmSync(userDataPath, { recursive: true, force: true })
  })
})
