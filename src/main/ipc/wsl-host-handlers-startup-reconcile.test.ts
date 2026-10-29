import { afterEach, describe, expect, it, vi } from 'vitest'

const order = vi.hoisted(() => ({ calls: new Array<string>(), serving: true, barrier: null as Promise<void> | null, listener: null as ((...args: unknown[]) => void) | null, failure: false, active: null as string | null }))
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() }
}))
vi.mock('../wsl/wsl-host-gate', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  wslHostsServing: () => order.serving
}))
vi.mock('../../shared/runtime-environment-wsl-host-store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  reconcileWslHostBridgePorts: async () => {
    order.calls.push('reconcile')
    await order.barrier
    if (order.failure) throw new Error('reconcile failed')
    return []
  }
}))
vi.mock('../wsl/wsl-host-connector', () => ({ createWslHostConnector: vi.fn() }))
vi.mock('../wsl/wsl-host-e2e-fake-connector', () => ({
  readFakeWslHostsConfig: () => ({ serverFiles: 'present' }),
  createFakeWslHostConnector: (_config: unknown, onChange: (...args: unknown[]) => void) => {
    order.listener = onChange
    order.calls.push('connector')
    return {
      connect: async () => {
        order.calls.push('connect')
      }
    }
  }
}))
vi.mock('../wsl/wsl-orphan-holder-release', () => ({
  releaseUnwantedWslHolders: async () => {},
  wslHolderKeepPolicy: () => () => true
}))
vi.mock('./wsl-host-automation-wake-wiring', () => ({ createWslHostAutomationWake: () => null }))
vi.mock('../wsl/wsl-host-service', () => ({
  WslHostService: class {
    connector: { connect: (distro: string) => Promise<void> } | null = null
    attach(connector: { connect: (distro: string) => Promise<void> }): void {
      this.connector = connector
    }
    connectionChangeListener(origin: () => unknown): () => Promise<void> {
      return async () => { if (origin() === this.connector) order.calls.push('change') }
    }
    async remove(): Promise<{ stopped: true }> {
      order.calls.push('remove')
      return { stopped: true }
    }
    isKnownDistro(): boolean {
      return true
    }
    hasUserVisibleWork(): boolean {
      return false
    }
    // Startup's first bridge work: adopting holders, then any reconnect.
    async start(): Promise<void> {
      order.calls.push('start')
      await this.connector?.connect('Ubuntu')
    }
  }
}))
const instance = vi.hoisted((): { service: unknown } => ({ service: null }))
vi.mock('../wsl/wsl-host-service-instance', () => ({
  getWslHostService: () => instance.service,
  setWslHostService: (service: unknown) => {
    instance.service = service
  },
  // The phone's gate is built beside the service; startup order is all this suite checks.
  setWslHostPhoneGate: () => {}
}))

import { registerWslHostHandlers } from './wsl-host-handlers'
import { ipcMain } from 'electron'

function register(): Promise<void> {
  return registerWslHostHandlers({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: startup reads settings only through onSettingsChanged.
    store: { getSettings: () => ({ activeRuntimeEnvironmentId: order.active }), onSettingsChanged: vi.fn() } as never,
    getUserDataPath: () => '/user-data',
    invalidateTransport: vi.fn()
  })
}

// A crash between a pairing save's two writes hides the host unless its record is realigned first.
describe('WSL host startup: the bridge-port reconcile', () => {
  afterEach(() => {
    order.calls = []
    order.serving = true
    order.barrier = null
    order.listener = null
    order.failure = false
    order.active = null
    instance.service = null
  })

  it('realigns saved records before the connector exists or any bridge connects', async () => {
    await register()
    await vi.waitFor(() => expect(order.calls).toContain('connect'))
    expect(order.calls).toEqual(['reconcile', 'connector', 'start', 'connect'])
  })

  it('registers IPC immediately but waits for reconciliation before connector and readiness', async () => {
    const barrier = Promise.withResolvers<void>()
    order.barrier = barrier.promise
    const ready = register()
    expect(order.calls).toEqual(['reconcile'])
    expect(instance.service).toBeNull()
    expect(ipcMain.handle).toHaveBeenCalledWith('wslHosts:getStatuses', expect.any(Function))
    barrier.resolve()
    await ready
    expect(order.calls).toEqual(['reconcile', 'connector', 'start', 'connect'])
  })

  it('refuses a queued removal if the host becomes the default before reconciliation completes', async () => {
    const barrier = Promise.withResolvers<void>()
    order.barrier = barrier.promise
    const ready = register()
    const call = vi.mocked(ipcMain.handle).mock.calls.findLast(([name]) => name === 'wslHosts:remove')
    if (!call) throw new Error('Missing removal handler')
    const removing = Promise.resolve(call[1]({} as never, { environmentId: 'wsl:ubuntu' }))
    const refusal = expect(removing).rejects.toThrow('default host for new projects')
    order.active = 'wsl:ubuntu'
    barrier.resolve()
    await ready
    await refusal
    expect(order.calls).not.toContain('remove')
  })

  it('does not create a connector if serving is revoked during reconciliation', async () => {
    const barrier = Promise.withResolvers<void>()
    order.barrier = barrier.promise
    const ready = register()
    order.serving = false
    barrier.resolve()
    await ready
    expect(order.calls).toEqual(['reconcile'])
    expect(instance.service).toBeNull()
  })

  it('ignores a callback from a connector replaced after registration', async () => {
    await register()
    const callback = order.listener
    expect(callback).not.toBeNull()
    // SAFETY: this suite installs the service stub above.
    const service = instance.service as { attach: (value: unknown) => void }
    service.attach({ connect: async () => {} })
    callback?.('Ubuntu', null, { state: 'closed' })
    await Promise.resolve()
    expect(order.calls).not.toContain('change')
  })

  it('shares reconciliation across concurrent registration calls', async () => {
    const barrier = Promise.withResolvers<void>()
    order.barrier = barrier.promise
    const first = register()
    const second = register()
    expect(order.calls).toEqual(['reconcile'])
    barrier.resolve()
    await Promise.all([first, second])
    expect(order.calls).toEqual(['reconcile', 'connector', 'start', 'connect'])
  })

  it('rejects readiness without creating a connector when reconciliation fails', async () => {
    order.failure = true
    await expect(register()).rejects.toThrow('reconcile failed')
    expect(order.calls).toEqual(['reconcile'])
    expect(instance.service).toBeNull()
  })

  it('reads and writes no record while WSL hosts are not serving', async () => {
    order.serving = false
    await register()
    expect(order.calls).toEqual([])
    expect(instance.service).toBeNull()
  })
})
