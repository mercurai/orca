// A load that drops an unreadable row (e.g. one a newer Orca wrote) quarantines the file at the
// first save; that missing file is this process's own doing and must not revoke the valid rows.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as secureFile from '../../shared/secure-file-async-write'
import { DeviceRegistry } from './device-registry'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-device-registry-quarantine-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

function registryPath(): string {
  return join(dir, DEVICE_REGISTRY_FILENAME)
}

function fileIds(): string[] {
  const rows: { deviceId: string }[] = JSON.parse(readFileSync(registryPath(), 'utf8'))
  return rows.map((row) => row.deviceId)
}

function quarantinedCopies(): string[] {
  return readdirSync(dir).filter((name) => name.startsWith(`${DEVICE_REGISTRY_FILENAME}.corrupt-`))
}

/** A paired, seen phone in a file that also holds a row this build can't read. */
async function partiallyCorruptRegistry() {
  const first = new DeviceRegistry(dir)
  const phone = await first.addDevice('phone', 'mobile')
  await first.updateLastSeen(phone.deviceId)
  const rows: unknown[] = JSON.parse(readFileSync(registryPath(), 'utf8'))
  writeFileSync(registryPath(), JSON.stringify([...rows, { deviceId: 'x', bogus: true }]))
  const registry = new DeviceRegistry(dir)
  expect(registry.validateToken(phone.token)?.deviceId).toBe(phone.deviceId)
  return { registry, phone }
}

describe('device registry after quarantining its own corrupt file', () => {
  it('keeps every valid device through the first save', async () => {
    const { registry, phone } = await partiallyCorruptRegistry()

    const added = await registry.addDevice('new desktop', 'runtime')

    expect(quarantinedCopies()).toHaveLength(1)
    expect(fileIds()).toEqual([phone.deviceId, added.deviceId])
    expect(registry.validateToken(phone.token)?.deviceId).toBe(phone.deviceId)
    expect(new DeviceRegistry(dir).validateToken(phone.token)?.deviceId).toBe(phone.deviceId)
  })

  it('keeps them when the write after the quarantine failed, on the next save', async () => {
    const { registry, phone } = await partiallyCorruptRegistry()
    vi.spyOn(secureFile, 'writeSecureFileAsync').mockImplementationOnce(() => {
      throw new Error('disk full')
    })

    await expect(registry.addDevice('new desktop', 'runtime')).rejects.toThrow('disk full')
    expect(quarantinedCopies()).toHaveLength(1)
    expect(existsSync(registryPath())).toBe(false)
    const added = await registry.addDevice('new desktop', 'runtime')

    expect(fileIds()).toEqual([phone.deviceId, added.deviceId])
    expect(registry.validateToken(phone.token)?.deviceId).toBe(phone.deviceId)
  })

  it('still revokes everything when the file is deleted after its own write landed', async () => {
    const { registry, phone } = await partiallyCorruptRegistry()
    await registry.addDevice('new desktop', 'runtime')

    rmSync(registryPath())
    const added = await registry.addDevice('second desktop', 'runtime')

    expect(fileIds()).toEqual([added.deviceId])
    expect(registry.validateToken(phone.token)).toBeNull()
  })

  it('revokes everything when an intact file is deleted, as before', async () => {
    const registry = new DeviceRegistry(dir)
    const phone = await registry.addDevice('phone', 'mobile')

    rmSync(registryPath())
    const added = await registry.addDevice('desktop', 'runtime')

    expect(fileIds()).toEqual([added.deviceId])
    expect(registry.getDevice(phone.deviceId)).toBeNull()
    expect(registry.validateToken(phone.token)).toBeNull()
  })

  it('treats a corrupt file deleted by someone else before the quarantine as a revoke', async () => {
    const { registry, phone } = await partiallyCorruptRegistry()

    rmSync(registryPath())
    const added = await registry.addDevice('new desktop', 'runtime')

    expect(quarantinedCopies()).toEqual([])
    expect(fileIds()).toEqual([added.deviceId])
    expect(registry.validateToken(phone.token)).toBeNull()
  })
})
