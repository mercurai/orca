import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from './pairing'
import {
  addEnvironmentFromPairingCode,
  getEnvironmentStorePath,
  listEnvironments,
  removeEnvironment,
  resolveEnvironment,
  updateEnvironmentFromPairingCode
} from './runtime-environment-store'
import { markEnvironmentUsed } from './runtime-environment-usage'
import {
  getRuntimeEnvironmentSidecarPath,
  readCurrentRuntimeEnvironmentSidecarEntry,
  writeRuntimeEnvironmentSidecarEntry
} from './runtime-environment-sidecar'
import {
  addManagedOrcadEnvironment,
  removeManagedOrcadEnvironment
} from './runtime-environment-managed-orcad-store'
import {
  readPersistedEnvironmentStore,
  writeEnvironmentStore
} from './runtime-environment-store-file'

const pairing = {
  v: 2 as const,
  endpoint: 'wss://server.example/runtime',
  publicKeyB64: Buffer.alloc(32, 1).toString('base64'),
  deviceToken: 'private-device-token',
  pairedDeviceId: 'paired-client'
}
const tunnel = { sshTargetId: 'target', sshTargetGeneration: 3, localPort: 41000, remotePort: 6768 }

function readJson(path: string): { environments?: unknown[]; entries?: Record<string, unknown> } {
  return JSON.parse(readFileSync(path, 'utf8'))
}

describe('runtime environment store with records this build cannot read', () => {
  let userDataPath: string
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-environment-unreadable-'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  function add(name: string) {
    return addEnvironmentFromPairingCode(userDataPath, {
      name,
      pairingCode: encodePairingOffer(pairing),
      now: 100
    })
  }

  function appendRawRecords(...records: unknown[]): void {
    const path = getEnvironmentStorePath(userDataPath)
    const file = readJson(path)
    writeFileSync(
      path,
      JSON.stringify({ ...file, environments: [...(file.environments ?? []), ...records] })
    )
  }

  const corrupt = { id: 'corrupt', name: 'Broken', endpoints: 'not-an-array' }
  // A record kind this build predates; otherwise it would parse as a plain pairing.
  const futureKind = {
    id: 'future',
    kind: 'wsl-distro',
    name: 'Ubuntu',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [
      {
        id: 'ws',
        kind: 'websocket',
        label: 'l',
        endpoint: 'e',
        deviceToken: 'd',
        publicKeyB64: 'k'
      }
    ],
    preferredEndpointId: 'ws',
    distro: { name: 'Ubuntu', futureField: true }
  }

  it('lists readable records and rewrites unreadable ones verbatim and in order', async () => {
    const alpha = await add('Alpha')
    appendRawRecords(corrupt, 'not-an-object', futureKind)
    const zulu = await add('Zulu')
    const beta = await add('Beta')

    expect(listEnvironments(userDataPath).map((environment) => environment.id)).toEqual([
      alpha.id,
      beta.id,
      zulu.id
    ])
    const tail = [corrupt, 'not-an-object', futureKind]
    expect(readJson(getEnvironmentStorePath(userDataPath)).environments?.slice(-3)).toEqual(tail)

    await markEnvironmentUsed(userDataPath, alpha.id, { now: 1_000_000 })
    await removeEnvironment(userDataPath, beta.id)
    const environments = readJson(getEnvironmentStorePath(userDataPath)).environments
    expect(environments?.slice(-3)).toEqual(tail)
    expect(environments).toHaveLength(5)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('corrupt, <none>, future'))
  })

  it('refuses to add a readable record under an id an unreadable record owns', async () => {
    const alpha = await add('Alpha')
    appendRawRecords(futureKind)
    const store = readPersistedEnvironmentStore(userDataPath)
    expect(() =>
      writeEnvironmentStore(userDataPath, {
        version: 1,
        environments: [...store.environments, { ...alpha, id: futureKind.id, name: 'Other' }]
      })
    ).toThrow('newer version of Orca')
    expect(readJson(getEnvironmentStorePath(userDataPath)).environments).toContainEqual(futureKind)
  })

  it('keeps a sidecar entry owned by an unreadable record when another server writes its links', async () => {
    const alpha = await add('Alpha')
    appendRawRecords(futureKind)
    const futureEntry = { binding: { createdAt: 1, pairingRevision: 1, preferredEndpointId: 'ws' } }
    writeFileSync(
      getRuntimeEnvironmentSidecarPath(userDataPath),
      JSON.stringify({ version: 1, entries: { future: futureEntry } })
    )

    writeRuntimeEnvironmentSidecarEntry(
      userDataPath,
      readPersistedEnvironmentStore(userDataPath).environments,
      alpha,
      { orcadMigratedAt: new Date(0).toISOString() }
    )

    expect(readJson(getRuntimeEnvironmentSidecarPath(userDataPath)).entries?.future).toEqual(
      futureEntry
    )
  })

  describe('an unreadable sidecar entry', () => {
    const unreadableEntry = {
      binding: { createdAt: 100, pairingRevision: 100, preferredEndpointId: 'x' },
      sshAccess: { ...tunnel, targetFingerprint: 'pinned', endpoint: 'newer-shape' }
    }

    async function setup() {
      const pinned = addManagedOrcadEnvironment(userDataPath, {
        id: 'pinned',
        name: 'Pinned',
        pairingCode: encodePairingOffer({ ...pairing, endpoint: 'ws://127.0.0.1:41000/runtime' }),
        orcadDeployment: tunnel,
        now: 100
      })
      const other = await add('Other')
      const sidecarPath = getRuntimeEnvironmentSidecarPath(userDataPath)
      const file = readJson(sidecarPath)
      writeFileSync(
        sidecarPath,
        JSON.stringify({ ...file, entries: { ...file.entries, pinned: unreadableEntry } })
      )
      return { pinned, other, sidecarPath }
    }

    it('hides only its server and keeps it unusable rather than unpinned', async () => {
      const { pinned, other } = await setup()

      expect(listEnvironments(userDataPath)).toEqual([other])
      expect(() => resolveEnvironment(userDataPath, pinned.id)).toThrow('Unknown environment')
      await expect(removeEnvironment(userDataPath, pinned.id)).rejects.toThrow('Unknown environment')
      await expect(
        updateEnvironmentFromPairingCode(userDataPath, pinned.id, {
          pairingCode: encodePairingOffer(pairing)
        })
      ).rejects.toThrow('Unknown environment')
      expect(() => readCurrentRuntimeEnvironmentSidecarEntry(userDataPath, pinned)).toThrow(
        'newer version of Orca'
      )
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Hiding 1 server'))
    })

    it('is never replaced, pruned, or orphaned by writes', async () => {
      const { pinned, other, sidecarPath } = await setup()
      const storeBefore = readFileSync(getEnvironmentStorePath(userDataPath), 'utf8')

      expect(() => removeManagedOrcadEnvironment(userDataPath, pinned.id)).toThrow(
        'newer version of Orca'
      )
      expect(readFileSync(getEnvironmentStorePath(userDataPath), 'utf8')).toBe(storeBefore)
      expect(() =>
        writeRuntimeEnvironmentSidecarEntry(
          userDataPath,
          readPersistedEnvironmentStore(userDataPath).environments,
          pinned,
          null
        )
      ).toThrow('newer version of Orca')

      await removeEnvironment(userDataPath, other.id)
      expect(readJson(sidecarPath).entries?.pinned).toEqual(unreadableEntry)
      expect(readPersistedEnvironmentStore(userDataPath).environments.map((e) => e.id)).toEqual([
        pinned.id
      ])
    })
  })
})
