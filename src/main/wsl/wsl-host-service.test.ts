import { encodePairingOffer } from '../../shared/pairing'
import {
  KEY,
  UBUNTU_ID,
  UBUNTU,
  pairing,
  connection,
  makeConnector
} from './wsl-host-service.test-fixture'
import * as secureWrites from '../../shared/secure-file-async-write'
import { drainPendingPathWrites } from '../../shared/path-write-serializer'
import { withRuntimeEnvironmentMutation } from '../../shared/runtime-environment-store-mutation'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addEnvironmentFromPairingCode,
  listEnvironments
} from '../../shared/runtime-environment-store'
import { getEnvironmentStorePath } from '../../shared/runtime-environment-store-file'
import { findWslHostDeployment } from '../../shared/runtime-environment-wsl-host-store'
import { getPreferredPairingOffer } from '../../shared/runtime-environments'
import type { WslHostStatus } from '../../shared/wsl-host-types'
import { OrcadHostUnsupportedError } from '../orcad/orcad-host-unavailable'
import { WslHostService, type WslHostConnector } from './wsl-host-service'
import { wakeRememberedWslHosts } from './wsl-host-early-wake'
import { WslOrcadLaunchDeferredError } from './wsl-orcad-connection-errors'

describe('WslHostService', () => {
  let userDataPath: string
  let published: WslHostStatus[]
  let enabled: boolean
  let serverFiles: boolean
  const pairingChanged = vi.fn()
  const ready = vi.fn()
  const removed = vi.fn()

  function makeService(connector: WslHostConnector): WslHostService {
    const service = new WslHostService({
      userDataPath: () => userDataPath,
      isEnabled: () => enabled,
      hasServerFiles: () => serverFiles,
      publish: (status) => published.push(status),
      pairingChanged,
      ready,
      removed
    })
    service.attach(connector)
    return service
  }

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-wsl-host-service-'))
    published = []
    enabled = true
    serverFiles = true
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(async () => {
    await drainPendingPathWrites()
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('adds a running distro: connects, then persists the environment and WSL record', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)

    await expect(service.add({ distro: 'ubuntu' })).resolves.toEqual({
      ok: true,
      environmentId: 'wsl:ubuntu'
    })

    expect(connector.connect).toHaveBeenCalledWith('Ubuntu')
    expect(listEnvironments(userDataPath)).toMatchObject([
      { id: 'wsl:ubuntu', name: 'Ubuntu (WSL)', orcadDeployment: { kind: 'wsl', distro: 'Ubuntu' } }
    ])
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.distroId).toBe(UBUNTU_ID)
    expect(ready).toHaveBeenCalledWith('wsl:ubuntu')
    expect(published.at(-1)).toMatchObject({ environmentId: 'wsl:ubuntu', state: 'ready' })
    await expect(service.listDistros()).resolves.toEqual([
      { name: 'Ubuntu', state: 'running', version: 2, environmentId: 'wsl:ubuntu' }
    ])
  })

  it('adds a distro over a server list a crash left NUL-filled (#18766)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(getEnvironmentStorePath(userDataPath), Buffer.alloc(640))
    const service = makeService(makeConnector([UBUNTU]))

    await expect(service.add({ distro: 'ubuntu' })).resolves.toEqual({
      ok: true,
      environmentId: 'wsl:ubuntu'
    })
    expect(listEnvironments(userDataPath)).toMatchObject([{ id: 'wsl:ubuntu' }])
  })

  it('refuses WSL 1, an added distro, and a stopped distro the user did not ask to start', async () => {
    const connector = makeConnector([
      UBUNTU,
      { id: UBUNTU_ID.replace('0e', '1e'), name: 'Legacy', state: 'running', version: 1 },
      { id: UBUNTU_ID.replace('0e', '2e'), name: 'Debian', state: 'stopped', version: 2 }
    ])
    const service = makeService(connector)

    await expect(service.add({ distro: 'Legacy' })).resolves.toMatchObject({
      ok: false,
      kind: 'unsupported-wsl1',
      message: expect.stringContaining('wsl --set-version Legacy 2')
    })
    await expect(service.add({ distro: 'Debian' })).resolves.toMatchObject({
      ok: false,
      kind: 'distro-stopped'
    })
    await service.add({ distro: 'Ubuntu' })
    await expect(service.add({ distro: 'Ubuntu' })).resolves.toMatchObject({
      ok: false,
      kind: 'already-added'
    })
    expect(connector.connect).toHaveBeenCalledTimes(1)
    expect(connector.readOrcadPublicKey).not.toHaveBeenCalledWith('Debian')

    await expect(service.add({ distro: 'Debian', startIfStopped: true })).resolves.toMatchObject({
      ok: true
    })
  })

  it('refuses a distro whose orcad this desktop already reaches as another server (R25)', async () => {
    await addEnvironmentFromPairingCode(userDataPath, {
      name: 'wsl over ssh',
      pairingCode: pairing(41000, 'other-token')
    })
    const connector = makeConnector([UBUNTU])
    connector.readOrcadPublicKey.mockResolvedValue(KEY)
    const service = makeService(connector)

    await expect(service.add({ distro: 'Ubuntu' })).resolves.toMatchObject({
      ok: false,
      kind: 'ssh-managed',
      message: expect.stringContaining('wsl over ssh')
    })
    expect(connector.connect).not.toHaveBeenCalled()
  })

  it('reports a deferred activation and stays off when the experiment is off', async () => {
    const connector = makeConnector([UBUNTU])
    connector.connect.mockRejectedValueOnce(
      new WslOrcadLaunchDeferredError({
        outcome: 'deferred',
        distro: 'Ubuntu',
        candidateVersion: '2.0.0',
        code: 'live-terminals',
        reason: 'Terminals are still running.',
        forceable: true
      })
    )
    const service = makeService(connector)
    await expect(service.add({ distro: 'Ubuntu' })).resolves.toMatchObject({
      ok: false,
      kind: 'deferred',
      message: 'Terminals are still running.'
    })
    expect(listEnvironments(userDataPath)).toEqual([])

    enabled = false
    await expect(service.add({ distro: 'Ubuntu' })).resolves.toMatchObject({ kind: 'disabled' })
  })

  it('abandons the connection and holder even when failed Add cleanup cannot persist', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    const execute = secureWrites.writeSecureFileAsync
    let deployments = 0
    const write = vi
      .spyOn(secureWrites, 'writeSecureFileAsync')
      .mockImplementation((path, contents, options) => {
        if (path.endsWith('orca-environments.json')) {
          return Promise.reject(new Error('registration refused'))
        }
        if (path.endsWith('orca-wsl-host-deployments.json')) {
          deployments += 1
          if (deployments > 1) {
            return Promise.reject(new Error('cleanup refused'))
          }
        }
        return execute(path, contents, options)
      })
    try {
      await expect(service.add({ distro: 'Ubuntu' })).rejects.toThrow('cleanup refused')
      expect(connector.disconnect).toHaveBeenCalledWith('Ubuntu')
      expect(connector.releaseHolder).toHaveBeenCalledWith('Ubuntu')
      expect(connector.get('Ubuntu')).toBeNull()
      expect(ready).not.toHaveBeenCalled()
    } finally {
      write.mockRestore()
    }
  })

  it('does not register or announce an Add disabled while its persistence waits', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const held = withRuntimeEnvironmentMutation(userDataPath, async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    const adding = service.add({ distro: 'Ubuntu' })
    try {
      await vi.waitFor(() => expect(connector.connect).toHaveBeenCalledOnce())
      enabled = false
      await service.enabledChanged(false)
    } finally {
      release.resolve()
    }
    await held
    await expect(adding).resolves.toMatchObject({ ok: false, kind: 'disabled' })
    expect(listEnvironments(userDataPath)).toEqual([])
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')).toBeNull()
    expect(ready).not.toHaveBeenCalled()
    expect(published.some((status) => status.state === 'ready')).toBe(false)
  })

  it('does not publish ready when pairing persistence fails', async () => {
    const service = makeService(makeConnector([UBUNTU]))
    await service.add({ distro: 'Ubuntu' })
    ready.mockClear()
    pairingChanged.mockClear()
    published.length = 0
    const write = vi
      .spyOn(secureWrites, 'writeSecureFileAsync')
      .mockRejectedValue(new Error('pairing publication refused'))
    try {
      await service.handleConnectionChange('Ubuntu', connection('Ubuntu', 42000, 'new-token'), {
        state: 'ready',
        census: null
      })
      expect(ready).not.toHaveBeenCalled()
      expect(pairingChanged).not.toHaveBeenCalled()
      expect(published).toEqual([])
      expect(getPreferredPairingOffer(listEnvironments(userDataPath)[0]).deviceToken).toBe(
        'token-1'
      )
    } finally {
      write.mockRestore()
    }
  })

  it('restores owned port metadata when a newer disconnect cancels the main pairing write', async () => {
    const service = makeService(makeConnector([UBUNTU]))
    await service.add({ distro: 'Ubuntu' })
    ready.mockClear()
    pairingChanged.mockClear()
    published.length = 0
    const execute = secureWrites.writeSecureFileAsync
    let interrupted = false
    const write = vi
      .spyOn(secureWrites, 'writeSecureFileAsync')
      .mockImplementation(async (path, contents, options) => {
        const result = await execute(path, contents, options)
        if (path.endsWith('orca-wsl-host-deployments.json') && !interrupted) {
          interrupted = true
          await service.handleConnectionChange('Ubuntu', null, {
            state: 'distro-stopped',
            terminals: 'exited',
            recovering: false
          })
        }
        return result
      })
    try {
      await service.handleConnectionChange('Ubuntu', connection('Ubuntu', 42001, 'new-token'), {
        state: 'ready',
        census: null
      })
      expect(interrupted).toBe(true)
      expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.localPort).toBe(42000)
      const [environment] = listEnvironments(userDataPath)
      expect(environment.orcadDeployment).toMatchObject({ kind: 'wsl', localPort: 42000 })
      expect(getPreferredPairingOffer(environment).deviceToken).toBe('token-1')
      expect(published.map((status) => status.state)).toEqual(['distro-stopped'])
      expect(ready).not.toHaveBeenCalled()
      expect(pairingChanged).not.toHaveBeenCalled()
    } finally {
      write.mockRestore()
    }
  })

  it('does not let an older queued ready event replace a newer disconnect', async () => {
    const service = makeService(makeConnector([UBUNTU]))
    await service.add({ distro: 'Ubuntu' })
    ready.mockClear()
    published.length = 0
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const held = withRuntimeEnvironmentMutation(userDataPath, async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    const older = service.handleConnectionChange(
      'Ubuntu',
      connection('Ubuntu', 42000, 'old-token'),
      {
        state: 'ready',
        census: null
      }
    )
    try {
      await service.handleConnectionChange('Ubuntu', null, {
        state: 'distro-stopped',
        terminals: 'exited',
        recovering: false
      })
    } finally {
      release.resolve()
    }
    await Promise.all([held, older])
    expect(ready).not.toHaveBeenCalled()
    expect(published.map((status) => status.state)).toEqual(['distro-stopped'])
    expect(getPreferredPairingOffer(listEnvironments(userDataPath)[0]).deviceToken).toBe('token-1')
  })

  it('persists a relaunch’s new device token from onChange and retires the old transport', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })

    await service.handleConnectionChange('Ubuntu', connection('Ubuntu', 42000, 'token-2'), {
      state: 'ready',
      census: null
    })

    const [environment] = listEnvironments(userDataPath)
    expect(getPreferredPairingOffer(environment).deviceToken).toBe('token-2')
    expect(pairingChanged).toHaveBeenCalledWith('wsl:ubuntu')

    await service.handleConnectionChange('Ubuntu', null, {
      state: 'distro-stopped',
      terminals: 'exited',
      recovering: false
    })
    expect(published.at(-1)).toMatchObject({ state: 'distro-stopped', detail: null })
  })

  it('shows a deferred update while the incumbent serves, and forwards Force to the connect', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    const deferredUpdate = {
      candidateVersion: '2.0.0+ff',
      code: 'orcad_update_terminals_running',
      reason: '1 terminal is running on this host.',
      forceable: true
    }
    await service.handleConnectionChange(
      'Ubuntu',
      { ...connection('Ubuntu'), deferredUpdate },
      { state: 'ready', census: null }
    )
    expect(published.at(-1)).toMatchObject({ state: 'ready', deferredUpdate })
    // A reconnecting host is not serving the incumbent the deferral describes.
    await service.handleConnectionChange(
      'Ubuntu',
      { ...connection('Ubuntu'), deferredUpdate },
      {
        state: 'reconnecting',
        reason: 'orcad-exited',
        attempt: 1,
        retryInMs: null,
        terminals: 'unverifiable'
      }
    )
    expect(published.at(-1)).toMatchObject({
      state: 'reconnecting',
      deferredUpdate: null
    })

    await service.connect('wsl:ubuntu', { intent: 'force' })
    expect(connector.connect).toHaveBeenLastCalledWith('Ubuntu', {
      intent: 'force'
    })
    // Explicit Connect must clear standing pairing-repair failures.
    expect(connector.forgetPairingFailures).toHaveBeenLastCalledWith('wsl:ubuntu')
  })

  it('reconciles a retained dead connection for user work without booting for passive calls', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    connector.connect.mockClear()
    // No watch/holder event arrived: the bridge object outlived its server.
    connector.isReachable.mockResolvedValue(false)
    connector.reachability.mockResolvedValue('unreachable')
    expect(connector.get('Ubuntu')).not.toBeNull()

    // Return the WSL-specific disconnected verdict without booting a distro for background calls.
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow(
      'The WSL host Ubuntu isn’t connected.'
    )
    expect(connector.connect).not.toHaveBeenCalled()
    expect(service.hasUserVisibleWork('Ubuntu')).toBe(false)

    service.setVisibleWork(['wsl:ubuntu'])
    expect(service.hasUserVisibleWork('ubuntu')).toBe(true)
    // Reporting visible work connects nothing by itself (E9).
    expect(connector.connect).not.toHaveBeenCalled()

    // Visible work may reconnect to its running distro, on every later server loss.
    await service.ensureForRuntimeCall('wsl:ubuntu')
    await service.ensureForRuntimeCall('wsl:ubuntu')
    expect(connector.connect).toHaveBeenCalledTimes(2)

    service.setVisibleWork([])
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('isn’t connected')
    expect(connector.connect).toHaveBeenCalledTimes(2)
    await service.connect('wsl:ubuntu')
    expect(connector.connect).toHaveBeenCalledTimes(3)
  })

  it('refuses a connect while the experiment is off, but still removes the host', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    connector.connect.mockClear()
    enabled = false
    await service.enabledChanged(false)

    await expect(service.connect('wsl:ubuntu')).rejects.toThrow('turned off in Settings')
    service.setVisibleWork(['wsl:ubuntu'])
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow(
      'turned off in Settings'
    )
    expect(connector.connect).not.toHaveBeenCalled()

    await service.remove('wsl:ubuntu')
    expect(listEnvironments(userDataPath)).toEqual([])
  })

  it('refuses to add or connect, before any deploy work, when this build lacks the server files', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    connector.connect.mockClear()
    connector.listDistros.mockClear()
    await connector.disconnect('Ubuntu')
    serverFiles = false

    await expect(service.add({ distro: 'Debian' })).resolves.toEqual({
      ok: false,
      kind: 'server-files-missing',
      message: 'This build of Orca can’t run WSL hosts (server files missing).'
    })
    expect(connector.listDistros).not.toHaveBeenCalled()
    await expect(service.connect('wsl:ubuntu')).rejects.toThrow('server files missing')
    service.setVisibleWork(['wsl:ubuntu'])
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('server files missing')
    expect(connector.connect).not.toHaveBeenCalled()
    expect(service.hasServerFiles()).toBe(false)
  })

  it('removes a host: closes its connection, stops its server, releases the holder, drops both records', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })

    await service.remove('wsl:ubuntu')

    expect(connector.disconnect).toHaveBeenCalledWith('Ubuntu')
    expect(connector.stopServer).toHaveBeenCalledWith('Ubuntu', 'wsl:ubuntu')
    expect(connector.releaseHolder).toHaveBeenCalledWith('Ubuntu')
    expect(listEnvironments(userDataPath)).toEqual([])
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')).toBeNull()
    expect(removed).toHaveBeenCalledWith('wsl:ubuntu')
  })

  it('reports what removing left running, and removes the host anyway', async () => {
    const connector = makeConnector([UBUNTU])
    connector.stopServer.mockResolvedValueOnce({
      stopped: false,
      reason: '1 terminal kept running'
    })
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })

    await expect(service.remove('wsl:ubuntu')).resolves.toEqual({
      stopped: false,
      reason: '1 terminal kept running'
    })
    expect(listEnvironments(userDataPath)).toEqual([])
  })

  it('keeps a host whose removal failed usable and removable again', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    service.setVisibleWork(['wsl:ubuntu'])
    connector.releaseHolder.mockRejectedValueOnce(
      Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    )

    await expect(service.remove('wsl:ubuntu')).rejects.toThrow('EBUSY')

    expect(listEnvironments(userDataPath)).toHaveLength(1)
    expect(removed).not.toHaveBeenCalled()
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).resolves.toBeUndefined()
    await expect(service.connect('wsl:ubuntu')).resolves.toBeUndefined()
    await expect(service.remove('wsl:ubuntu')).resolves.toEqual({ stopped: true })
    expect(listEnvironments(userDataPath)).toEqual([])
    expect(removed).toHaveBeenCalledWith('wsl:ubuntu')
  })

  it('turning the experiment off closes every connection and releases holders; on resumes lazily', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    service.setVisibleWork(['wsl:ubuntu'])
    connector.connect.mockClear()

    enabled = false
    await service.enabledChanged(false)
    expect(connector.disconnect).toHaveBeenCalledWith('Ubuntu')
    expect(connector.releaseHolder).toHaveBeenCalledWith('Ubuntu')
    expect(published.at(-1)).toMatchObject({ environmentId: 'wsl:ubuntu', state: 'closed' })
    // Disabled experiments cannot relaunch for visible work.
    expect(service.hasUserVisibleWork('Ubuntu')).toBe(false)
    service.setVisibleWork(['wsl:ubuntu'])
    expect(connector.connect).not.toHaveBeenCalled()

    enabled = true
    await service.enabledChanged(true)
    // Nothing boots on enable; the window re-reports its focused host, which may.
    expect(connector.connect).not.toHaveBeenCalled()
    expect(service.hasUserVisibleWork('Ubuntu')).toBe(true)
    service.focusHost('wsl:ubuntu')
    await vi.waitFor(() => expect(connector.connect).toHaveBeenCalledTimes(1))
  })

  it('turning the experiment on with nothing open connects nothing', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    await connector.disconnect('Ubuntu')
    connector.connect.mockClear()
    enabled = false
    await service.enabledChanged(false)
    enabled = true
    await service.enabledChanged(true)
    expect(connector.connect).not.toHaveBeenCalled()
  })

  it('stops tracking a host before stopping its server, and never starts anything for it after', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    service.setVisibleWork(['wsl:ubuntu'])
    connector.connect.mockClear()
    let duringStop: { visible: boolean; known: boolean; connect: string } | null = null
    connector.stopServer.mockImplementationOnce(async () => {
      // The renderer still reports the open project, and a call arrives with the bridge closed.
      await connector.disconnect('Ubuntu')
      service.setVisibleWork(['wsl:ubuntu'])
      duringStop = {
        visible: service.hasUserVisibleWork('Ubuntu'),
        known: service.isKnownDistro('Ubuntu'),
        connect: await service.ensureForRuntimeCall('wsl:ubuntu').then(
          () => 'connected',
          (error: Error) => error.message
        )
      }
      return { stopped: true }
    })

    await service.remove('wsl:ubuntu')

    expect(duringStop).toEqual({
      visible: false,
      known: true,
      connect: 'This WSL host is being removed.'
    })
    expect(connector.connect).not.toHaveBeenCalled()
    expect(service.isKnownDistro('Ubuntu')).toBe(false)
    service.setVisibleWork(['wsl:ubuntu'])
    await service.ensureForRuntimeCall('wsl:ubuntu')
    expect(connector.connect).not.toHaveBeenCalled()
  })

  it('releases the holder of a failed or deferred first add, which no record would ever find', async () => {
    const connector = makeConnector([UBUNTU])
    connector.connect.mockRejectedValueOnce(new Error('deploy failed'))
    const service = makeService(connector)
    await expect(service.add({ distro: 'Ubuntu' })).resolves.toMatchObject({ kind: 'failed' })
    expect(connector.disconnect).toHaveBeenCalledWith('Ubuntu')
    expect(connector.releaseHolder).toHaveBeenCalledWith('Ubuntu')

    vi.clearAllMocks()
    connector.connect.mockRejectedValueOnce(
      new WslOrcadLaunchDeferredError({
        outcome: 'deferred',
        distro: 'Ubuntu',
        candidateVersion: '2.0.0',
        code: 'live-terminals',
        reason: 'Terminals are still running.',
        forceable: true
      })
    )
    await expect(service.add({ distro: 'Ubuntu' })).resolves.toMatchObject({ kind: 'deferred' })
    expect(connector.releaseHolder).toHaveBeenCalledWith('Ubuntu')
    expect(listEnvironments(userDataPath)).toEqual([])
  })

  it('an add the experiment was turned off during ends without a host, connection or holder', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    let finishConnect: () => void = () => {}
    connector.connect.mockImplementationOnce(async (distro: string) => {
      await new Promise<void>((resolve) => {
        finishConnect = resolve
      })
      return connection(distro)
    })
    const adding = service.add({ distro: 'Ubuntu' })
    await vi.waitFor(() => expect(connector.connect).toHaveBeenCalled())

    // Off and back on before the connect lands: the add started under the old setting.
    enabled = false
    await service.enabledChanged(false)
    enabled = true
    await service.enabledChanged(true)
    finishConnect()

    await expect(adding).resolves.toMatchObject({ ok: false, kind: 'disabled' })
    expect(listEnvironments(userDataPath)).toEqual([])
    expect(connector.disconnect).toHaveBeenCalledWith('Ubuntu')
    expect(connector.releaseHolder).toHaveBeenCalledWith('Ubuntu')
    expect(ready).not.toHaveBeenCalled()
  })

  it('treats a distro being added as known, so its first connect may spawn', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    let knownWhileAdding = false
    connector.connect.mockImplementationOnce(async (distro: string) => {
      knownWhileAdding = service.isKnownDistro(distro)
      const opened = connection(distro)
      connector.get.mockReturnValue(opened)
      return opened
    })
    await service.add({ distro: 'Ubuntu' })
    expect(knownWhileAdding).toBe(true)
  })

  it('remembers only the focused host for an early boot next launch (E9)', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    const spawn = vi.fn()
    // Open work alone is not remembered.
    service.setVisibleWork(['wsl:ubuntu'])
    expect(wakeRememberedWslHosts(userDataPath, spawn)).toEqual([])
    service.focusHost('wsl:ubuntu')
    expect(wakeRememberedWslHosts(userDataPath, spawn)).toEqual(['Ubuntu'])
    service.focusHost(null)
    expect(wakeRememberedWslHosts(userDataPath, spawn)).toEqual([])
    service.focusHost('wsl:ubuntu')
    enabled = false
    await service.enabledChanged(false)
    expect(wakeRememberedWslHosts(userDataPath, spawn)).toEqual([])
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('forgets the early-wake host when it is removed', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    service.focusHost('wsl:ubuntu')
    await service.remove('wsl:ubuntu')
    // Re-registering the distro must not bring the old early wake back.
    await service.add({ distro: 'Ubuntu' })
    expect(wakeRememberedWslHosts(userDataPath, vi.fn())).toEqual([])
  })

  it('adopts holders at startup only when a WSL host exists', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.start()
    expect(connector.adoptHolders).not.toHaveBeenCalled()

    await service.add({ distro: 'Ubuntu' })
    await service.start()
    expect(connector.adoptHolders).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      'unsupported-wsl1',
      () => new OrcadHostUnsupportedError('WSL 1 cannot run the Orca server.'),
      'WSL 1 cannot run the Orca server.'
    ],
    ['failed', () => new Error('bridge refused'), 'bridge refused']
  ])(
    'reports a %s connect, releases it, and persists nothing',
    async (kind, makeError, message) => {
      const connector = makeConnector([UBUNTU])
      connector.connect.mockRejectedValueOnce(makeError())
      const service = makeService(connector)
      await expect(service.add({ distro: 'Ubuntu' })).resolves.toEqual({ ok: false, kind, message })
      expect(listEnvironments(userDataPath)).toEqual([])
      // Unpersisted Adds own cleanup; later service operations cannot find their connection/holder.
      expect(connector.disconnect).toHaveBeenCalledExactlyOnceWith('Ubuntu')
      expect(connector.releaseHolder).toHaveBeenCalledExactlyOnceWith('Ubuntu')
      expect(ready).not.toHaveBeenCalled()
      expect(published).toEqual([])
    }
  )

  it('undoes the connection when the host cannot be saved, even if the disconnect fails', async () => {
    addEnvironmentFromPairingCode(userDataPath, {
      name: 'Ubuntu (WSL)',
      pairingCode: encodePairingOffer({
        v: 2,
        endpoint: 'ws://203.0.113.9:6768',
        deviceToken: 'other',
        publicKeyB64: Buffer.alloc(32, 9).toString('base64')
      })
    })
    const connector = makeConnector([UBUNTU])
    const order: string[] = []
    connector.disconnect.mockImplementationOnce(async () => {
      order.push('disconnect')
      throw new Error('already gone')
    })
    connector.releaseHolder.mockImplementationOnce(async () => {
      order.push('release')
      throw new Error('holder gone too')
    })
    const service = makeService(connector)
    await expect(service.add({ distro: 'Ubuntu' })).resolves.toEqual({
      ok: false,
      kind: 'failed',
      message: 'A server named "Ubuntu (WSL)" already exists.'
    })
    expect(order).toEqual(['disconnect', 'release'])
    expect(connector.disconnect).toHaveBeenCalledWith('Ubuntu')
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')).toBeNull()
    expect(ready).not.toHaveBeenCalled()
  })

  it('shares one add between concurrent requests for the same distro, by any casing', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    const first = service.add({ distro: 'Ubuntu' })
    const second = service.add({ distro: ' ubuntu ' })
    expect(second).toBe(first)
    await expect(first).resolves.toEqual({ ok: true, environmentId: 'wsl:ubuntu' })
    expect(connector.listDistros).toHaveBeenCalledTimes(1)
    expect(connector.connect).toHaveBeenCalledTimes(1)
    await expect(service.add({ distro: 'Ubuntu' })).resolves.toMatchObject({ ok: false })
    expect(connector.listDistros).toHaveBeenCalledTimes(2)
  })

  it('checks admission, then shared orcad, then connects; publishes ready before announcing it', async () => {
    const connector = makeConnector([UBUNTU])
    const order: string[] = []
    connector.listDistros.mockImplementation(async () => {
      order.push('list')
      return [UBUNTU]
    })
    connector.readOrcadPublicKey.mockImplementation(async (distro: string) => {
      order.push(`key:${distro}`)
      return null
    })
    // A new-connection deferral proves status was republished from that connection.
    const deferredUpdate = {
      candidateVersion: '2.0.0+ff',
      code: 'orcad_update_terminals_running',
      reason: '1 terminal is running on this host.',
      forceable: true
    }
    connector.connect.mockImplementation(async (distro: string) => {
      order.push(`connect:${distro}`)
      const opened = { ...connection(distro), deferredUpdate }
      connector.get.mockReturnValue(opened)
      return opened
    })
    ready.mockImplementation((id: string) => order.push(`ready:${id}:${published.length}`))
    const service = makeService(connector)
    await service.add({ distro: 'UBUNTU' })
    expect(order).toEqual(['list', 'key:Ubuntu', 'connect:Ubuntu', 'ready:wsl:ubuntu:1'])
    expect(published).toEqual([
      {
        environmentId: 'wsl:ubuntu',
        distro: 'Ubuntu',
        state: 'ready',
        detail: null,
        deferredUpdate
      }
    ])
  })

  it('refuses an add with no WSL connector before touching one, while turned off', async () => {
    enabled = false
    const service = new WslHostService({
      userDataPath: () => userDataPath,
      isEnabled: () => enabled,
      hasServerFiles: () => serverFiles,
      publish: (status) => published.push(status),
      pairingChanged,
      ready,
      removed
    })
    await expect(service.add({ distro: 'Ubuntu' })).resolves.toMatchObject({ ok: false })
    enabled = true
    await expect(service.add({ distro: 'Ubuntu' })).rejects.toThrow(
      'WSL hosts are not available on this computer.'
    )
  })
})
