import { drainPendingPathWrites } from './path-write-serializer'
import { withRuntimeEnvironmentMutation } from './runtime-environment-store-mutation'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from './pairing'
import { listEnvironments } from './runtime-environment-store'
import {
  getEnvironmentStorePath,
  readPersistedEnvironmentStore
} from './runtime-environment-store-file'
import { getRuntimeEnvironmentSidecarPath } from './runtime-environment-sidecar'
import {
  addWslHostEnvironment,
  findWslHostDeployment,
  reconcileWslHostBridgePorts,
  refreshWslHostPairing,
  removeWslHostEnvironment,
  setWslHostPendingStop
} from './runtime-environment-wsl-host-store'
import { getPreferredPairingOffer } from './runtime-environments'
import {
  getWslHostDeploymentStorePath,
  writeWslHostDeployment,
  WslHostDeploymentStoreInvalidError
} from './wsl-host-deployment-store'

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

describe('WSL host environment store', async () => {
  let userDataPath: string
  beforeEach(async () => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-wsl-host-store-'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(async () => {
    await drainPendingPathWrites()
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

  it('updates pending removal under the mutation lane without replacing newer pairing fields', async () => {
    await addWslHostEnvironment(userDataPath, {
      id: 'wsl:ubuntu',
      name: 'Ubuntu (WSL)',
      pairingCode: code(42000),
      record,
      now: 100
    })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const blocked = withRuntimeEnvironmentMutation(userDataPath, async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    const operations: Promise<unknown>[] = [blocked]
    try {
      const refreshed = refreshWslHostPairing(userDataPath, 'wsl:ubuntu', {
        pairingCode: code(42001),
        localPort: 42001,
        remotePort: 6770
      })
      const pendingStop = { since: 200, reason: 'still running', verdict: 'live' as const }
      const pending = setWslHostPendingStop(userDataPath, 'wsl:ubuntu', pendingStop)
      operations.push(refreshed, pending)
      expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.pendingStop).toBeUndefined()
      release.resolve()
      await Promise.all([refreshed, pending])
      expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')).toMatchObject({
        localPort: 42001,
        remotePort: 6770,
        pendingStop
      })
      await setWslHostPendingStop(userDataPath, 'wsl:ubuntu', null)
      expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')).toMatchObject({
        localPort: 42001,
        remotePort: 6770
      })
      expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.pendingStop).toBeUndefined()
    } finally {
      release.resolve()
      await Promise.allSettled(operations)
    }
  })

  it('does not mark a replacement registration pending for an older removal', async () => {
    await addWslHostEnvironment(userDataPath, {
      id: 'wsl:ubuntu',
      name: 'Ubuntu (WSL)',
      pairingCode: code(42000),
      record,
      now: 200
    })
    await expect(
      setWslHostPendingStop(
        userDataPath,
        'wsl:ubuntu',
        { since: 300, reason: 'old removal', verdict: 'live' },
        100
      )
    ).rejects.toThrow('changed')
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.pendingStop).toBeUndefined()
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

  it('binds the record to the pairing key and follows a relaunch that changes it', async () => {
    await addWslHostEnvironment(userDataPath, {
      id: 'wsl:ubuntu',
      name: 'Ubuntu (WSL)',
      pairingCode: code(42000),
      record,
      now: 100
    })
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.pairingPublicKeyB64).toBe(
      publicKeyB64
    )
    const rotatedKey = Buffer.alloc(32, 9).toString('base64')
    const refreshed = await refreshWslHostPairing(userDataPath, 'wsl:ubuntu', {
      pairingCode: encodePairingOffer({
        v: 2,
        endpoint: 'ws://127.0.0.1:42000',
        deviceToken: 'token-2',
        publicKeyB64: rotatedKey
      }),
      localPort: 42000,
      remotePort: 6768
    })
    expect(refreshed.pairingChanged).toBe(true)
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.pairingPublicKeyB64).toBe(rotatedKey)
    expect(listEnvironments(userDataPath)[0]?.orcadDeployment).toMatchObject({ kind: 'wsl' })
  })

  it('writes nothing when a refreshed pairing does not point at the bridge', async () => {
    await addWslHostEnvironment(userDataPath, {
      id: 'wsl:ubuntu',
      name: 'Ubuntu (WSL)',
      pairingCode: code(42000),
      record,
      now: 100
    })
    const before = findWslHostDeployment(userDataPath, 'wsl:ubuntu')
    await expect(
      await refreshWslHostPairing(userDataPath, 'wsl:ubuntu', {
        pairingCode: code(43000, 'token-2'),
        localPort: 42001,
        remotePort: 6770
      })
    ).rejects.toThrow(/does not point at its bridge/)
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')).toEqual(before)
    expect(listEnvironments(userDataPath)[0]?.orcadDeployment).toMatchObject({ localPort: 42000 })
  })

  it('stays a WSL host if a key rotation is interrupted between its two writes', async () => {
    await addWslHostEnvironment(userDataPath, {
      id: 'wsl:ubuntu',
      name: 'Ubuntu (WSL)',
      pairingCode: code(42000),
      record,
      now: 100
    })
    const stored = findWslHostDeployment(userDataPath, 'wsl:ubuntu')
    if (!stored) {
      throw new Error('record missing')
    }
    await writeWslHostDeployment(userDataPath, 'wsl:ubuntu', {
      ...stored,
      pairingPublicKeyB64: Buffer.alloc(32, 9).toString('base64'),
      previousPairingPublicKeyB64: publicKeyB64
    })
    expect(listEnvironments(userDataPath)[0]?.orcadDeployment).toMatchObject({ kind: 'wsl' })
  })

  it('heals a crash between saving a moved bridge and its pairing, keeping the saved pairing', async () => {
    await addWslHostEnvironment(userDataPath, {
      id: 'wsl:ubuntu',
      name: 'Ubuntu (WSL)',
      pairingCode: code(42000),
      record,
      now: 100
    })
    const saved = findWslHostDeployment(userDataPath, 'wsl:ubuntu')
    if (!saved) {
      throw new Error('record missing')
    }
    // refreshWslHostPairing's record write landed; its pairing write never did.
    await writeWslHostDeployment(userDataPath, 'wsl:ubuntu', { ...saved, localPort: 42001 })
    const [crashed] = listEnvironments(userDataPath)
    expect(crashed?.orcadDeployment).toBeUndefined()

    expect(await reconcileWslHostBridgePorts(userDataPath)).toEqual(['wsl:ubuntu'])
    const [healed] = listEnvironments(userDataPath)
    expect(healed?.orcadDeployment).toMatchObject({ kind: 'wsl', localPort: 42000 })
    expect(healed && getPreferredPairingOffer(healed)).toEqual(
      crashed && getPreferredPairingOffer(crashed)
    )
    expect(await reconcileWslHostBridgePorts(userDataPath)).toEqual([])

    // The next connect saves both.
    await refreshWslHostPairing(userDataPath, 'wsl:ubuntu', {
      pairingCode: code(42002, 'token-2'),
      localPort: 42002,
      remotePort: 6768
    })
    expect(listEnvironments(userDataPath)[0]?.orcadDeployment).toMatchObject({ localPort: 42002 })
  })

  it('leaves a record written for a different pairing, or with no server, alone', async () => {
    await addWslHostEnvironment(userDataPath, {
      id: 'wsl:ubuntu',
      name: 'Ubuntu (WSL)',
      pairingCode: code(42000),
      record,
      now: 100
    })
    const saved = findWslHostDeployment(userDataPath, 'wsl:ubuntu')
    if (!saved) {
      throw new Error('record missing')
    }
    const otherKey = Buffer.alloc(32, 3).toString('base64')
    await writeWslHostDeployment(userDataPath, 'wsl:ubuntu', {
      ...saved,
      localPort: 42001,
      pairingPublicKeyB64: otherKey,
      previousPairingPublicKeyB64: otherKey
    })
    await writeWslHostDeployment(userDataPath, 'wsl:orphan', {
      ...saved,
      environmentId: 'wsl:orphan'
    })
    expect(await reconcileWslHostBridgePorts(userDataPath)).toEqual([])
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.localPort).toBe(42001)
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

  // A golden image with a baked-in orcad key: each distro is its own host, with its own grant.
  it('keeps two distros that carry the same orcad key as two hosts', async () => {
    await addWslHostEnvironment(userDataPath, {
      id: 'wsl:ubuntu',
      name: 'Ubuntu (WSL)',
      pairingCode: code(42000, 'token-ubuntu'),
      record
    })
    await addWslHostEnvironment(userDataPath, {
      id: 'wsl:ubuntu-2',
      name: 'Ubuntu-2 (WSL)',
      pairingCode: code(42001, 'token-ubuntu-2'),
      record: { ...record, distro: 'Ubuntu-2', localPort: 42001 }
    })
    const environments = listEnvironments(userDataPath)
    expect(environments.map((environment) => environment.id)).toEqual([
      'wsl:ubuntu',
      'wsl:ubuntu-2'
    ])
    expect(environments.map((environment) => getPreferredPairingOffer(environment))).toEqual([
      expect.objectContaining({ publicKeyB64, deviceToken: 'token-ubuntu' }),
      expect.objectContaining({ publicKeyB64, deviceToken: 'token-ubuntu-2' })
    ])
  })

  it('runs a conditional removal callback inside the lane before deleting either record', async () => {
    await addWslHostEnvironment(userDataPath, {
      id: 'wsl:ubuntu',
      name: 'Ubuntu (WSL)',
      pairingCode: code(42000),
      record,
      now: 100
    })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const blocker = withRuntimeEnvironmentMutation(userDataPath, async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    const beforeRemove = vi.fn(() => {
      expect(listEnvironments(userDataPath).map((entry) => entry.id)).toEqual(['wsl:ubuntu'])
      expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.createdAt).toBe(100)
    })
    const removal = removeWslHostEnvironment(userDataPath, 'wsl:ubuntu', 100, beforeRemove)
    expect(beforeRemove).not.toHaveBeenCalled()
    release.resolve()
    await blocker
    await expect(removal).resolves.toBe(true)
    expect(beforeRemove).toHaveBeenCalledTimes(1)
    expect(listEnvironments(userDataPath)).toEqual([])
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')).toBeNull()
  })

  it('skips a removal callback when the deployment identity changed', async () => {
    await addWslHostEnvironment(userDataPath, {
      id: 'wsl:ubuntu',
      name: 'Ubuntu (WSL)',
      pairingCode: code(42000),
      record,
      now: 200
    })
    const beforeRemove = vi.fn()
    await expect(
      removeWslHostEnvironment(userDataPath, 'wsl:ubuntu', 100, beforeRemove)
    ).resolves.toBe(false)
    expect(beforeRemove).not.toHaveBeenCalled()
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.createdAt).toBe(200)
  })

  it('propagates a removal callback error without deleting either record', async () => {
    await addWslHostEnvironment(userDataPath, {
      id: 'wsl:ubuntu',
      name: 'Ubuntu (WSL)',
      pairingCode: code(42000),
      record,
      now: 100
    })
    const failure = new Error('owner changed')
    await expect(
      removeWslHostEnvironment(userDataPath, 'wsl:ubuntu', 100, () => {
        throw failure
      })
    ).rejects.toBe(failure)
    expect(listEnvironments(userDataPath).map((entry) => entry.id)).toEqual(['wsl:ubuntu'])
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.createdAt).toBe(100)
  })

  it('rejects unreadable deployment state before running a removal callback', async () => {
    await addWslHostEnvironment(userDataPath, {
      id: 'wsl:ubuntu',
      name: 'Ubuntu (WSL)',
      pairingCode: code(42000),
      record,
      now: 100
    })
    writeFileSync(getWslHostDeploymentStorePath(userDataPath), '{"version":1,"deployments":{}}')
    const beforeRemove = vi.fn()
    await expect(
      removeWslHostEnvironment(userDataPath, 'wsl:ubuntu', undefined, beforeRemove)
    ).rejects.toThrow(WslHostDeploymentStoreInvalidError)
    expect(
      readPersistedEnvironmentStore(userDataPath).environments.map((entry) => entry.id)
    ).toEqual(['wsl:ubuntu'])
    expect(beforeRemove).not.toHaveBeenCalled()
  })

  it.each(['environment', 'sidecar'] as const)(
    'keeps both files and skips removal callbacks when the target %s is unreadable',
    async (unreadable) => {
      await addWslHostEnvironment(userDataPath, {
        id: 'wsl:ubuntu',
        name: 'Ubuntu (WSL)',
        pairingCode: code(42000),
        record,
        now: 100
      })
      const environmentPath = getEnvironmentStorePath(userDataPath)
      const deploymentPath = getWslHostDeploymentStorePath(userDataPath)
      const sidecarPath = getRuntimeEnvironmentSidecarPath(userDataPath)
      if (unreadable === 'environment') {
        const environment = readPersistedEnvironmentStore(userDataPath).environments[0]
        writeFileSync(
          environmentPath,
          JSON.stringify({
            version: 1,
            environments: [{ ...environment, kind: 'future-wsl-host' }]
          })
        )
      } else {
        writeFileSync(
          sidecarPath,
          JSON.stringify({
            version: 1,
            entries: { 'wsl:ubuntu': { binding: { createdAt: 'future-format' } } }
          })
        )
      }
      const environmentBefore = readFileSync(environmentPath)
      const deploymentBefore = readFileSync(deploymentPath)
      const sidecarBefore = unreadable === 'sidecar' ? readFileSync(sidecarPath) : undefined
      expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.createdAt).toBe(100)
      const beforeRemove = vi.fn()
      await expect(
        removeWslHostEnvironment(userDataPath, 'wsl:ubuntu', 100, beforeRemove)
      ).rejects.toThrow(/unreadable/)
      expect(beforeRemove).not.toHaveBeenCalled()
      expect(readFileSync(environmentPath)).toEqual(environmentBefore)
      expect(readFileSync(deploymentPath)).toEqual(deploymentBefore)
      if (sidecarBefore) {
        expect(readFileSync(sidecarPath)).toEqual(sidecarBefore)
      }
    }
  )
})
