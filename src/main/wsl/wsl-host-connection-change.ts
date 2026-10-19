import { errorMessage } from '../../shared/error-message'
import { addWslHostEnvironment, removeWslHostEnvironment } from '../../shared/runtime-environment-wsl-host-store'
import { wslHostEnvironmentLabel, type WslHostAddResult } from '../../shared/wsl-host-types'
import { WSL_HOSTS_DISABLED_MESSAGE } from './wsl-host-add-admission'
import type { WslHostDistroCandidate } from './wsl-host-distro-list'
import type { WslHostDeploymentRecord } from '../../shared/wsl-host-deployment-store'
import type { WslOrcadConnection } from './wsl-orcad-connection'
import type { WslOrcadConnectionStatus } from './wsl-orcad-connection-status'

type ChangeOwner = {
  record: (distro: string) => WslHostDeploymentRecord | null
  current: (record: WslHostDeploymentRecord, generation: number) => boolean
  generation: () => number
  persist: (record: WslHostDeploymentRecord, connection: WslOrcadConnection, current: () => boolean) =>
    Promise<{ ok: true; pairingChanged: boolean } | { ok: false }>
  pairingChanged: (environmentId: string) => void
  publish: (record: WslHostDeploymentRecord, status: WslOrcadConnectionStatus,
    connection: WslOrcadConnection | null) => void
}

/** An asynchronous ready event cannot outlive a newer event, removal or disable. */
export class WslHostConnectionChanges {
  private readonly revisions = new Map<string, number>()
  constructor(private readonly owner: ChangeOwner) {}

  async handle(distro: string, connection: WslOrcadConnection | null,
    status: WslOrcadConnectionStatus): Promise<void> {
    const record = this.owner.record(distro)
    if (!record) {
      return
    }
    const revision = (this.revisions.get(record.environmentId) ?? 0) + 1
    this.revisions.set(record.environmentId, revision)
    const generation = this.owner.generation()
    const current = (): boolean => this.revisions.get(record.environmentId) === revision &&
      this.owner.current(record, generation)
    if (!current()) {
      return
    }
    if (connection) {
      const saved = await this.owner.persist(record, connection, current)
      if (!saved.ok || !current()) {
        return
      }
      if (saved.pairingChanged) {
        this.owner.pairingChanged(record.environmentId)
      }
    }
    if (current()) {
      this.owner.publish(record, status, connection)
    }
  }
}


/** The connection is already open; no connector operation runs inside a profile transaction. */
export async function completeWslHostAdd(args: {
  userDataPath: string
  distro: WslHostDistroCandidate
  environmentId: string
  connection: WslOrcadConnection
  isCurrent: () => boolean
  abandon: () => Promise<void>
  publish: () => void
}): Promise<WslHostAddResult> {
  const { userDataPath, distro, environmentId, connection, isCurrent } = args
  const disabled = { ok: false, kind: 'disabled', message: WSL_HOSTS_DISABLED_MESSAGE } as const
  if (!isCurrent()) {
    await args.abandon()
    return disabled
  }
  const registeredAt = Date.now()
  try {
    await addWslHostEnvironment(userDataPath, {
      id: environmentId,
      name: wslHostEnvironmentLabel(distro.name),
      now: registeredAt,
      shouldPublish: isCurrent,
      pairingCode: connection.pairingOffer,
      record: {
        kind: 'wsl', distro: distro.name, distroId: distro.id,
        localPort: connection.localPort, remotePort: connection.remotePort
      }
    })
  } catch (error) {
    try {
      await removeWslHostEnvironment(userDataPath, environmentId, registeredAt)
    } finally {
      await args.abandon()
    }
    return !isCurrent() ? disabled : { ok: false, kind: 'failed', message: errorMessage(error) }
  }
  if (!isCurrent()) {
    try {
      await removeWslHostEnvironment(userDataPath, environmentId, registeredAt)
    } finally {
      await args.abandon()
    }
    return disabled
  }
  args.publish()
  return { ok: true, environmentId }
}
