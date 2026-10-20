import { addManagedOrcadEnvironment } from './runtime-environment-managed-orcad-store'
import { pairedRuntimeConnectionFromOffer } from './paired-runtime-connection'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodePairingOffer } from './pairing'
import {
  addEnvironmentFromPairingCode,
  getEnvironmentStorePath,
  listEnvironments,
  removeEnvironment
} from './runtime-environment-store'
import {
  getRuntimeEnvironmentSidecarPath,
  writeRuntimeEnvironmentSidecarEntry
} from './runtime-environment-sidecar'
import { assertRuntimeEnvironmentNotReconciling } from './runtime-environment-reconciliation-record'
import {
  linkVerifiedRuntimeEnvironmentSshAccess,
  prepareRuntimeEnvironmentSshAccessLink
} from './runtime-environment-ssh-access-store'
import { readPersistedEnvironmentStore } from './runtime-environment-store-file'
import { shippedBuildRewrite } from './runtime-environment-shipped-store.test-fixture'

const pairing = {
  v: 2 as const,
  endpoint: 'wss://server.example/runtime',
  publicKeyB64: Buffer.alloc(32, 1).toString('base64'),
  deviceToken: 'private-device-token',
  pairedDeviceId: 'paired-client'
}
const tunnel = { sshTargetId: 'target', sshTargetGeneration: 3, localPort: 41000, remotePort: 6768 }

