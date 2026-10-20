import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from './pairing'
import {
  addManagedOrcadEnvironment,
  recordManagedOrcadMigration
} from './runtime-environment-managed-orcad-store'
import {
  getRuntimeEnvironmentSidecarPath,
  overlayRuntimeEnvironmentSidecar,
  readRuntimeEnvironmentSidecar
} from './runtime-environment-sidecar'
import {
  addEnvironmentFromPairingCode,
  getEnvironmentStorePath,
  listEnvironments
} from './runtime-environment-store'
import { markEnvironmentUsed } from './runtime-environment-usage'
import {
  readPersistedEnvironmentStore,
  RuntimeEnvironmentStoreError,
  writeEnvironmentStoreSnapshotAsync
} from './runtime-environment-store-file'
import { RuntimeEnvironmentStoreSchema } from './runtime-environments'
import {
  getWslHostDeploymentStorePath,
  readWslHostDeployments,
  writeWslHostDeployment,
  WslHostDeploymentStoreInvalidError,
  type WslHostDeploymentRecord
} from './wsl-host-deployment-store'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from './wsl-host-internal-gate'

const pairing = {
  v: 2 as const,
  publicKeyB64: Buffer.alloc(32, 1).toString('base64'),
  deviceToken: 'private-device-token'
}
const sshTunnel = {
  sshTargetId: 'target',
  sshTargetGeneration: 3,
  localPort: 41000,
  remotePort: 6768
}

function wslRecord(overrides: Partial<WslHostDeploymentRecord> = {}): WslHostDeploymentRecord {
  return {
    kind: 'wsl',
    environmentId: 'wsl-ubuntu',
    distro: 'Ubuntu-24.04',
    distroId: '0e3a7f2c-1b4d-4c5e-9f60-7a8b9c0d1e2f',
    localPort: 42000,
    remotePort: 6769,
    createdAt: 200,
    ...overrides
  }
}

