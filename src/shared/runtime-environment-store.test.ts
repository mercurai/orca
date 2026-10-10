import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from './pairing'
import {
  RuntimeEnvironmentStoreError,
  addEnvironmentFromPairingCode,
  getEnvironmentStorePath,
  listEnvironments,
  MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES,
  removeEnvironment,
  updateEnvironmentFromPairingCode
} from './runtime-environment-store'
import { markEnvironmentUsed } from './runtime-environment-usage'
import { expectNoSyncSpawnOnWin32 } from './windows-spawn-test-harness'

vi.mock('./child-process/run-process', () => ({ runProcess: vi.fn(), runProcessSync: vi.fn() }))

function pairingCode(endpoint = 'ws://127.0.0.1:6768', pairedDeviceId?: string): string {
  return encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64'),
    ...(pairedDeviceId ? { pairedDeviceId } : {})
  })
}

describe('runtime environment store', () => {
  const tempDirs: string[] = []
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    // Why: this suite tests store timestamps, while secure-file tests cover Windows ACLs.
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects duplicate server names instead of silently replacing the saved server', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)

    const first = await addEnvironmentFromPairingCode(userDataPath, {
      name: 'dev box',
      pairingCode: pairingCode('ws://127.0.0.1:6768')
    })

    await expect(
      addEnvironmentFromPairingCode(userDataPath, {
        name: 'dev box',
        pairingCode: pairingCode('ws://192.0.2.10:6768')
      })
    ).rejects.toThrow(RuntimeEnvironmentStoreError)
    expect(listEnvironments(userDataPath)).toEqual([first])
  })

  it('advances pairing revisions across equal and backward clock readings', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    const environment = await addEnvironmentFromPairingCode(userDataPath, {
      name: 'dev box',
      pairingCode: pairingCode(),
      now: 100
    })

    const sameClock = await updateEnvironmentFromPairingCode(userDataPath, environment.id, {
      pairingCode: pairingCode('ws://192.0.2.10:6768'),
      now: 100
    })
    const backwardClock = await updateEnvironmentFromPairingCode(userDataPath, environment.id, {
      pairingCode: pairingCode('ws://192.0.2.11:6768'),
      now: 50
    })
    const laterClock = await updateEnvironmentFromPairingCode(userDataPath, environment.id, {
      pairingCode: pairingCode('ws://192.0.2.12:6768'),
      now: 200
    })

    expect([
      sameClock.pairingRevision,
      backwardClock.pairingRevision,
      laterClock.pairingRevision
    ]).toEqual([101, 102, 200])
  })

  it('keeps SSH-tunnel metadata only while the pairing endpoint is loopback', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    const environment = await addEnvironmentFromPairingCode(userDataPath, {
      name: 'tunneled box',
      pairingCode: pairingCode(),
      connectionDependency: 'ssh-tunnel'
    })
    expect(environment.connectionDependency).toBe('ssh-tunnel')

    const updated = await updateEnvironmentFromPairingCode(userDataPath, environment.id, {
      pairingCode: pairingCode('ws://192.0.2.10:6768')
    })
    expect(updated).not.toHaveProperty('connectionDependency')

    const direct = await addEnvironmentFromPairingCode(userDataPath, {
      name: 'direct box',
      pairingCode: pairingCode('ws://192.0.2.11:6768'),
      connectionDependency: 'ssh-tunnel'
    })
    expect(direct).not.toHaveProperty('connectionDependency')
  })

  it('throttles lastUsedAt writes so it does not rewrite the store on every runtime call', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    const env = await addEnvironmentFromPairingCode(userDataPath, {
      name: 'dev box',
      pairingCode: pairingCode()
    })

    // First use persists (lastUsedAt started null).
    await markEnvironmentUsed(userDataPath, env.id, { runtimeId: 'runtime-1', now: 1_000 })
    expect(listEnvironments(userDataPath)[0]).toMatchObject({
      lastUsedAt: 1_000,
      runtimeId: 'runtime-1'
    })

    // A second use shortly after, same runtime, is skipped — lastUsedAt stays put.
    await markEnvironmentUsed(userDataPath, env.id, { runtimeId: 'runtime-1', now: 5_000 })
    expect(listEnvironments(userDataPath)[0]!.lastUsedAt).toBe(1_000)

    // Once the throttle window elapses, it persists again.
    await markEnvironmentUsed(userDataPath, env.id, { runtimeId: 'runtime-1', now: 61_000 })
    expect(listEnvironments(userDataPath)[0]!.lastUsedAt).toBe(61_000)
  })

  it('persists immediately when the runtimeId changes within the throttle window', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    const env = await addEnvironmentFromPairingCode(userDataPath, {
      name: 'dev box',
      pairingCode: pairingCode()
    })

    await markEnvironmentUsed(userDataPath, env.id, { runtimeId: 'runtime-1', now: 1_000 })
    // A different runtimeId inside the window must not be dropped.
    await markEnvironmentUsed(userDataPath, env.id, { runtimeId: 'runtime-2', now: 2_000 })
    expect(listEnvironments(userDataPath)[0]).toMatchObject({
      lastUsedAt: 2_000,
      runtimeId: 'runtime-2'
    })
  })

  it('persists paired device identity from pairing and status backfill', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)
    const paired = await addEnvironmentFromPairingCode(userDataPath, {
      name: 'paired box',
      pairingCode: pairingCode('ws://127.0.0.1:6768', 'device-from-offer'),
      now: 1_000
    })
    const legacy = await addEnvironmentFromPairingCode(userDataPath, {
      name: 'legacy box',
      pairingCode: pairingCode('ws://192.0.2.10:6768'),
      now: 1_000
    })

    expect(paired.pairedDeviceId).toBe('device-from-offer')
    await markEnvironmentUsed(userDataPath, legacy.id, {
      pairedDeviceId: 'device-from-status',
      now: 2_000
    })
    expect(listEnvironments(userDataPath).find((entry) => entry.id === legacy.id)).toMatchObject({
      pairedDeviceId: 'device-from-status',
      lastUsedAt: 2_000
    })
  })

  it('rejects an oversized sparse environment store before parsing it', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-bound-'))
    tempDirs.push(userDataPath)
    const path = getEnvironmentStorePath(userDataPath)
    writeFileSync(path, '{"version":1,"environments":[]}')
    truncateSync(path, MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES + 1)

    expect(() => listEnvironments(userDataPath)).toThrow(RuntimeEnvironmentStoreError)
  })

  it('rejects an oversized write without replacing the durable environment list', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-write-bound-'))
    tempDirs.push(userDataPath)
    const first = await addEnvironmentFromPairingCode(userDataPath, {
      name: 'dev box',
      pairingCode: pairingCode()
    })

    await expect(
      addEnvironmentFromPairingCode(userDataPath, {
        name: 'x'.repeat(MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES),
        pairingCode: pairingCode('ws://192.0.2.10:6768')
      })
    ).rejects.toThrow(RuntimeEnvironmentStoreError)
    expect(listEnvironments(userDataPath)).toEqual([first])
  })

  it('keeps both environments when two pairings are added concurrently', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)

    await Promise.all([
      addEnvironmentFromPairingCode(userDataPath, {
        name: 'first box',
        pairingCode: pairingCode('ws://127.0.0.1:6768')
      }),
      addEnvironmentFromPairingCode(userDataPath, {
        name: 'second box',
        pairingCode: pairingCode('ws://192.0.2.10:6768')
      })
    ])

    expect(
      listEnvironments(userDataPath)
        .map((entry) => entry.name)
        .sort()
    ).toEqual(['first box', 'second box'])
  })

  it('spawns no synchronous process on win32 when writing the store', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-store-'))
    tempDirs.push(userDataPath)

    await expectNoSyncSpawnOnWin32(async () => {
      const env = await addEnvironmentFromPairingCode(userDataPath, {
        name: 'dev box',
        pairingCode: pairingCode()
      })
      await markEnvironmentUsed(userDataPath, env.id, { runtimeId: 'runtime-1', now: 1_000 })
      await updateEnvironmentFromPairingCode(userDataPath, env.id, {
        pairingCode: pairingCode('ws://192.0.2.10:6768')
      })
      await removeEnvironment(userDataPath, env.id)
    })
  })
})
