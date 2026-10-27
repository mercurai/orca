import { WslHostConnectionChanges } from './wsl-host-connection-change'
/**
 * C7/E9: persist WSL hosts and connect them. A stopped distro boots only for an explicit
 * Add/Connect, or when the user switches to one of its workspaces. After a confirmed stop the host is
 * parked: polls and visible work keep it down until the user acts or the distro runs again.
 */
import { errorMessage } from '../../shared/error-message'
import { focusReachability } from './wsl-host-focus-reachability'
import { reconnectWslHostForRuntimeCall } from './wsl-host-runtime-reconnect'
import type { WslHostServiceDependencies } from './wsl-host-service-contract'
import { removeWslHostEnvironment } from '../../shared/runtime-environment-wsl-host-store'
import type { WslHostDeploymentRecord } from '../../shared/wsl-host-deployment-store'
import type {
  WslHostAddResult,
  WslHostConnectIntent,
  WslHostDistro,
  WslHostServerStop,
  WslHostStatus
} from '../../shared/wsl-host-types'
import type { WslHostConnector } from './wsl-host-connector-contract'
import { wslDistroHolderKey } from './wsl-distro-holder-record'
import {
  persistWslHostConnection,
  readWslHostRecordsQuietly,
  toWslHostStatus
} from './wsl-host-connection-record'
import {
  sameWslDistro,
  WSL_HOST_REMOVING_MESSAGE,
  wslHostRunRefusal
} from './wsl-host-add-admission'
import type { WslOrcadConnection } from './wsl-orcad-connection'
import { registerWslHost } from './wsl-host-registration'
import type { WslOrcadConnectionStatus } from './wsl-orcad-connection-status'
import {
  forgetWslHostToWake,
  forgetWslHostsToWake,
  rememberWslHostsToWake
} from './wsl-host-early-wake'

export type { WslHostConnector, WslHostReachability } from './wsl-host-connector-contract'

export type { WslHostServiceDependencies } from './wsl-host-service-contract'

export class WslHostService {
  private connector: WslHostConnector | null = null
  private readonly statuses = new Map<string, WslHostStatus>()
  private readonly adding = new Map<string, Promise<WslHostAddResult>>()
  private visible = new Set<string>()
  private readonly parked = new Set<string>()
  private readonly removing = new Set<string>()
  // Bumped on disable so an Add that started before it cannot finish as a ready host.
  private disableGeneration = 0
  private readonly connectionChanges: WslHostConnectionChanges
  private readonly statusListeners = new Set<() => void>()

  constructor(private readonly deps: WslHostServiceDependencies) {
    this.connectionChanges = new WslHostConnectionChanges({
      record: (distro) => this.recordForDistro(distro),
      generation: () => this.disableGeneration,
      current: (record, generation) => this.connectionIsCurrent(record, generation),
      persist: (record, connection, current) =>
        persistWslHostConnection(deps.userDataPath(), record, connection, current),
      pairingChanged: deps.pairingChanged,
      publish: (record, status, connection) => {
        if (status.state === 'distro-stopped') {
          this.parked.add(record.environmentId)
        } else if (status.state === 'ready') {
          this.parked.delete(record.environmentId)
        }
        this.setStatus(record, status, connection)
        if (status.state === 'ready' && connection) {
          deps.ready(record.environmentId)
        }
      }
    })
  }

  /** Two-phase so the connector's `onChange` can call back into this service. */
  attach(connector: WslHostConnector): void {
    this.connector = connector
  }

  private get wsl(): WslHostConnector {
    if (!this.connector) {
      throw new Error('WSL hosts are not available on this computer.')
    }
    return this.connector
  }

  /** C5's `onChange`: persist what moved, then tell the UI. */
  handleConnectionChange(
    distro: string,
    connection: WslOrcadConnection | null,
    status: WslOrcadConnectionStatus
  ): Promise<void> {
    return this.connectionChanges.handle(distro, connection, status)
  }

  private connectionIsCurrent(record: WslHostDeploymentRecord, generation: number): boolean {
    const owner = this.recordForEnvironment(record.environmentId)
    return (
      this.disableGeneration === generation &&
      !this.removing.has(record.environmentId) &&
      owner?.createdAt === record.createdAt &&
      owner.distroId === record.distroId &&
      this.canRun()
    )
  }

  getStatuses(): WslHostStatus[] {
    return [...this.statuses.values()]
  }

