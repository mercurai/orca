import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as SecureFileAsyncWrite from '../../shared/secure-file-async-write'

const failNextWrite = vi.hoisted(() => ({ armed: false }))

vi.mock('../../shared/secure-file-async-write', async (importOriginal) => {
  const actual = await importOriginal<typeof SecureFileAsyncWrite>()
  return {
    ...actual,
    writeSecureJsonFileAsync: async (
      ...args: Parameters<typeof actual.writeSecureJsonFileAsync>
    ) => {
      if (failNextWrite.armed) {
        failNextWrite.armed = false
        throw new Error('disk full')
      }
      return await actual.writeSecureJsonFileAsync(...args)
    }
  }
})

vi.mock('../../shared/child-process/run-process', () => ({
  runProcess: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false })),
  runProcessSync: vi.fn()
}))

import { DeviceRegistry } from './device-registry'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function registry(): DeviceRegistry {
  const directory = mkdtempSync(join(tmpdir(), 'orca-device-revoke-'))
  directories.push(directory)
  return new DeviceRegistry(directory)
}

describe('device revocation', () => {
  it('refuses the revoked token while the removal is still being written', async () => {
    const devices = registry()
    const device = await devices.addDevice('phone')
    expect(devices.validateToken(device.token)?.deviceId).toBe(device.deviceId)

    const removal = devices.removeDevice(device.deviceId)
    // The write is async; the token must already fail before it lands.
    expect(devices.validateToken(device.token)).toBeNull()

    await expect(removal).resolves.toBe(true)
    expect(devices.validateToken(device.token)).toBeNull()
  })

  it('accepts the token again when the removal write fails', async () => {
    const devices = registry()
    const device = await devices.addDevice('phone')
    failNextWrite.armed = true

    await expect(devices.removeDevice(device.deviceId)).rejects.toThrow('disk full')
    expect(devices.validateToken(device.token)?.deviceId).toBe(device.deviceId)
  })

  it('refuses the token from the start of a multi-step revoke until it is released', async () => {
    const devices = registry()
    const device = await devices.addDevice('phone')

    const releaseOuter = devices.beginRevocation(device.deviceId)
    const releaseInner = devices.beginRevocation(device.deviceId)
    expect(devices.validateToken(device.token)).toBeNull()
    releaseInner()
    releaseInner() // idempotent
    expect(devices.validateToken(device.token)).toBeNull()
    releaseOuter()
    expect(devices.validateToken(device.token)?.deviceId).toBe(device.deviceId)
  })
})
