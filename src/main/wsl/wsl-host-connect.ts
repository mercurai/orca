import type { WslHostDeploymentRecord } from '../../shared/wsl-host-deployment-store'
import type { WslHostConnectIntent } from '../../shared/wsl-host-types'
import type { WslHostConnector, WslHostServiceDependencies } from './wsl-host-connector-contract'
import { focusReachability } from './wsl-host-focus-reachability'
import { admitConnectToPendingHost } from './wsl-host-removal'
import {
  WSL_HOST_REMOVING_MESSAGE,
  wslHostRunRefusal,
  wslHostNotConnectedMessage,
  wslHostRemovalPendingMessage
} from './wsl-host-add-admission'

export type WslHostConnectOptions = {
  intent?: WslHostConnectIntent
  withdrawPendingRemoval?: boolean
}
type ConnectOwner = {
  connector: WslHostConnector | null
  userDataPath: () => string
  current: (record: WslHostDeploymentRecord) => boolean
  refusal: () => string | null
  parked: Set<string>
}

export function wslHostConnectRefusal(
  deps: WslHostServiceDependencies,
  removing: boolean,
  record?: WslHostDeploymentRecord | null
): string | null {
  return (
    wslHostRunRefusal(deps)?.message ??
    (removing
      ? WSL_HOST_REMOVING_MESSAGE
      : record?.pendingStop
        ? wslHostRemovalPendingMessage(record.distro)
        : null)
  )
}

/** Explicit Connect alone may withdraw a pending removal; recheck ownership after that write. */
export async function connectWslHost(
  record: WslHostDeploymentRecord | null,
  { withdrawPendingRemoval = false, ...options }: WslHostConnectOptions,
  owner: ConnectOwner
): Promise<void> {
  if (!record) {
    throw new Error('This server is not a WSL host.')
  }
  const refusal = owner.refusal()
  if (refusal) {
    throw new Error(refusal)
  }
  const connector = owner.connector
  if (!connector) {
    throw new Error('WSL hosts are not available on this computer.')
  }
  await admitConnectToPendingHost(owner.userDataPath(), record, withdrawPendingRemoval)
  const latestRefusal = owner.refusal()
  if (latestRefusal) {
    throw new Error(latestRefusal)
  }
  if (!owner.current(record)) {
    throw new Error(wslHostNotConnectedMessage(record.distro))
  }
  connector.forgetPairingFailures?.(record.environmentId)
  owner.parked.delete(record.environmentId)
  await connector.connect(record.distro, options)
}

/** Focus and due automation may boot, but a revoked reachability answer cannot. */
export async function wakeWslHost(
  record: WslHostDeploymentRecord,
  connector: WslHostConnector | null,
  parked: Set<string>,
  current: () => boolean
): Promise<void> {
  if (!connector) {
    return
  }
  parked.delete(record.environmentId)
  const reachability = await focusReachability(connector, record)
  if (!current()) {
    return
  }
  if (reachability !== 'available') {
    await connector.connect(record.distro)
  }
}
