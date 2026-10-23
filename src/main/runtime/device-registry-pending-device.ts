import type { DeviceScope } from '../../shared/runtime-types'
import type { RuntimePairingReach } from '../../shared/runtime-pairing-reach'
import { mintDeviceCredential } from './device-credential'
import { validGrants } from './device-registry-row-validation'
import {
  isPendingTokenRow,
  sameGrants,
  type DeviceEntry,
  type TokenDeviceEntry
} from './device-entry'
import type { RuntimeDeviceGrant } from './rpc/rpc-method-permission'

/** Builds a pending credential row; its caller must persist it before exposing the token. */
export function createPendingDeviceEntry(
  name: string,
  scope: DeviceScope,
  pairingReach: RuntimePairingReach,
  grants: readonly RuntimeDeviceGrant[]
): TokenDeviceEntry {
  const validatedGrants = validGrants(grants, scope)
  return {
    ...mintDeviceCredential(),
    name,
    scope,
    pairedAt: Date.now(),
    lastSeenAt: 0,
    pairingReach,
    ...(validatedGrants ? { grants: validatedGrants } : {})
  }
}

/** Pending grants must match exactly so re-advertising cannot widen authority. */
export function findPendingDeviceForGrants(
  devices: DeviceEntry[],
  scope: DeviceScope,
  grants: readonly RuntimeDeviceGrant[]
): TokenDeviceEntry | undefined {
  return devices.find(
    (device): device is TokenDeviceEntry =>
      isPendingTokenRow(device) &&
      device.scope === scope &&
      sameGrants(device, validGrants(grants, scope) ?? [])
  )
}

export function findPendingDevice(
  devices: DeviceEntry[],
  scope: DeviceScope
): TokenDeviceEntry | null {
  return (
    devices.find(
      (device): device is TokenDeviceEntry => isPendingTokenRow(device) && device.scope === scope
    ) ?? null
  )
}
