import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../../shared/pairing'
import {
  addManagedOrcadEnvironment,
  refreshManagedOrcadPairing
} from '../../../shared/runtime-environment-managed-orcad-store'
import { withRuntimeEnvironmentMutation } from '../../../shared/runtime-environment-store-mutation'
import { resolveEnvironment } from '../../../shared/runtime-environment-store'
import { getPreferredPairingOffer } from '../../../shared/runtime-environments'
import type { SshTarget } from '../../../shared/ssh-types'
import type { OrcadHostTransport } from '../../ssh/orcad-host-transport'
import { ManagedOrcadPairingRepairs, pairingRevisionOf } from './orcad-managed-pairing-repair'

// Exercise the real host filesystem and fsync handle modes; native DACL coverage lives elsewhere.
vi.mock('../../../shared/windows-security-addon', () => ({
  loadWindowsSecurity: () => ({
    error: 'native DACL intentionally unavailable in storage ordering fixture'
  })
}))

let profile: string
beforeEach(() => {
  profile = mkdtempSync(join(tmpdir(), 'orca-managed-repair-queue-'))
})
afterEach(() => {
  rmSync(profile, { recursive: true, force: true })
})

it('does not overwrite a newer pairing queued ahead of repair', async () => {
  const offer = (deviceToken: string) => ({
    v: 2 as const,
    endpoint: 'ws://127.0.0.1:46768',
    deviceToken,
    publicKeyB64: Buffer.alloc(32, 7).toString('base64')
  })
  const original = await addManagedOrcadEnvironment(profile, {
    id: 'env',
    name: 'host',
    pairingCode: encodePairingOffer(offer('refused')),
    now: 10,
    orcadDeployment: {
      sshTargetId: 'ssh',
      sshTargetGeneration: 1,
      localPort: 46768,
      remotePort: 6768
    }
  })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const repairQueued = Promise.withResolvers<void>()
  const held = withRuntimeEnvironmentMutation(profile, async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const newer = refreshManagedOrcadPairing(
    profile,
    original.id,
    encodePairingOffer(offer('newer')),
    20
  )
  const repairs = new ManagedOrcadPairingRepairs({
    resolve: (id) => resolveEnvironment(profile, id),
    connect: async () => ({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: readReadiness is a fixture and never uses this target.
      target: {} as SshTarget,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: no network access; only the fixture readiness callback receives it.
      connection: {} as OrcadHostTransport
    }),
    readReadiness: async () => ({
      runtimeId: 'runtime',
      boundEndpoint: 'ws://127.0.0.1:6768',
      advertisedEndpoint: null,
      managedWslCliReconciliation: 'settled',
      pairing: {
        available: true,
        url: encodePairingOffer(offer('stale-repair')),
        endpoint: 'ws://127.0.0.1:6768',
        deviceId: 'device',
        webClientUrl: null,
        scope: 'runtime',
        qr: null
      }
    }),
    refresh: (id, code, expectedPairingRevision) => {
      const write = refreshManagedOrcadPairing(profile, id, code, 30, { expectedPairingRevision })
      repairQueued.resolve()
      return write
    },
    repaired: vi.fn(),
    now: () => 30
  })
  const repaired = repairs.repair(original.id, pairingRevisionOf(original))
  await repairQueued.promise
  release.resolve()
  await held
  const updated = await newer
  expect(await repaired).toEqual(updated)
  expect(resolveEnvironment(profile, original.id)).toEqual(updated)
  expect(getPreferredPairingOffer(updated).deviceToken).toBe('newer')
  expect(updated.pairingRevision).toBe(20)
})
