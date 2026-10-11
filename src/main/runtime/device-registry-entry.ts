import type { DeviceScope } from '../../shared/runtime-types'
import type { RelayDeviceBinding } from './relay/relay-revoke-outbox'
import { validRelayBinding } from './device-registry-relay-binding'
import type { MobilePairingConnectionMode } from '../../shared/mobile-pairing-connection-mode'
import type { RuntimePairingReach } from '../../shared/runtime-pairing-reach'
import { RUNTIME_DEVICE_GRANTS, type RuntimeDeviceGrant } from './rpc/rpc-method-permission'
import {
  parseMobilePushRegistration,
  type MobilePushRegistration
} from '../../shared/mobile-push-contract'

export type DeviceEntry = {
  deviceId: string
  name: string
  token: string
  scope: DeviceScope
  pairedAt: number
  lastSeenAt: number
  relayBinding?: RelayDeviceBinding
  mobilePairingConnectionMode?: MobilePairingConnectionMode
  // Why: STA-2370 — a grant minted for "This computer only" proves nothing about off-host reach when its
  // client connects, so the bind decision must be able to tell it apart from a LAN/phone grant.
  pairingReach?: RuntimePairingReach
  // Why: survives a desktop restart so the host can keep pushing without the phone
  // re-registering. Absent on every registry written before background push existed.
  pushRegistration?: MobilePushRegistration
  // Why: administrative permissions are granted only when pairing; absent on older rows means none.
  grants?: RuntimeDeviceGrant[]
}

const GRANTABLE: ReadonlySet<string> = new Set(RUNTIME_DEVICE_GRANTS)

function isRuntimeDeviceGrant(value: unknown): value is RuntimeDeviceGrant {
  return typeof value === 'string' && GRANTABLE.has(value)
}

export function validGrants(value: unknown, scope: DeviceScope): RuntimeDeviceGrant[] | undefined {
  if (scope !== 'runtime' || !Array.isArray(value)) {
    return undefined
  }
  const grants = [...new Set(value.filter(isRuntimeDeviceGrant))].sort()
  return grants.length > 0 ? grants : undefined
}

export function sameGrants(entry: DeviceEntry, grants: readonly RuntimeDeviceGrant[]): boolean {
  const current = entry.grants ?? []
  return current.length === grants.length && current.every((grant) => grants.includes(grant))
}

/** One registry row as loaded: unknown or malformed fields degrade, never fail the load. */
export function normalizeDeviceEntry(device: DeviceEntry): DeviceEntry {
  return {
    ...device,
    // Why: older registries only existed for phone pairing. Treat missing
    // scope as mobile so legacy device tokens do not gain new CLI powers.
    scope: device.scope === 'runtime' ? 'runtime' : 'mobile',
    grants: validGrants(device.grants, device.scope === 'runtime' ? 'runtime' : 'mobile'),
    relayBinding: validRelayBinding(device.relayBinding, device.deviceId),
    mobilePairingConnectionMode:
      device.mobilePairingConnectionMode === 'local-only' ? 'local-only' : 'automatic',
    // Why: registries written before this field existed only ever held network-reach grants (phones and
    // LAN links), so a missing value must keep binding every interface on reconnect.
    pairingReach: device.pairingReach === 'this-computer' ? 'this-computer' : 'network',
    // Why: a malformed row must degrade to "no background push", never fail the load
    // and strand every paired device.
    pushRegistration: parseMobilePushRegistration(device.pushRegistration)
  }
}
