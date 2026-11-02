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
import { getWslHostDeploymentStorePath } from '../../shared/wsl-host-deployment-store'
import { getPreferredPairingOffer } from '../../shared/runtime-environments'
import type { WslHostStatus } from '../../shared/wsl-host-types'
import { OrcadHostUnsupportedError } from '../orcad/orcad-host-unavailable'
import { RemoteNodeRuntimeSelfTestError } from '../ssh/orcad-remote-node-runtime-report'
import { WslHostService, type WslHostConnector } from './wsl-host-service'
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

  it('re-saves the live connection on request, so the deployment link overlays again', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    await service.resaveConnection('wsl:missing')
    connector.get.mockReturnValue(connection('Ubuntu', 42001, 'token-2'))
    pairingChanged.mockClear()

    await service.resaveConnection('wsl:ubuntu')

    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.localPort).toBe(42001)
    expect(listEnvironments(userDataPath)).toMatchObject([
      { id: 'wsl:ubuntu', orcadDeployment: { kind: 'wsl', localPort: 42001 } }
    ])
    expect(pairingChanged).toHaveBeenCalledExactlyOnceWith('wsl:ubuntu')
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

  it('ignores a connection callback from a replaced connector', async () => {
    const original = makeConnector([UBUNTU])
    const service = makeService(original)
    await service.add({ distro: 'Ubuntu' })
    const oldCallback = service.connectionChangeListener(() => original)
    const replacement = makeConnector([UBUNTU])
    service.attach(replacement)
    ready.mockClear()
    pairingChanged.mockClear()
    published.length = 0

    await oldCallback('Ubuntu', connection('Ubuntu', 42001, 'obsolete-token'), {
      state: 'ready',
      census: null
    })
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.localPort).not.toBe(42001)
    expect(ready).not.toHaveBeenCalled()
    expect(pairingChanged).not.toHaveBeenCalled()
    expect(published).toEqual([])
  })

  it('does not publish a connector callback that waits across replacement', async () => {
    const original = makeConnector([UBUNTU])
    const service = makeService(original)
    await service.add({ distro: 'Ubuntu' })
    const callback = service.connectionChangeListener(() => original)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const held = withRuntimeEnvironmentMutation(userDataPath, async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    ready.mockClear()
    pairingChanged.mockClear()
    published.length = 0
    const pending = callback('Ubuntu', connection('Ubuntu', 42001, 'obsolete-token'), {
      state: 'ready',
      census: null
    })
    service.attach(makeConnector([UBUNTU]))
    release.resolve()
    await held
    await pending
    expect(findWslHostDeployment(userDataPath, 'wsl:ubuntu')?.localPort).not.toBe(42001)
    expect(ready).not.toHaveBeenCalled()
    expect(pairingChanged).not.toHaveBeenCalled()
    expect(published).toEqual([])
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

  // Stage 1: the setting governs new work only; a saved host keeps serving, as in serve-only.
  it('keeps serving a saved host with the setting off: connect and Remove still work', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    connector.connect.mockClear()
    enabled = false
    await service.enabledChanged(false)

    await service.connect('wsl:ubuntu')
    expect(connector.connect).toHaveBeenCalledExactlyOnceWith('Ubuntu', expect.anything())

    await service.remove('wsl:ubuntu')
    expect(listEnvironments(userDataPath)).toEqual([])
  })

  it('refuses a new host while the setting is off', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    enabled = false
    await expect(service.add({ distro: 'Ubuntu' })).resolves.toMatchObject({
      ok: false,
      kind: 'disabled'
    })
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
      message: 'This build of Orca can’t run WSL hosts (server files missing).',
      errorCode: 'serverFilesMissing'
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

  it('turning the setting off keeps every connection and holder; turning it on boots nothing', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    service.setVisibleWork(['wsl:ubuntu'])
    connector.connect.mockClear()

    enabled = false
    await service.enabledChanged(false)
    expect(connector.disconnect).not.toHaveBeenCalled()
    expect(connector.releaseHolder).not.toHaveBeenCalled()
    expect(published.at(-1)).not.toMatchObject({ state: 'closed' })
    // A moved project's work keeps its host up.
    expect(service.hasUserVisibleWork('Ubuntu')).toBe(true)

    enabled = true
    await service.enabledChanged(true)
    // Nothing boots on enable; the window re-reports its focused host, which may.
    expect(connector.connect).not.toHaveBeenCalled()
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

  it('keeps a confirmed-stopped host down for polls and for a switch back to it; only a running distro reconnects (E9)', async () => {
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
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('Ubuntu is stopped')
    expect(connector.connect).not.toHaveBeenCalled()

    // Switching back to one of its workspaces is navigation: it re-checks, never starts it.
    service.focusHost('wsl:ubuntu')
    await vi.waitFor(() =>
      expect(connector.reachability).toHaveBeenCalledWith('Ubuntu', 'wsl:ubuntu')
    )
    expect(connector.connect).not.toHaveBeenCalled()
    expect(published.at(-1)).toMatchObject({ environmentId: 'wsl:ubuntu', state: 'distro-stopped' })

    // Once the distro runs (the user's Start or a terminal), a switch connects without booting.
    connector.distro.state = 'running'
    service.focusHost('wsl:ubuntu')
    await vi.waitFor(() => expect(connector.connect).toHaveBeenCalledTimes(1))
    expect(connector.connect).toHaveBeenCalledWith('Ubuntu', { noBoot: true })
  })

  it('focus reads the running list before connecting, even with no bridge in this process', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    await connector.disconnect('Ubuntu')
    connector.reachability.mockClear()
    connector.connect.mockClear()

    service.focusHost('wsl:ubuntu')
    await vi.waitFor(() => expect(connector.connect).toHaveBeenCalledTimes(1))
    expect(connector.reachability).toHaveBeenCalledWith('Ubuntu', 'wsl:ubuntu')
    expect(connector.connect).toHaveBeenCalledWith('Ubuntu', { noBoot: true })
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
    expect(String(refusal)).toContain('Ubuntu is stopped')
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
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('Ubuntu is stopped')
    // Running again (started some other way) is not enough while parked: still no boot from a poll.
    connector.distro.state = 'running'
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('Ubuntu is stopped')
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
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).rejects.toThrow('Ubuntu is stopped')
    expect(connector.connect).not.toHaveBeenCalled()
  })

  it('a launch restore or switch to a stopped host never connects it and shows it stopped (E9)', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    await connector.disconnect('Ubuntu')
    connector.distro.state = 'stopped'
    connector.connect.mockClear()

    // The window reports the restored active workspace's host at launch, before any user act.
    service.focusHost('wsl:ubuntu')

    await vi.waitFor(() =>
      expect(published.at(-1)).toMatchObject({
        environmentId: 'wsl:ubuntu',
        state: 'distro-stopped'
      })
    )
    expect(connector.connect).not.toHaveBeenCalled()
  })

  it('a focus re-check overtaken by a user Start never publishes stopped over the live host', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    await connector.disconnect('Ubuntu')
    connector.distro.state = 'stopped'
    let finishRead: (state: 'stopped') => void = () => {}
    connector.reachability.mockImplementationOnce(
      () => new Promise((resolve) => (finishRead = resolve))
    )

    service.focusHost('wsl:ubuntu')
    await vi.waitFor(() => expect(connector.reachability).toHaveBeenCalled())
    // The user's Start boots and connects while the focus read is still out.
    connector.distro.state = 'running'
    await service.connect('wsl:ubuntu')
    service.handleConnectionChange('Ubuntu', connection('Ubuntu'), { state: 'ready', census: null })
    finishRead('stopped')

    await vi.waitFor(() => expect(connector.reachability).toHaveBeenCalledTimes(2))
    await expect(service.ensureForRuntimeCall('wsl:ubuntu')).resolves.toBeUndefined()
    expect(published.at(-1)).toMatchObject({ environmentId: 'wsl:ubuntu', state: 'ready' })
    expect(published.filter((status) => status.state === 'distro-stopped')).toEqual([])
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

  it('a due automation boots a parked host once while the setting is on', async () => {
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
    await service.wakeForAutomation('wsl:ubuntu')
    expect(connector.connect).toHaveBeenCalledExactlyOnceWith('Ubuntu')
    await expect(service.isConnected('wsl:ubuntu')).resolves.toBe(true)
  })

  it('a due automation boots nothing once the setting has been turned off', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    await connector.disconnect('Ubuntu')
    service.handleConnectionChange('Ubuntu', null, {
      state: 'distro-stopped',
      terminals: 'exited',
      recovering: false
    })
    enabled = false
    await service.enabledChanged(false)
    connector.connect.mockClear()
    await service.wakeForAutomation('wsl:ubuntu')
    expect(connector.connect).not.toHaveBeenCalled()
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
    await drainPendingPathWrites()
    expect(wakeRememberedWslHosts(userDataPath, spawn)).toEqual(['Ubuntu'])
    service.focusHost(null)
    await drainPendingPathWrites()
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

  it('keeps the startup holders of its hosts and releases orphans', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    await service.start()
    const [isWanted] = connector.adoptHolders.mock.calls[0]
    expect(isWanted('ubuntu')).toBe(true)
    // A failed add or remove left a holder for a distro that is no longer a host.
    expect(isWanted('Debian')).toBe(false)
  })

  it('keeps every startup holder when the host records cannot all be read', async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    writeFileSync(getWslHostDeploymentStorePath(userDataPath), '{not json')
    await service.start()
    const [isWanted] = connector.adoptHolders.mock.calls[0]
    expect(isWanted('Debian')).toBe(true)
  })

  it("keeps a saved host's startup holder while the setting is off", async () => {
    const connector = makeConnector([UBUNTU])
    const service = makeService(connector)
    await service.add({ distro: 'Ubuntu' })
    enabled = false
    await service.start()
    const [isWanted] = connector.adoptHolders.mock.calls[0]
    expect(isWanted('Ubuntu')).toBe(true)
  })

  it.each([
    [
      'unsupported-distro',
      () => new OrcadHostUnsupportedError('No Orca runtime supports linux-arm64-glibc.'),
      'No Orca runtime supports linux-arm64-glibc.'
    ],
    [
      'unsupported-distro',
      () =>
        new RemoteNodeRuntimeSelfTestError(127, 'libstdc++.so.6: cannot open shared object file'),
      expect.stringContaining('apk add libstdc++')
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
    await addEnvironmentFromPairingCode(userDataPath, {
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
