import type {
  DesktopMobileE2EEV2Context,
  DesktopMobileE2EEV2Session
} from './mobile-e2ee-v2-desktop-session'
import type { RpcBinarySender } from './rpc-binary-sender'
import type { E2EEChannel } from './e2ee-channel'
import type { DevicePrincipal } from '../device-principal'
import type { MobileE2EEOutboundMemoryBudget } from './mobile-e2ee-outbound-memory-budget'
import {
  authenticateMobileE2EE,
  describeMobileE2EEAuthFailure,
  type DeviceKeyResolution
} from './mobile-e2ee-auth-validation'

export type E2EEMessageHandler = (
  plaintext: string,
  encryptedReply: (response: string) => void,
  encryptedBinaryReply: RpcBinarySender
) => void

export type E2EEChannelOptions = {
  serverSecretKey: Uint8Array
  resolveAuthenticatedDevice: (token: string) => E2EEAuthenticatedDevice | null
  // Absent: key auth is refused as bad_auth, the same as before device keys existed.
  resolveAuthenticatedDeviceKey?: (deviceId: string) => DeviceKeyResolution<E2EEAuthenticatedDevice>
  /** Optional async admission before identity publication and the authentication acknowledgment. */
  beforeReady?: (channel: E2EEChannel, device: E2EEAuthenticatedDevice) => void | Promise<void>
  onReady: (channel: E2EEChannel, device: E2EEAuthenticatedDevice) => void
  onError: (code: number, reason: string) => void
  transportContext?: DesktopMobileE2EEV2Context
  requireV2?: boolean
  outboundMemoryBudget?: MobileE2EEOutboundMemoryBudget
}

export type E2EEAuthenticatedDevice = DevicePrincipal & {
  // Absent for a keyed row, which never presented a bearer.
  deviceToken?: string
}

/** Admission owns continuation ordering; the channel retains framing, identity and timeout state. */
export function admitMobileE2EEAuthentication(owner: {
  plaintext: string
  v2Session: DesktopMobileE2EEV2Session | null
  resolveDevice: (token: string) => E2EEAuthenticatedDevice | null
  resolveDeviceKey?: (deviceId: string) => DeviceKeyResolution<E2EEAuthenticatedDevice>
  begin: () => void
  isActive: () => boolean
  beforeReady: (device: E2EEAuthenticatedDevice) => void | Promise<void>
  complete: (device: E2EEAuthenticatedDevice, capabilities: unknown) => void
  reject: () => void
  invalid: (failure: ReturnType<typeof describeMobileE2EEAuthFailure>) => void
}): void {
  const authentication = authenticateMobileE2EE(owner)
  if (!authentication.ok) {
    owner.invalid(describeMobileE2EEAuthFailure(authentication))
    return
  }
  const authenticatedDevice = authentication.device
  owner.begin()
  const finish = (revalidate = false): void => {
    if (!owner.isActive()) {
      return
    }
    if (!revalidate) {
      owner.complete(authenticatedDevice, authentication.clientCapabilities)
      return
    }
    // Re-check the exact original token/key proof after an async write, including revocation.
    const current = authenticateMobileE2EE(owner)
    if (
      !current.ok ||
      current.device.deviceId !== authenticatedDevice.deviceId ||
      current.device.credentialRevision !== authenticatedDevice.credentialRevision ||
      current.device.callerFingerprint !== authenticatedDevice.callerFingerprint
    ) {
      owner.reject()
      return
    }
    owner.complete(current.device, authentication.clientCapabilities)
  }
  try {
    const admission = owner.beforeReady(authenticatedDevice)
    if (admission) {
      void admission.then(() => finish(true)).catch(() => owner.reject())
    } else {
      finish()
    }
  } catch {
    owner.reject()
  }
}
