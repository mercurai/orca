import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as hostStore from '../../shared/runtime-environment-wsl-host-store'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { withRuntimeEnvironmentMutation } from '../../shared/runtime-environment-store-mutation'
import { getPreferredPairingOffer } from '../../shared/runtime-environments'
import type { WslHostStatus } from '../../shared/wsl-host-types'
import { WslHostService } from './wsl-host-service'
import { UBUNTU, pairing, connection, makeConnector } from './wsl-host-service.test-fixture'

let profile: string
beforeEach(() => { profile = mkdtempSync(join(tmpdir(), 'orca-wsl-queued-pairing-')) })
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(profile, { recursive: true, force: true })
})

function harness() {
  const connector = makeConnector([UBUNTU])
  const ready = vi.fn()
  const published: WslHostStatus[] = []
  const service = new WslHostService({
    userDataPath: () => profile,
    isEnabled: () => true,
    hasServerFiles: () => true,
    publish: (status) => published.push(status),
    pairingChanged: vi.fn(), ready, removed: vi.fn()
  })
  service.attach(connector)
  return { service, connector, ready, published }
}

async function holdProfile() {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const held = withRuntimeEnvironmentMutation(profile, async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  return { held, release }
}

it('does not publish an old ready event over a newer queued pairing repair', async () => {
  const h = harness()
  await expect(h.service.add({ distro: 'Ubuntu' })).resolves.toMatchObject({ ok: true })
  h.ready.mockClear()
  h.published.length = 0
  const { held, release } = await holdProfile()
  const newer = hostStore.refreshWslHostPairing(profile, 'wsl:ubuntu', {
    pairingCode: pairing(42001, 'repaired-fixture-token'), localPort: 42001, remotePort: 6770
  })
  const older = h.service.handleConnectionChange('Ubuntu', connection('Ubuntu', 42000, 'old-fixture-token'), {
    state: 'ready', census: null
  })
  release.resolve()
  await Promise.all([held, newer, older])
  const [saved] = listEnvironments(profile)
  expect(getPreferredPairingOffer(saved).deviceToken).toBe('repaired-fixture-token')
  expect(hostStore.findWslHostDeployment(profile, 'wsl:ubuntu')).toMatchObject({
    localPort: 42001, remotePort: 6770
  })
  expect(h.ready).not.toHaveBeenCalled()
  expect(h.published).toEqual([])
})

it.each(['closed', 'replaced'] as const)('abandons an Add whose connection is %s while registration is queued', async (mode) => {
  const h = harness()
  const { held, release } = await holdProfile()
  const queued = Promise.withResolvers<void>()
  const add = hostStore.addWslHostEnvironment
  vi.spyOn(hostStore, 'addWslHostEnvironment').mockImplementation((...args) => {
    const result = add(...args)
    queued.resolve()
    return result
  })
  const adding = h.service.add({ distro: 'Ubuntu' })
  try {
    await queued.promise
    const captured = h.connector.get('Ubuntu')
    if (!captured) throw new Error('fixture Add did not connect')
    const close = vi.spyOn(captured, 'close')
    const replacement = mode === 'replaced' ? await h.connector.connect('Ubuntu') : null
    if (mode === 'closed') {
      await h.connector.disconnect('Ubuntu')
      await h.service.handleConnectionChange('Ubuntu', null, {
        state: 'distro-stopped', terminals: 'exited', recovering: false
      })
    }
    release.resolve()
    await held
    await expect(adding).resolves.toMatchObject({ ok: false })
    expect(listEnvironments(profile)).toEqual([])
    expect(hostStore.findWslHostDeployment(profile, 'wsl:ubuntu')).toBeNull()
    expect(h.ready).not.toHaveBeenCalled()
    expect(h.published.some((status) => status.state === 'ready')).toBe(false)
    if (replacement) {
      expect(h.connector.get('Ubuntu')).toBe(replacement)
      expect(h.connector.disconnect).not.toHaveBeenCalled()
      expect(h.connector.releaseHolder).not.toHaveBeenCalled()
      expect(close).toHaveBeenCalledOnce()
    } else {
      expect(h.connector.releaseHolder).toHaveBeenCalledWith('Ubuntu')
    }
  } finally {
    release.resolve()
    await Promise.allSettled([held, adding])
  }
})
