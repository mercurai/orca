import type { WslHostDeploymentRecord } from '../../shared/wsl-host-deployment-store'
import { rethrowRetryable, settlingConnectFailure } from './wsl-host-connect-failure'
import { wslHostNotConnectedMessage, wslHostStoppedMessage } from './wsl-host-add-admission'
import type { WslHostConnector } from './wsl-host-connector-contract'

type RuntimeReconnectOwner = {
  connector: WslHostConnector | null
  current: (record: WslHostDeploymentRecord) => boolean
  refusal: () => string | null
  visible: () => boolean
  parked: Set<string>
}

/** A passive runtime request may reconnect only its still-current, confirmed-running host. */
export async function reconnectWslHostForRuntimeCall(
  record: WslHostDeploymentRecord | null,
  owner: RuntimeReconnectOwner
): Promise<void> {
  const { connector } = owner
  if (!record || !connector) {
    return
  }
  const reachability = await connector.reachability(record.distro, record.environmentId)
  const refusal = owner.refusal()
  if (refusal) {
    throw new Error(refusal)
  }
  if (!owner.current(record)) {
    throw new Error(wslHostNotConnectedMessage(record.distro))
  }
  if (reachability === 'available') {
    return
  }
  if (reachability === 'stopped') {
    owner.parked.add(record.environmentId)
  }
  if (owner.parked.has(record.environmentId)) {
    throw new Error(wslHostStoppedMessage(record.distro))
  }
  if (reachability !== 'unreachable' || !owner.visible()) {
    throw new Error(wslHostNotConnectedMessage(record.distro))
  }
  if (connector.isSettling(record.distro)) {
    throw settlingConnectFailure(record.distro)
  }
  await connector.connect(record.distro, { noBoot: true }).catch(rethrowRetryable(record.distro))
}