describe('runtime environment sidecar across a downgrade', () => {
  let userDataPath: string
  beforeEach(async () => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-environment-sidecar-'))
  })
  afterEach(async () => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  async function linked() {
    const seeded = await addEnvironmentFromPairingCode(userDataPath, {
      name: 'Host',
      pairingCode: encodePairingOffer(pairing),
      now: 100
    })
    const prepared = await prepareRuntimeEnvironmentSshAccessLink(userDataPath, {
      expectedEnvironment: seeded,
      requestId: 'link-request',
      ...tunnel,
      targetFingerprint: 'target-fingerprint'
    })
    return await linkVerifiedRuntimeEnvironmentSshAccess(userDataPath, {
      expectedEnvironment: prepared,
      requestId: 'link-request',
      verifiedRuntimeId: 'host-runtime',
      verifiedConnection: pairedRuntimeConnectionFromOffer({
        ...pairing,
        endpoint: 'ws://127.0.0.1:41000/runtime'
      }),
      tunnel,
      now: 90
    })
  }

  it('preserves a newer registered owner absent from the caller snapshot', async () => {
    const first = await addEnvironmentFromPairingCode(userDataPath, {
      name: 'First',
      pairingCode: encodePairingOffer(pairing),
      now: 100
    })
    const stale = readPersistedEnvironmentStore(userDataPath).environments
    const opaque = { futureVersion: 99 }
    writeFileSync(
      getRuntimeEnvironmentSidecarPath(userDataPath),
      JSON.stringify({
        version: 1,
        entries: { future: opaque }
      })
    )
    const second = addManagedOrcadEnvironment(userDataPath, {
      id: 'second',
      name: 'Second',
      now: 200,
      pairingCode: encodePairingOffer({ ...pairing, endpoint: 'ws://127.0.0.1:41000' }),
      orcadDeployment: tunnel
    })
    const [registered] = await Promise.all([
      second,
      writeRuntimeEnvironmentSidecarEntry(userDataPath, stale, first, {
        orcadMigratedAt: '2026-10-18T00:00:00.000Z'
      })
    ])
    expect(
      listEnvironments(userDataPath).find((entry) => entry.id === registered.id)?.orcadDeployment
    ).toEqual(tunnel)
    expect(
      listEnvironments(userDataPath).find((entry) => entry.id === first.id)?.orcadMigratedAt
    ).toBe('2026-10-18T00:00:00.000Z')
    expect(
      JSON.parse(readFileSync(getRuntimeEnvironmentSidecarPath(userDataPath), 'utf8')).entries
        .future
    ).toEqual(opaque)
  })

  it('keeps SSH access after a shipped build rewrites orca-environments.json', async () => {
    const access = await linked()
    shippedBuildRewrite(userDataPath, (environments) => {
      environments[0]!.lastUsedAt = 500
      environments[0]!.runtimeId = 'host-runtime'
    })
    const [restored] = listEnvironments(userDataPath)
    expect(restored?.sshAccess).toEqual(access.sshAccess)
    expect(restored?.preferredEndpointId).toBe(access.preferredEndpointId)
    expect(restored?.lastUsedAt).toBe(500)
  })

  it('reads a link as stale once a shipped build re-pairs the server, and prunes it on the next write', async () => {
    const access = await linked()
    shippedBuildRewrite(userDataPath, (environments) => {
      environments[0]!.pairingRevision = 200
    })
    const [restored] = listEnvironments(userDataPath)
    expect(restored?.sshAccess).toBeUndefined()
    expect(restored?.preferredEndpointId).toBe(access.sshAccess?.previousPreferredEndpointId)
    expect(restored?.connectionDependency).toBeUndefined()

    const persisted = readPersistedEnvironmentStore(userDataPath).environments
    await writeRuntimeEnvironmentSidecarEntry(userDataPath, persisted, persisted[0]!, null)
    expect(
      JSON.parse(readFileSync(getRuntimeEnvironmentSidecarPath(userDataPath), 'utf8'))
    ).toEqual({ version: 1, entries: {} })
  })

  it('ignores a dangling entry for a server a shipped build removed', async () => {
    await linked()
    shippedBuildRewrite(userDataPath, (environments) => {
      environments.splice(0, 1)
    })
    expect(listEnvironments(userDataPath)).toEqual([])
    const other = await addEnvironmentFromPairingCode(userDataPath, {
      name: 'Other',
      pairingCode: encodePairingOffer(pairing)
    })
    expect(listEnvironments(userDataPath)).toEqual([other])
  })

  it('refuses ordinary removal while linked, and drops the entry when an unlinked server is removed', async () => {
    const access = await linked()
    await expect(removeEnvironment(userDataPath, access.id)).rejects.toThrow('Unlink')
    const plain = await addEnvironmentFromPairingCode(userDataPath, {
      name: 'Plain',
      pairingCode: encodePairingOffer({
        ...pairing,
        publicKeyB64: Buffer.alloc(32, 2).toString('base64')
      })
    })
    await removeEnvironment(userDataPath, plain.id)
    expect(listEnvironments(userDataPath).map((entry) => entry.id)).toEqual([access.id])
  })

  it('fails closed on an unreadable sidecar instead of dropping a pinned host key', async () => {
    await linked()
    writeFileSync(getRuntimeEnvironmentSidecarPath(userDataPath), '{not json')
    expect(() => listEnvironments(userDataPath)).toThrow('Orca environment links')
  })

  it('overlays a reconciliation record so lifecycle changes refuse while it exists', async () => {
    const seeded = await addEnvironmentFromPairingCode(userDataPath, {
      name: 'Host',
      pairingCode: encodePairingOffer(pairing),
      now: 100
    })
    const persisted = readPersistedEnvironmentStore(userDataPath).environments
    await writeRuntimeEnvironmentSidecarEntry(userDataPath, persisted, persisted[0]!, {
      reconciliation: {
        version: 1,
        stage: 'prepared',
        requestId: 'reconcile',
        canonicalEnvironmentId: seeded.id,
        runtimeId: 'host-runtime',
        preparedAt: 1,
        registrations: [
          { environmentId: seeded.id, authorityDigest: 'a'.repeat(64) },
          { environmentId: 'other', authorityDigest: 'b'.repeat(64) }
        ]
      }
    })
    const [restored] = listEnvironments(userDataPath)
    expect(() => assertRuntimeEnvironmentNotReconciling(restored!)).toThrow('reconciliation')
    expect(JSON.parse(readFileSync(getEnvironmentStorePath(userDataPath), 'utf8'))).toEqual({
      version: 1,
      environments: [seeded]
    })
  })
})
