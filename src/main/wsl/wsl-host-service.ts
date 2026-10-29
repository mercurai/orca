import {
  connectWslHost,
  wakeWslHost,
  wslHostConnectRefusal,
  type WslHostConnectOptions
} from './wsl-host-connect'
import { WslHostConnectionChanges } from './wsl-host-connection-change'
/**
 * C7/E9: persist WSL hosts and connect them. A stopped distro boots only for an explicit
 * Add/Connect, or when the user switches to one of its workspaces. After a confirmed stop the host is
 * parked: polls and visible work keep it down until the user acts or the distro runs again.
 */
import { ensureWslHostForRuntimeCall } from './wsl-host-runtime-call'
import type { WslHostDeploymentRecord } from '../../shared/wsl-host-deployment-store'
import type {
  WslHostAddResult,
  WslHostDistro,
  WslHostServerStop,
  WslHostStatus
} from '../../shared/wsl-host-types'
import type { WslHostConnector, WslHostServiceDependencies } from './wsl-host-connector-contract'
import { wslDistroHolderKey } from './wsl-distro-holder-record'
import {
  persistWslHostConnection,
  readWslHostRecordsQuietly,
  toWslHostStatus
} from './wsl-host-connection-record'
import {
  sameWslDistro,
  wslHostRunRefusal
} from './wsl-host-add-admission'
import type { WslOrcadConnection } from './wsl-orcad-connection'
import { registerWslHost } from './wsl-host-registration'
import { WslHostStatusBoard } from './wsl-host-status-board'
import { withWslHostIds } from './wsl-host-records'
import { wslHolderKeepPolicy } from './wsl-orphan-holder-release'
import { readdPendingWslHost, removeWslHostAndPublish } from './wsl-host-removal'
import type { WslOrcadConnectionStatus } from './wsl-orcad-connection-status'
import { forgetWslHostsToWake, rememberWslHostsToWake } from './wsl-host-early-wake'

export type {
  WslHostConnector,
  WslHostReachability,
  WslHostServiceDependencies
} from './wsl-host-connector-contract'

