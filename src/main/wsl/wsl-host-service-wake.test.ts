import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import { isRecoverableRemoteRuntimeConnectionError } from '../../shared/remote-runtime/remote-runtime-client-error-classification'
import { drainPendingPathWrites } from '../../shared/path-write-serializer'
import { WSL_HOSTS_DISABLED_MESSAGE } from './wsl-host-add-admission'
import { WslHostService, type WslHostConnector } from './wsl-host-service'
import { UBUNTU, makeConnector } from './wsl-host-service.test-fixture'

describe('WslHostService wake and passive reconnect', () => {
  let userDataPath: string
  let enabled: boolean

  function makeService(connector: WslHostConnector): WslHostService {
    const service = new WslHostService({
      userDataPath: () => userDataPath,
      isEnabled: () => enabled,
      hasServerFiles: () => true,
      publish: vi.fn(),
      pairingChanged: vi.fn(),
      ready: vi.fn(),
      removed: vi.fn()
    })
    service.attach(connector)
    return service
  }

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-wsl-host-wake-service-'))
    enabled = true
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(async () => {
    await drainPendingPathWrites()
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('keeps a confirmed-stopped host down for polls until the user switches back to it (E9)', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    service.setVisibleWork(['wsl:ubuntu'])
    await connector.disconnect('Ubuntu')
    connector.distro.state = 'stopped'
    service.handleConnectionChange('Ubuntu', null, {
      state: 'distro-stopped',
      terminals: 'exited',
      recovering: false
    })
    connector.connect.mockClear()

    // The focused host's polls get a refusal, not a boot, however often they come.
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('Ubuntu was stopped')
    service.setVisibleWork(['wsl:ubuntu'])
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('Ubuntu was stopped')
    expect(connector.connect).not.toHaveBeenCalled()

    // Switching to one of its workspaces is the user acting on it.
    service.focusHost('wsl:ubuntu')
    await vi.waitFor(() => expect(connector.connect).toHaveBeenCalledTimes(1))
  })

  it('focus connects without probing WSL while this process has no bridge, but polls still read the running list', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    await connector.disconnect('Ubuntu')
    connector.reachability.mockClear()
    connector.connect.mockClear()

    service.focusHost('wsl:ubuntu')
    await vi.waitFor(() => expect(connector.connect).toHaveBeenCalledTimes(1))
    expect(connector.reachability).not.toHaveBeenCalled()

    // A poll never takes that shortcut: it reads the running list and refuses a stopped distro.
    await connector.disconnect('Ubuntu')
    connector.distro.state = 'stopped'
    connector.connect.mockClear()
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('Ubuntu was stopped')
    expect(connector.reachability).toHaveBeenCalledWith('Ubuntu', 'wsl:ubuntu')
    expect(connector.connect).not.toHaveBeenCalled()
  })

  it('focus with a bridge still asks whether the host answers before connecting again', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    connector.reachability.mockClear()
    connector.connect.mockClear()

    service.focusHost('wsl:ubuntu')
    await vi.waitFor(() => expect(connector.reachability).toHaveBeenCalledTimes(1))
    expect(connector.connect).not.toHaveBeenCalled()
  })

  it.each(['disable', 'disable and re-enable', 'remove and re-add'] as const)(
    'does not restart a host after %s revokes an automation wake awaiting reachability',
    async (change) => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
      const connector = makeConnector([UBUNTU])
      const service = makeService(connector)
      await service.add({ distro: 'Ubuntu' })
      const reachability = Promise.withResolvers<'unreachable'>()
      connector.reachability.mockReturnValueOnce(reachability.promise)
      const waking = service.wakeForAutomation('wsl:ubuntu')
      expect(connector.reachability).toHaveBeenCalledWith('Ubuntu', 'wsl:ubuntu')
      try {
        if (change === 'remove and re-add') {
          await service.remove('wsl:ubuntu')
          now.mockReturnValue(2_000)
          await expect(service.add({ distro: 'Ubuntu' })).resolves.toMatchObject({ ok: true })
        } else {
          enabled = false
          await service.enabledChanged(false)
          if (change === 'disable and re-enable') {
            enabled = true
            await service.enabledChanged(true)
          }
        }
        connector.connect.mockClear()
      } finally {
        reachability.resolve('unreachable')
      }
      await waking
      expect(connector.connect).not.toHaveBeenCalled()
    }
  )

  it.each(['disable', 'disable and re-enable', 'remove and re-add'] as const)(
    'rejects a stale runtime call after %s revokes its reachability probe',
    async (change) => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
      const connector = makeConnector([UBUNTU])
      const service = makeService(connector)
      await service.add({ distro: 'Ubuntu' })
      service.setVisibleWork(['wsl:ubuntu'])
      const reachability = Promise.withResolvers<'unreachable'>()
      connector.reachability.mockReturnValueOnce(reachability.promise)
      const pending = service.ensureForRuntimeCall('wsl:ubuntu')
      expect(connector.reachability).toHaveBeenCalledWith('Ubuntu', 'wsl:ubuntu')
      try {
        if (change === 'remove and re-add') {
          await service.remove('wsl:ubuntu')
          now.mockReturnValue(2_000)
          await expect(service.add({ distro: 'Ubuntu' })).resolves.toMatchObject({ ok: true })
          service.setVisibleWork(['wsl:ubuntu'])
        } else {
          enabled = false
          await service.enabledChanged(false)
          if (change === 'disable and re-enable') {
            enabled = true
            await service.enabledChanged(true)
          }
        }
        connector.connect.mockClear()
      } finally {
        reachability.resolve('unreachable')
      }
      await (change === 'disable'
        ? expect(pending).rejects.toMatchObject({ message: WSL_HOSTS_DISABLED_MESSAGE })
        : expect(pending).rejects.toBeInstanceOf(Error))
      expect(connector.connect).not.toHaveBeenCalled()
    }
  )

  it('rejects an available reachability verdict completed after WSL hosts were disabled', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    const reachability = Promise.withResolvers<'available'>()
    connector.reachability.mockReturnValueOnce(reachability.promise)
    const pending = service.ensureForRuntimeCall('wsl:ubuntu')
    expect(connector.reachability).toHaveBeenCalledWith('Ubuntu', 'wsl:ubuntu')
    try {
      enabled = false
      await service.enabledChanged(false)
      connector.connect.mockClear()
    } finally {
      reachability.resolve('available')
    }
    await expect(pending).rejects.toMatchObject({ message: WSL_HOSTS_DISABLED_MESSAGE })
    expect(connector.connect).not.toHaveBeenCalled()
  })

  it('passes a failed reconnect for open work through the retryable mapping', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    service.setVisibleWork(['wsl:ubuntu'])
    await connector.disconnect('Ubuntu')
    connector.connect.mockRejectedValueOnce(new Error('orcad exited'))
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toBeInstanceOf(
      RemoteRuntimeClientError
    )
  })

  it('keeps a parked host’s refusal final, never a retryable failure', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    service.setVisibleWork(['wsl:ubuntu'])
    await connector.disconnect('Ubuntu')
    connector.distro.state = 'stopped'

    const refusal = await service
      .ensureForRuntimeCall('wsl:ubuntu')
      .catch((error: unknown) => error)
    expect(refusal).not.toBeInstanceOf(RemoteRuntimeClientError)
    expect(String(refusal)).toContain('Ubuntu was stopped')
    expect(isRecoverableRemoteRuntimeConnectionError({ message: String(refusal) })).toBe(false)
  })

  it('parks a host the moment a poll finds its distro confirmed stopped, never booting it', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    service.setVisibleWork(['wsl:ubuntu'])
    await connector.disconnect('Ubuntu')
    connector.distro.state = 'stopped'
    connector.connect.mockClear()
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('Ubuntu was stopped')
    // Running again (started some other way) is not enough while parked: still no boot from a poll.
    connector.distro.state = 'running'
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('Ubuntu was stopped')
    expect(connector.connect).not.toHaveBeenCalled()
  })

  it('right after a shutdown, a stale running list cannot make a poll reboot the distro', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    service.setVisibleWork(['wsl:ubuntu'])
    await connector.disconnect('Ubuntu')
    connector.connect.mockClear()
    // The watch just exited and WSL still lists the stopping distro as running.
    connector.distro.state = 'running'
    connector.isSettling.mockReturnValue(true)
    // Retryable, so a pane attaching in this window recovers instead of dead-ending; still no boot.
    const settling = await service
      .ensureForRuntimeCall('wsl:ubuntu')
      .catch((error: unknown) => error)
    expect(settling).toMatchObject({ code: 'remote_runtime_unavailable' })
    expect(isRecoverableRemoteRuntimeConnectionError({ message: String(settling) })).toBe(true)
    // Liveness then confirms the stop: the host parks, and polls keep refusing.
    service.handleConnectionChange('Ubuntu', null, {
      state: 'distro-stopped',
      terminals: 'exited',
      recovering: false
    })
    connector.isSettling.mockReturnValue(false)
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('Ubuntu was stopped')
    expect(connector.connect).not.toHaveBeenCalled()
  })

  it('a poll after a focus boot failed does not retry the boot', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    service.setVisibleWork(['wsl:ubuntu'])
    await connector.disconnect('Ubuntu')
    connector.distro.state = 'stopped'
    connector.connect.mockClear()
    connector.connect.mockRejectedValueOnce(new Error('boot failed'))
    service.focusHost('wsl:ubuntu')
    await vi.waitFor(() => expect(connector.connect).toHaveBeenCalledTimes(1))
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('Ubuntu was stopped')
    expect(connector.connect).toHaveBeenCalledTimes(1)
  })

  it('never boots for a poll: not visible, or unconfirmed, is a refusal; lost contact never parks', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    await connector.disconnect('Ubuntu')
    connector.connect.mockClear()
    // Not focused: a background poll (forge, worktree list, agent status) gets a refusal.
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('isn’t connected')
    service.setVisibleWork(['wsl:ubuntu'])
    // The running list can't be read: refuse rather than risk a boot, and don't park.
    connector.distro.state = 'unavailable'
    service.handleConnectionChange('Ubuntu', null, {
      state: 'unverifiable',
      reason: 'running-list-unavailable',
      terminals: 'unverifiable'
    })
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('isn’t connected')
    expect(connector.connect).not.toHaveBeenCalled()
    connector.distro.state = 'running'
    await service.ensureForRuntimeCall('wsl:ubuntu')
    expect(connector.connect).toHaveBeenCalledTimes(1)
    // Even this reconnect to a running distro may not boot it if it stops meanwhile.
    expect(connector.connect).toHaveBeenCalledWith('Ubuntu', { noBoot: true })
  })

  it('a due automation boots a parked host once, and never with the experiment off', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    await connector.disconnect('Ubuntu')
    service.handleConnectionChange('Ubuntu', null, {
      state: 'distro-stopped',
      terminals: 'exited',
      recovering: false
    })
    connector.connect.mockClear()
    enabled = false
    await service.wakeForAutomation('wsl:ubuntu')
    expect(connector.connect).not.toHaveBeenCalled()
    enabled = true
    await service.wakeForAutomation('wsl:ubuntu')
    expect(connector.connect).toHaveBeenCalledExactlyOnceWith('Ubuntu')
    await expect(service.isConnected('wsl:ubuntu')).resolves.toBe(true)
  })

  it('an automation wake with no bridge yet connects without a WSL reachability probe', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    await connector.disconnect('Ubuntu')
    connector.connect.mockClear()
    connector.reachability.mockClear()
    await service.wakeForAutomation('wsl:ubuntu')
    expect(connector.reachability).not.toHaveBeenCalled()
    expect(connector.connect).toHaveBeenCalledExactlyOnceWith('Ubuntu')
  })

  it('lifts a park on an explicit Connect', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    service.setVisibleWork(['wsl:ubuntu'])
    await connector.disconnect('Ubuntu')
    service.handleConnectionChange('Ubuntu', null, {
      state: 'distro-stopped',
      terminals: 'exited',
      recovering: false
    })
    await service.connect('wsl:ubuntu')
    await connector.disconnect('Ubuntu')
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).resolves.toBeUndefined()
  })
})
