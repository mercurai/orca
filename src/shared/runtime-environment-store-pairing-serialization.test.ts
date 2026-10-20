import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { encodePairingOffer } from './pairing'
import {
  addOrUpdateEnvironmentFromPairingCode,
  listEnvironments
} from './runtime-environment-store'

// Exercise the real host filesystem and fsync handle modes; native DACL coverage lives elsewhere.
vi.mock('./windows-security-addon', () => ({ loadWindowsSecurity: () => ({
    error: 'native DACL intentionally unavailable in storage ordering fixture'
  }) }))

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-pairing-serialization-'))
})
afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

it('serializes simultaneous verified pairings of one host into one durable identity', async () => {
  const pairingCode = (deviceToken: string) =>
    encodePairingOffer({
      v: 2,
      endpoint: 'ws://192.0.2.10:6768',
      publicKeyB64: Buffer.alloc(32, 7).toString('base64'),
      deviceToken
    })
  const [first, second] = await Promise.all([
    addOrUpdateEnvironmentFromPairingCode(userDataPath, {
      name: 'first name',
      pairingCode: pairingCode('first-token'),
      now: 10
    }),
    addOrUpdateEnvironmentFromPairingCode(userDataPath, {
      name: 'second name',
      pairingCode: pairingCode('second-token'),
      now: 10,
      runtimeId: 'runtime-1'
    })
  ])
  expect(first.updatedExisting).toBe(false)
  expect(second.updatedExisting).toBe(true)
  expect(second.environment.id).toBe(first.environment.id)
  expect(second.environment.name).toBe('first name')
  expect(second.environment.pairingRevision).toBe(11)
  expect(second.environment.runtimeId).toBe('runtime-1')
  expect(listEnvironments(userDataPath)).toEqual([second.environment])
  expect(second.environment.endpoints[0]?.deviceToken).toBe('second-token')
})