export class WslHostService {
  private connector: WslHostConnector | null = null
  private readonly board = new WslHostStatusBoard((status) => this.deps.publish(status))
  private readonly adding = new Map<string, Promise<WslHostAddResult>>()
  private visible = new Set<string>()
  private readonly parked = new Set<string>()
  private readonly removing = new Set<string>()
  // Bumped on disable so an Add that started before it cannot finish as a ready host.
  private disableGeneration = 0
  private readonly connectionChanges: WslHostConnectionChanges

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
    if (this.connector && this.connector !== connector) this.disableGeneration += 1
    this.connector = connector
  }

  private get wsl(): WslHostConnector {
    if (!this.connector) {
      throw new Error('WSL hosts are not available on this computer.')
    }
    return this.connector
  }

  /** The factory closes over its connector even when a replacement is attached later. */
  connectionChangeListener(origin: () => WslHostConnector | null) {
    return (distro: string, connection: WslOrcadConnection | null, status: WslOrcadConnectionStatus): Promise<void> =>
      this.connectionChanges.handle(distro, connection, status, () => {
        const connector = origin()
        return connector !== null && this.connector === connector
      })
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
      !owner.pendingStop &&
      this.canRun()
    )
  }

  getStatuses(): WslHostStatus[] {
    return this.board.list()
  }

  /** Hears every change to what `getStatuses` returns. */
  onStatusesChanged(listener: () => void): () => void {
    return this.board.onChanged(listener)
  }

  async listDistros(): Promise<WslHostDistro[]> {
    return withWslHostIds(await this.wsl.listDistros(), this.records())
  }

  add(args: { distro: string; startIfStopped?: boolean }): Promise<WslHostAddResult> {
    const key = wslDistroHolderKey(args.distro)
    const pending = this.adding.get(key)
    if (pending) {
      return pending
    }
    const unfinishedRemoval = this.recordForDistro(args.distro)
    if (unfinishedRemoval?.pendingStop) {
      const { environmentId } = unfinishedRemoval
      return readdPendingWslHost(args, {
        listDistros: () => this.wsl.listDistros(),
        keep: () => this.connect(environmentId, { withdrawPendingRemoval: true }),
        environmentId
      })
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
    // Block reconnect from visible work, liveness and calls before stopping; a failed removal
    // must leave the host usable and allow another attempt.
    this.removing.add(environmentId)
    try {
      return await removeWslHostAndPublish(this.deps.userDataPath(), this.connector, record, {
        currentRecord: () => this.recordForEnvironment(environmentId),
        close: (current) => this.setStatus(current, { state: 'closed' }),
        retire: async () => {
          this.visible.delete(environmentId)
          this.parked.delete(environmentId)
          this.board.delete(environmentId)
          await this.deps.removed(environmentId)
        }
      })
    } finally {
      this.removing.delete(environmentId)
    }
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
    const generation = this.disableGeneration
    const forgetting = forgetWslHostsToWake(this.deps.userDataPath())
    for (const record of this.records()) {
      const owns = (): boolean => {
        const current = this.recordForEnvironment(record.environmentId)
        return this.connector === connector && this.disableGeneration === generation &&
          current?.createdAt === record.createdAt && current.distroId === record.distroId
      }
      if (!owns()) continue
      await connector.disconnect(record.distro)
      if (!owns()) continue
      await connector.releaseHolder(record.distro)
      if (owns()) this.setStatus(record, { state: 'closed' })
    }
    await forgetting
  }

  /**
   * The user asked for this host: may boot its distro. An intent retries or forces an update.
   * Only the user's own Connect or Add withdraws an unfinished Remove; any other caller is refused.
   */
  connect(environmentId: string, options: WslHostConnectOptions = {}): Promise<void> {
    const connector = this.connector
    const generation = this.disableGeneration
    return connectWslHost(this.recordForEnvironment(environmentId), options, {
      connector,
      userDataPath: () => this.deps.userDataPath(),
      current: (record) =>
        this.connector === connector && this.connectionIsCurrent(record, generation),
      refusal: () => wslHostConnectRefusal(this.deps, this.removing.has(environmentId)),
      parked: this.parked
    })
  }

  /** A runtime call (a poll, a fetch) never boots a distro (E9); see ensureWslHostForRuntimeCall. */
  async ensureForRuntimeCall(environmentId: string): Promise<void> {
    const connector = this.connector
    const generation = this.disableGeneration
    await ensureWslHostForRuntimeCall(environmentId, {
      record: this.recordForEnvironment(environmentId),
      connector,
      current: (record) => this.connector === connector && this.connectionIsCurrent(record, generation),
      deps: this.deps,
      removing: this.removing,
      parked: this.parked,
      isVisible: () => this.visible.has(environmentId),
      publishStopped: (record) =>
        this.setStatus(record, { state: 'distro-stopped', terminals: 'exited', recovering: false }),
      publishReady: (record, connection) =>
        this.setStatus(record, { state: 'ready', census: null }, connection),
      retry: () => this.ensureForRuntimeCall(environmentId)
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

  /** A host whose Remove is pending is never woken, by focus or by a due automation. */
  private mayWake(record: WslHostDeploymentRecord): boolean {
    return (
      !record.pendingStop &&
      Boolean(this.connector) &&
      this.canRun() &&
      !this.removing.has(record.environmentId)
    )
  }

  /** A focus entry or a due automation: lifts a park and may boot the distro. */
  private wake(record: WslHostDeploymentRecord): Promise<void> {
    const connector = this.connector
    const generation = this.disableGeneration
    return wakeWslHost(
      record,
      connector,
      this.parked,
      () => this.connector === connector && this.connectionIsCurrent(record, generation)
    )
  }

  /** Whether the host's server answers through this process now; never starts a stopped distro. */
  async isConnected(environmentId: string): Promise<boolean> {
    const record = this.recordForEnvironment(environmentId)
    const connector = this.connector
    const generation = this.disableGeneration
    if (!record || !connector) return false
    const available = (await connector.reachability(record.distro, environmentId)) === 'available'
    return available && this.connector === connector && this.connectionIsCurrent(record, generation)
  }

  /** Re-saves the live connection's pairing and ports, which the deployment link overlays onto. */
  readonly resaveConnection = async (environmentId: string): Promise<void> => {
    const record = this.recordForEnvironment(environmentId)
    const connector = this.connector
    const generation = this.disableGeneration
    const connection = record && connector?.get(record.distro)
    if (!record || !connection) return
    const current = (): boolean =>
      this.connector === connector && this.connectionIsCurrent(record, generation)
    const saved = await persistWslHostConnection(this.deps.userDataPath(), record, connection, current)
    if (saved.ok && saved.pairingChanged && current()) this.deps.pairingChanged(environmentId)
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
    return id && !record.pendingStop
      ? this.canRun() && this.visible.has(id) && !this.removing.has(id)
      : false
  }

  /**
   * Startup: keep the holders a previous run left for its hosts, without booting anything. A
   * holder for a distro that is no longer a host (a failed add or remove), or any holder while
   * hosts are off, would keep its distro running forever, so it is released.
   */
  async start(): Promise<void> {
    if (!this.connector) {
      return
    }
    // An unfinished Remove shows as such from launch; nothing reconnects it.
    const pending = this.records().filter((record) => record.pendingStop)
    pending.forEach((record) => this.setStatus(record, { state: 'closed' }))
    await this.connector.adoptHolders(
      wslHolderKeepPolicy({
        userDataPath: this.deps.userDataPath(),
        keepHostHolders: this.canRun(),
        isAdding: (distro) => this.adding.has(wslDistroHolderKey(distro))
      })
    )
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
    this.board.set(toWslHostStatus(record, status, connection))
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
