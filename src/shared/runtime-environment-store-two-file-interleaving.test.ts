// The environment store spans two files written with awaits between them. Every mutation runs in
// one lane per store; these pin what that lane guarantees when mutations are not awaited in turn.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as BoundedSecureJsonFile from './bounded-secure-json-file'
import { encodePairingOffer } from './pairing'

const afterPublish = vi.hoisted((): { run: (() => void) | null } => ({ run: null }))

// Why: every store and sidecar publish goes through this writer, so each settled call is a gap.
vi.mock('./bounded-secure-json-file', async (importOriginal) => {
  const actual = await importOriginal<typeof BoundedSecureJsonFile>()
  return {
    ...actual,
    writeSecureJsonFileWithinLimitAsync: async (
      ...args: Parameters<typeof actual.writeSecureJsonFileWithinLimitAsync>
    ) => {
      await actual.writeSecureJsonFileWithinLimitAsync(...args)
      afterPublish.run?.()
    }
  }
})

import { listEnvironments, markEnvironmentUsed } from './runtime-environment-store'
import {
  addManagedOrcadEnvironment,
  recordManagedOrcadMigration,
  refreshManagedOrcadPairing
} from './runtime-environment-managed-orcad-store'

const deployment = (localPort: number) => ({
  sshTargetId: `ssh-${localPort}`,
  sshTargetGeneration: 1,
  localPort,
  remotePort: 6_768
})
const pairingCode = (localPort: number, deviceToken = 'device-token') =>
  encodePairingOffer({
    v: 2,
    endpoint: `ws://127.0.0.1:${localPort}`,
    deviceToken,
    publicKeyB64: Buffer.alloc(32, 1).toString('base64')
  })

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-environment-two-file-'))
})
afterEach(() => {
  afterPublish.run = null
  rmSync(userDataPath, { recursive: true, force: true })
})

async function addManaged(id: string, localPort: number) {
  return await addManagedOrcadEnvironment(userDataPath, {
    id,
    name: id,
    pairingCode: pairingCode(localPort),
    orcadDeployment: deployment(localPort),
    now: 100
  })
}

it('keeps both sidecar updates when two mutations are started without awaiting the first', async () => {
  await addManaged('server-a', 46_001)
  await addManaged('server-b', 46_002)

  const first = recordManagedOrcadMigration(userDataPath, 'server-a', '2026-10-11T00:00:00.000Z')
  const second = recordManagedOrcadMigration(userDataPath, 'server-b', '2026-10-11T00:00:01.000Z')
  await Promise.all([first, second])

  const byId = new Map(listEnvironments(userDataPath).map((entry) => [entry.id, entry]))
  // Both read-modify-write the one sidecar file; interleaved, the later write drops the earlier mark.
  expect(byId.get('server-a')?.orcadMigratedAt).toBe('2026-10-11T00:00:00.000Z')
  expect(byId.get('server-b')?.orcadMigratedAt).toBe('2026-10-11T00:00:01.000Z')
})

it('keeps a usage stamp started during a three-write pairing refresh, and the deployment link', async () => {
  await addManaged('server-a', 46_001)

  const refresh = refreshManagedOrcadPairing(
    userDataPath,
    'server-a',
    pairingCode(46_001, 'rotated-token'),
    200
  )
  const stamp = markEnvironmentUsed(userDataPath, 'server-a', { now: 300 })
  await Promise.all([refresh, stamp])

  const [environment] = listEnvironments(userDataPath)
  expect(environment?.endpoints[0]?.deviceToken).toBe('rotated-token')
  expect(environment?.lastUsedAt).toBe(300)
  expect(environment?.orcadDeployment).toEqual(deployment(46_001))
})

it('never shows a reader a managed server without its deployment link between the two files', async () => {
  const seen: unknown[] = []
  afterPublish.run = () => {
    const entry = listEnvironments(userDataPath).find((candidate) => candidate.id === 'server-a')
    if (entry) {
      seen.push(entry.orcadDeployment)
    }
  }

  await addManaged('server-a', 46_001)
  await refreshManagedOrcadPairing(userDataPath, 'server-a', pairingCode(46_001, 'rotated'), 200)

  expect(seen.length).toBeGreaterThan(0)
  for (const link of seen) {
    expect(link).toEqual(deployment(46_001))
  }
})