describe('WSL host deployment store', () => {
  let userDataPath: string
  beforeEach(async () => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-wsl-host-deployments-'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  async function addSshManaged() {
    return (await addManagedOrcadEnvironment(userDataPath, {
      id: 'ssh-managed',
      name: 'Build box',
      pairingCode: encodePairingOffer({ ...pairing, endpoint: 'ws://127.0.0.1:41000/runtime' }),
      orcadDeployment: sshTunnel,
      now: 100
    }))
  }

  // Why a plain pairing: orca-environments.json holds nothing an older build cannot read.
  async function addWslManaged(record = wslRecord()) {
    const environment = await addEnvironmentFromPairingCode(userDataPath, {
      name: 'Ubuntu',
      // Why its own key: one key is one server, which the store refuses to save twice.
      pairingCode: encodePairingOffer({
        ...pairing,
        publicKeyB64: Buffer.alloc(32, 2).toString('base64'),
        endpoint: `ws://127.0.0.1:${record.localPort}/runtime`
      }),
      now: 150
    })
    await writeWslHostDeployment(userDataPath, environment.id, {
      ...record,
      environmentId: environment.id
    })
    return environment.id
  }

  function bytes(path: string): string {
    return readFileSync(path, 'utf8')
  }

  it('leaves an SSH-only profile byte-for-byte unchanged across a read and rewrite', async () => {
    await addSshManaged()
    await recordManagedOrcadMigration(userDataPath, 'ssh-managed', '2026-10-01T00:00:00.000Z')
    const storePath = getEnvironmentStorePath(userDataPath)
    const sidecarPath = getRuntimeEnvironmentSidecarPath(userDataPath)
    const before = { store: bytes(storePath), sidecar: bytes(sidecarPath) }

    const [environment] = listEnvironments(userDataPath)
    expect(environment?.orcadDeployment).toEqual(sshTunnel)
    await writeEnvironmentStoreSnapshotAsync(userDataPath, readPersistedEnvironmentStore(userDataPath))
    await recordManagedOrcadMigration(userDataPath, 'ssh-managed', '2026-10-01T00:00:00.000Z')

    expect({ store: bytes(storePath), sidecar: bytes(sidecarPath) }).toEqual(before)
    expect(before.sidecar).not.toContain('"kind"')
    expect(existsSync(getWslHostDeploymentStorePath(userDataPath))).toBe(false)
  })

  it('overlays a WSL deployment as a managed server without touching the shared files', async () => {
    await addSshManaged()
    const storeBefore = bytes(getEnvironmentStorePath(userDataPath))
    const sidecarBefore = bytes(getRuntimeEnvironmentSidecarPath(userDataPath))
    const wslId = await addWslManaged()

    const byId = new Map(listEnvironments(userDataPath).map((entry) => [entry.id, entry]))
    expect(byId.get('ssh-managed')?.orcadDeployment).toEqual(sshTunnel)
    const { environmentId: _id, createdAt: _at, ...link } = wslRecord()
    expect(byId.get(wslId)).toMatchObject({ orcadDeployment: link })
    expect(byId.get(wslId)?.connectionDependency).toBeUndefined()
    expect(bytes(getRuntimeEnvironmentSidecarPath(userDataPath))).toBe(sidecarBefore)
    expect(bytes(getEnvironmentStorePath(userDataPath))).not.toContain('wsl')
    expect(storeBefore).not.toContain('wsl')
  })

  describe('downgrade to builds that never read the WSL file', () => {
    it('keeps every environment readable by a build that rejects the whole store on one bad record', async () => {
      await addSshManaged()
      const wslId = await addWslManaged()

      // Builds before the per-record store parsed orca-environments.json whole.
      const strict = RuntimeEnvironmentStoreSchema.parse(
        JSON.parse(bytes(getEnvironmentStorePath(userDataPath)))
      )
      expect(strict.environments.map((entry) => entry.id).sort()).toEqual(
        ['ssh-managed', wslId].sort()
      )
      expect(Object.keys(readRuntimeEnvironmentSidecar(userDataPath).unreadable)).toEqual([])
    })

    it("keeps SSH servers managed under main's reader, which sees the WSL server as a plain pairing", async () => {
      await addSshManaged()
      const wslId = await addWslManaged()

      // main's readEnvironmentStore: persisted records with their sidecar entries overlaid.
      const sidecar = readRuntimeEnvironmentSidecar(userDataPath)
      const mainView = readPersistedEnvironmentStore(userDataPath).environments.map((entry) =>
        overlayRuntimeEnvironmentSidecar(entry, sidecar.entries[entry.id])
      )
      const byId = new Map(mainView.map((entry) => [entry.id, entry]))
      expect(byId.get('ssh-managed')?.orcadDeployment).toEqual(sshTunnel)
      expect(byId.get(wslId)?.orcadDeployment).toBeUndefined()
    })

    it('keeps the WSL deployment after an older build rewrites the store', async () => {
      await addSshManaged()
      const wslId = await addWslManaged()
      // An older build's routine write: parse, strip unknown keys, rewrite.
      const path = getEnvironmentStorePath(userDataPath)
      writeFileSync(
        path,
        JSON.stringify(RuntimeEnvironmentStoreSchema.parse(JSON.parse(bytes(path))), null, 2)
      )
      await markEnvironmentUsed(userDataPath, wslId, { now: 10_000 })

      expect(listEnvironments(userDataPath).find((entry) => entry.id === wslId)).toMatchObject({
        orcadDeployment: { kind: 'wsl', distro: 'Ubuntu-24.04' }
      })
    })
  })

  describe('records this build cannot read', () => {
    const futureKind = { kind: 'hyperv', environmentId: 'future', vmName: 'dev', createdAt: 1 }
    const corrupt = { kind: 'wsl', environmentId: 'broken', distro: 'not a name!' }
    const anonymous = { note: 'no environment id' }

    function seed(...records: unknown[]): string {
      const path = getWslHostDeploymentStorePath(userDataPath)
      writeFileSync(path, JSON.stringify({ version: 1, deployments: records }))
      return path
    }

    it('rewrites unknown records verbatim and in place when another record changes', async () => {
      const extended = { ...wslRecord({ environmentId: 'extended' }), futureField: { x: 1 } }
      const path = seed(futureKind, extended, corrupt, anonymous)

      await writeWslHostDeployment(userDataPath, 'new', wslRecord({ environmentId: 'new' }))
      await writeWslHostDeployment(
        userDataPath,
        'new',
        wslRecord({ environmentId: 'new', remotePort: 7000 })
      )

      expect(JSON.parse(bytes(path)).deployments).toEqual([
        futureKind,
        extended,
        corrupt,
        anonymous,
        wslRecord({ environmentId: 'new', remotePort: 7000 })
      ])
      await writeWslHostDeployment(userDataPath, 'new', null)
      expect(JSON.parse(bytes(path)).deployments).toEqual([
        futureKind,
        extended,
        corrupt,
        anonymous
      ])
    })

    it('hides the environment an unreadable record owns and refuses to replace that record', async () => {
      vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
      await addSshManaged()
      const wslId = await addWslManaged()
      const future = { ...futureKind, environmentId: wslId }
      seed(future)

      expect(readWslHostDeployments(userDataPath).unreadableEnvironmentIds).toEqual(
        new Set([wslId])
      )
      expect(listEnvironments(userDataPath).map((entry) => entry.id)).toEqual(['ssh-managed'])
      await expect(async () => (await writeWslHostDeployment(userDataPath, wslId, null))).rejects.toThrow(
        WslHostDeploymentStoreInvalidError
      )
      expect(JSON.parse(bytes(getWslHostDeploymentStorePath(userDataPath))).deployments).toEqual([
        future
      ])
    })

    it('treats two records for one environment as unreadable', async () => {
      seed(wslRecord(), wslRecord({ remotePort: 7000 }))
      expect(readWslHostDeployments(userDataPath)).toEqual({
        deployments: [],
        unreadableEnvironmentIds: new Set(['wsl-ubuntu'])
      })
    })

    it('fails closed when the file itself is corrupt and WSL hosts are enabled', async () => {
      vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
      await addSshManaged()
      writeFileSync(getWslHostDeploymentStorePath(userDataPath), '{"version":1,"deployments":{}}')
      expect(() => listEnvironments(userDataPath)).toThrow(RuntimeEnvironmentStoreError)
      await expect(async () => (await writeWslHostDeployment(userDataPath, 'x', null))).rejects.toThrow(
        WslHostDeploymentStoreInvalidError
      )
    })

    // Regression: with the gate closed a corrupt WSL file must not hide SSH and paired servers.
    it('keeps every other server listed when the file is corrupt and the gate is closed', async () => {
      vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '')
      await addSshManaged()
      writeFileSync(getWslHostDeploymentStorePath(userDataPath), '{"version":1,"deployments":{}}')
      expect(listEnvironments(userDataPath).map((entry) => entry.id)).toEqual(['ssh-managed'])
    })

    // Regression: a stale record must not hide a re-paired loopback server while the gate is closed.
    it('hides nothing for an unreadable record while the gate is closed', async () => {
      vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '')
      const wslId = await addWslManaged()
      seed({ ...futureKind, environmentId: wslId })
      expect(listEnvironments(userDataPath).map((entry) => entry.id)).toEqual([wslId])
    })

    it('never hides a remote paired server behind an unreadable WSL record', async () => {
      const remote = await addEnvironmentFromPairingCode(userDataPath, {
        name: 'Remote',
        pairingCode: encodePairingOffer({
          ...pairing,
          publicKeyB64: Buffer.alloc(32, 3).toString('base64'),
          endpoint: 'wss://build.example.com/runtime'
        }),
        now: 150
      })
      seed({ ...futureKind, environmentId: remote.id })
      expect(listEnvironments(userDataPath).map((entry) => entry.id)).toEqual([remote.id])
    })

    it('never hides an SSH-managed server behind an unreadable WSL record', async () => {
      await addSshManaged()
      seed({ ...futureKind, environmentId: 'ssh-managed' })
      expect(listEnvironments(userDataPath)[0]?.orcadDeployment).toEqual(sshTunnel)
    })
  })

  it('ignores a stale record whose port no longer matches the pairing', async () => {
    const wslId = await addWslManaged()
    await writeWslHostDeployment(
      userDataPath,
      wslId,
      wslRecord({ environmentId: wslId, localPort: 43000 })
    )
    const [environment] = listEnvironments(userDataPath)
    expect(environment?.id).toBe(wslId)
    expect(environment?.orcadDeployment).toBeUndefined()
  })

  it('ignores a WSL record on a server that already has an SSH deployment', async () => {
    await addSshManaged()
    await writeWslHostDeployment(
      userDataPath,
      'ssh-managed',
      wslRecord({ environmentId: 'ssh-managed', localPort: 41000 })
    )
    expect(listEnvironments(userDataPath)[0]?.orcadDeployment).toEqual(sshTunnel)
  })

  it('rejects a record written under another environment id or with an invalid distro', async () => {
    await expect(async () => (await writeWslHostDeployment(userDataPath, 'other', wslRecord()))).rejects.toThrow()
    await expect(async () =>
      await writeWslHostDeployment(userDataPath, 'wsl-ubuntu', wslRecord({ distro: 'Ubuntu 24.04' }))
    ).rejects.toThrow()
    await expect(async () =>
      await writeWslHostDeployment(userDataPath, 'wsl-ubuntu', wslRecord({ distroId: '{ABC}' }))
    ).rejects.toThrow()
  })
})
