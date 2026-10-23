import { withRuntimeEnvironmentMutation } from './runtime-environment-store-mutation'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from './pairing'
import { listEnvironments } from './runtime-environment-store'
import {
  addWslHostEnvironment,
  findWslHostDeployment,
  refreshWslHostPairing,
  removeWslHostEnvironment
} from './runtime-environment-wsl-host-store'
import { getPreferredPairingOffer } from './runtime-environments'

const publicKeyB64 = Buffer.alloc(32, 7).toString('base64')

function code(port: number, deviceToken = 'token-1'): string {
  return encodePairingOffer({
    v: 2,
    endpoint: `ws://127.0.0.1:${port}`,
    deviceToken,
    publicKeyB64
  })
}

const record = {
  kind: 'wsl' as const,
  distro: 'Ubuntu',
  distroId: '0e3a7f2c-1b4d-4c5e-9f60-7a8b9c0d1e2f',
  localPort: 42000,
  remotePort: 6768
}

describe('WSL host environment store', () => {
  let userDataPath: string
  beforeEach(async () => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-wsl-host-store-'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('registers a paired environment that reads back with its WSL deployment', async () => {
    await addWslHostEnvironment(userDataPath, {
      id: 'wsl:ubuntu',
      name: 'Ubuntu (WSL)',
      pairingCode: code(42000),
      record,
      now: 100
    })
    const [environment] = listEnvironments(userDataPath)
    expect(environment).toMatchObject({
      id: 'wsl:ubuntu',
      name: 'Ubuntu (WSL)',
      orcadDeployment: { kind: 'wsl', distro: 'Ubuntu', localPort: 42000, remotePort: 6768 }
    })
    expect(environment.connectionDependency).toBeUndefined()
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.createdAt).toBe(100)
  })

  it('refuses a pairing that does not point at the bridge port', async () => {
    await expect(
      async () =>
        await addWslHostEnvironment(userDataPath, {
          id: 'wsl:ubuntu',
          name: 'Ubuntu (WSL)',
          pairingCode: code(43000),
          record
        })
    ).rejects.toThrow(/does not point at its bridge/)
    expect(listEnvironments(userDataPath)).toEqual([])
  })

  it('persists a relaunch’s new device token and a moved bridge, and says so', async () => {
    await addWslHostEnvironment(userDataPath, {
      id: 'wsl:ubuntu',
      name: 'Ubuntu (WSL)',
      pairingCode: code(42000),
      record,
      now: 100
    })
    expect(
      (
        await refreshWslHostPairing(userDataPath, 'wsl:ubuntu', {
          pairingCode: code(42000),
          localPort: 42000,
          remotePort: 6768
        })
      ).pairingChanged
    ).toBe(false)

    const refreshed = await refreshWslHostPairing(
      userDataPath,
      'wsl:ubuntu',
      { pairingCode: code(42001, 'token-2'), localPort: 42001, remotePort: 6770 },
      500
    )
    expect(refreshed.pairingChanged).toBe(true)
    expect(getPreferredPairingOffer(refreshed.environment).deviceToken).toBe('token-2')
    expect(refreshed.environment.pairingRevision).toBe(500)
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')).toMatchObject({
      localPort: 42001,
      remotePort: 6770
    })
  })

  it('keeps a newer queued pairing when an older repair reaches the write lane', async () => {
    await addWslHostEnvironment(userDataPath, {
      id: 'wsl:ubuntu',
      name: 'Ubuntu (WSL)',
      pairingCode: code(42000),
      record,
      now: 100
    })
    const held = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const blocker = withRuntimeEnvironmentMutation(userDataPath, async () => {
      entered.resolve()
      await held.promise
    })
    await entered.promise
    const newer = refreshWslHostPairing(
      userDataPath,
      'wsl:ubuntu',
      {
        pairingCode: code(42001, 'newer-fixture-token'),
        localPort: 42001,
        remotePort: 6770
      },
      500
    )
    const stale = refreshWslHostPairing(
      userDataPath,
      'wsl:ubuntu',
      {
        pairingCode: code(42002, 'stale-fixture-token'),
        localPort: 42002,
        remotePort: 6771,
        expectedPairingRevision: 100
      },
      600
    )
    held.resolve()
    await blocker
    await newer
    const result = await stale
    expect(result.superseded).toBe(true)
    expect(result.pairingChanged).toBe(false)
    expect(getPreferredPairingOffer(result.environment).deviceToken).toBe('newer-fixture-token')
    expect(result.environment.pairingRevision).toBe(500)
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')).toMatchObject({
      localPort: 42001,
      remotePort: 6770
    })
  })

  it('removes the environment and its record', async () => {
    await addWslHostEnvironment(userDataPath, {
      id: 'wsl:ubuntu',
      name: 'Ubuntu (WSL)',
      pairingCode: code(42000),
      record
    })
    await removeWslHostEnvironment(userDataPath, 'wsl:ubuntu')
    expect(listEnvironments(userDataPath)).toEqual([])
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')).toBeNull()
  })
})