  /** Hears every change to what `getStatuses` returns. */
  onStatusesChanged(listener: () => void): () => void {
    this.statusListeners.add(listener)
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  private notifyStatusesChanged(): void {
    for (const listener of this.statusListeners) {
      listener()
    }
  }

  async listDistros(): Promise<WslHostDistro[]> {
    const records = this.records()
    const candidates = await this.wsl.listDistros()
    return candidates.map(({ id: _id, ...distro }) => ({
      ...distro,
      environmentId:
        records.find((record) => sameWslDistro(record.distro, distro.name))?.environmentId ?? null
    }))
  }

  add(args: { distro: string; startIfStopped?: boolean }): Promise<WslHostAddResult> {
    const key = wslDistroHolderKey(args.distro)
    const pending = this.adding.get(key)
    if (pending) {
      return pending
    }
    const operation = registerWslHost(
      {
        deps: this.deps,
        wsl: () => this.wsl,
        disableGeneration: () => this.disableGeneration,
        canRegister: (environmentId) => this.canRun() && !this.removing.has(environmentId),
        recordForDistro: (distro) => this.recordForDistro(distro),
        recordForEnvironment: (environmentId) => this.recordForEnvironment(environmentId),
        setReady: (record, connection) =>
          this.setStatus(record, { state: 'ready', census: null }, connection)
      },
      args
    ).finally(() => this.adding.delete(key))
    this.adding.set(key, operation)
    return operation
  }

  async remove(environmentId: string): Promise<WslHostServerStop> {
    const record = this.recordForEnvironment(environmentId)
    if (!record) {
      throw new Error('This server is not a WSL host.')
    }
    // First: nothing may reconnect it while it is being stopped (open work, liveness, calls).
    this.removing.add(environmentId)
    const connector = this.connector
    let serverStop: WslHostServerStop = { stopped: true }
    try {
      if (connector) {
        serverStop = await connector
          .stopServer(record.distro, environmentId)
          .catch((error: unknown) => ({ stopped: false, reason: errorMessage(error) }))
        await connector.disconnect(record.distro)
        // Without its holder the distro idles out.
        await connector.releaseHolder(record.distro)
      }
      await removeWslHostEnvironment(this.deps.userDataPath(), environmentId)
      await forgetWslHostToWake(this.deps.userDataPath(), record.distro)
      this.visible.delete(environmentId)
      this.parked.delete(environmentId)
    } finally {
      // Why: a failed removal (e.g. EBUSY on Windows) must leave the host usable and removable.
      this.removing.delete(environmentId)
    }
    this.statuses.delete(environmentId)
    this.notifyStatusesChanged()
    await this.deps.removed(environmentId)
    return serverStop
  }

  /**
   * Turning the experiment off ends every connection and liveness watch and releases the
   * holders, so distros idle-stop; turning it on resumes only hosts open work needs.
   */
  async enabledChanged(enabled: boolean): Promise<void> {
    const connector = this.connector
    if (!connector) {
      return
    }
    if (enabled) {
      // Nothing boots here: the window re-reports its focused host, the only one that may (E9).
      return
    }
    this.disableGeneration += 1
    const forgetting = forgetWslHostsToWake(this.deps.userDataPath())
    for (const record of this.records()) {
      await connector.disconnect(record.distro)
      await connector.releaseHolder(record.distro)
      this.setStatus(record, { state: 'closed' })
    }
    await forgetting
  }

  /** The user asked for this host: may boot its distro. An intent retries or forces an update. */
  async connect(
    environmentId: string,
    options: { intent?: WslHostConnectIntent } = {}
  ): Promise<void> {
    const record = this.recordForEnvironment(environmentId)
    if (!record) {
      throw new Error('This server is not a WSL host.')
    }
    const refusal = wslHostRunRefusal(this.deps)
    if (refusal || this.removing.has(environmentId)) {
      throw new Error(refusal?.message ?? WSL_HOST_REMOVING_MESSAGE)
    }
    this.wsl.forgetPairingFailures?.(environmentId)
    this.parked.delete(environmentId)
    await this.wsl.connect(record.distro, options)
  }

  /**
   * A runtime call (a poll, a fetch) never boots a distro (E9). It reconnects only to a distro
   * confirmed running and only for visible work; a confirmed stop parks the host.
   */
  async ensureForRuntimeCall(environmentId: string): Promise<void> {
    const connector = this.connector
    const generation = this.disableGeneration
    await reconnectWslHostForRuntimeCall(this.recordForEnvironment(environmentId), {
      connector,
      current: (record) =>
        this.connector === connector && this.connectionIsCurrent(record, generation),
      refusal: () =>
        wslHostRunRefusal(this.deps)?.message ??
        (this.removing.has(environmentId) ? WSL_HOST_REMOVING_MESSAGE : null),
      visible: () => this.visible.has(environmentId),
      parked: this.parked
    })
  }

  /**
   * The user switched to a workspace on this host (or launch restored it focused): the one
   * non-explicit act that may boot its distro, and it lifts a park.
   */
  focusHost(environmentId: string | null): void {
    const record = environmentId ? this.recordForEnvironment(environmentId) : null
    const runnable = record !== null && this.mayWake(record)
    // The next launch starts booting only this distro, early (none when off WSL or not runnable).
    void rememberWslHostsToWake(this.deps.userDataPath(), record && runnable ? [record.distro] : [])
    if (record && runnable) {
      this.wake(record).catch((error: unknown) => {
        console.warn(`[wsl-hosts] Could not connect to ${record.distro}:`, error)
      })
    }
  }

  /** E9: an enabled automation came due with the host off; boots the distro once, lifting a park. */
  async wakeForAutomation(environmentId: string): Promise<void> {
    const record = this.recordForEnvironment(environmentId)
    if (record && this.mayWake(record)) {
      await this.wake(record)
    }
  }

  private mayWake(record: WslHostDeploymentRecord): boolean {
    return Boolean(this.connector) && this.canRun() && !this.removing.has(record.environmentId)
  }

  /** A focus entry or a due automation: lifts a park and may boot the distro. */
  private async wake(record: WslHostDeploymentRecord): Promise<void> {
    const connector = this.connector
    if (!connector) {
      return
    }
    const generation = this.disableGeneration
    this.parked.delete(record.environmentId)
    const reachability = await focusReachability(connector, record)
    if (this.connector !== connector || !this.connectionIsCurrent(record, generation)) {
      return
    }
    if (reachability !== 'available') {
      await connector.connect(record.distro)
    }
  }

  /** Whether the host's server answers through this process now; never starts a stopped distro. */
  async isConnected(environmentId: string): Promise<boolean> {
    const record = this.recordForEnvironment(environmentId)
    return record && this.connector
      ? (await this.connector.reachability(record.distro, environmentId)) === 'available'
      : false
  }

  /** Whether anything may still be started for this distro (spawn guard). */
  isKnownDistro(distro: string): boolean {
    return this.adding.has(wslDistroHolderKey(distro)) || this.recordForDistro(distro) !== null
  }

  /** Hosts with open work across windows; this never connects anything by itself. */
  setVisibleWork(environmentIds: readonly string[]): void {
    this.visible = new Set(environmentIds.filter((id) => !this.removing.has(id)))
  }

  hasUserVisibleWork(distro: string): boolean {
    const record = this.recordForDistro(distro)
    // Why the gate: liveness relaunches only for visible work, and none may run while off.
    const id = record?.environmentId
    return id ? this.canRun() && this.visible.has(id) && !this.removing.has(id) : false
  }

  /** Startup: keep the holders a previous run left, without booting anything. */
  async start(): Promise<void> {
    if (!this.connector || !this.canRun() || this.records().length === 0) {
      return
    }
    await this.connector.adoptHolders()
  }

  /** What the UI shows before offering any WSL host action. */
  hasServerFiles(): boolean {
    return this.deps.hasServerFiles()
  }

  private canRun(): boolean {
    return wslHostRunRefusal(this.deps) === null
  }

  async dispose(): Promise<void> {
    await this.connector?.dispose()
  }

  private setStatus(
    record: WslHostDeploymentRecord,
    status: WslOrcadConnectionStatus,
    connection: WslOrcadConnection | null = null
  ): void {
    const next = toWslHostStatus(record, status, connection)
    this.statuses.set(record.environmentId, next)
    this.deps.publish(next)
    this.notifyStatusesChanged()
  }

  private records(): WslHostDeploymentRecord[] {
    return readWslHostRecordsQuietly(this.deps.userDataPath())
  }

  private recordForDistro(distro: string): WslHostDeploymentRecord | null {
    return this.records().find((record) => sameWslDistro(record.distro, distro)) ?? null
  }

  /** The registered WSL host behind an environment; null for any other environment. */
  recordForEnvironment(environmentId: string): WslHostDeploymentRecord | null {
    return this.records().find((record) => record.environmentId === environmentId) ?? null
  }
}
