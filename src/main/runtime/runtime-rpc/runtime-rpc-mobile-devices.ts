import type {
  RelayDeviceBinding,
  RelayRevokeOutboxItem
} from '../mobile-cloud-relay/relay-revoke-outbox'
import type {
  DelegatedPhone,
  DelegatedMobileDeviceSyncResult
} from '../../../shared/delegated-mobile-device-contract'
import { RuntimeRpcRequestAdmission } from './runtime-rpc-request-admission'

// Why: below dispatch so a caller-bound RPC context can revoke and mint mobile devices.
export class RuntimeRpcMobileDevices extends RuntimeRpcRequestAdmission {
  private onPushUnregisterQueued?: () => void

  async revokeMobileDevice(deviceId: string): Promise<boolean> {
    const revoked = await this.revokeMobileDeviceNow(deviceId)
    if (revoked) {
      this.mobileDesktopRelay?.phonesChanged()
    }
    return revoked
  }

  private async revokeMobileDeviceNow(deviceId: string): Promise<boolean> {
    const registry = this.deviceRegistry
    const device = registry?.getDevice(deviceId)
    if (!registry || device?.scope !== 'mobile') {
      return false
    }
    // Why: the outbox writes below are awaited before the row is removed; the phone must be
    // refused from the start of the revoke, not only once removeDevice runs.
    const release = registry.beginRevocation(deviceId)
    try {
      if (device.relayBinding && !(await this.queueRelayDeviceRevoke(device.relayBinding))) {
        return false
      }
      // Why: unpairing must delete the phone's push token at the gateway too, and the
      // registration id is only readable while the device row still exists.
      await this.queuePushUnregister(deviceId, device.pushRegistration?.registrationId)
      if (!(await registry.removeDevice(deviceId))) {
        return false
      }
    } finally {
      release()
    }
    this.mobileRelayPairingProvider?.onDemandStateChanged?.()
    this.runtime.forgetClientNavigationState(deviceId)
    this.mobileSocketWiring?.terminateDeviceConnections(deviceId)
    return true
  }

  /** A child another revoke already removed is revoked; a failed removal leaves the row and is not. */
  private async revokeDelegatedChild(deviceId: string): Promise<boolean> {
    return (await this.revokeMobileDeviceNow(deviceId)) || !this.deviceRegistry?.getDevice(deviceId)
  }

  async revokeRuntimeAccess(deviceId: string): Promise<boolean> {
    const registry = this.deviceRegistry
    if (!registry || registry.getDevice(deviceId)?.scope !== 'runtime') {
      return false
    }
    // Why: refuses the runtime device, and stops a delegated sync from minting children under it,
    // for the whole cleanup.
    const release = registry.beginRevocation(deviceId)
    try {
      let children = registry.listDelegatedMobileDevices(deviceId)
      while (children.length > 0) {
        for (const child of children) {
          // Why: keep the parent until every child's cleanup is saved, so a retry can still find them.
          if (!(await this.revokeDelegatedChild(child.deviceId))) {
            return false
          }
        }
        // Why: a sync write already in flight when the revoke began may have added children.
        children = registry.listDelegatedMobileDevices(deviceId)
      }
      if (!(await registry.removeDevice(deviceId))) {
        return false
      }
    } finally {
      release()
    }
    this.runtime.forgetClientNavigationState(deviceId)
    this.mobileSocketWiring?.terminateDeviceConnections(deviceId)
    return true
  }

  /** Make the runtime device `parentDeviceId`'s phones exactly `phones`; dropped ones are fully revoked. */
  protected async syncDelegatedMobileDevices(
    parentDeviceId: string,
    phones: readonly DelegatedPhone[]
  ): Promise<DelegatedMobileDeviceSyncResult> {
    const registry = this.deviceRegistry
    const parent = registry?.getDevice(parentDeviceId)
    if (!registry || parent?.scope !== 'runtime') {
      throw new Error('delegated_device_parent_unavailable')
    }
    const wanted = new Set(phones.map((phone) => phone.phoneKey))
    for (const child of registry.listDelegatedMobileDevices(parentDeviceId)) {
      if (
        (!child.phoneKey || !wanted.has(child.phoneKey)) &&
        !(await this.revokeDelegatedChild(child.deviceId))
      ) {
        throw new Error('delegated_device_revoke_failed')
      }
    }
    const entries = await registry.upsertDelegatedMobileDevices(parent, phones)
    return {
      devices: entries.map((device) => ({
        phoneKey: device.phoneKey,
        deviceId: device.deviceId,
        token: device.token
      }))
    }
  }

  /** Best-effort: a failed enqueue must never block the revoke the user asked for. */
  protected async queuePushUnregister(
    deviceId: string,
    registrationId: string | undefined
  ): Promise<void> {
    if (!registrationId) {
      return
    }
    try {
      await this.pushUnregisterOutbox.enqueue({ registrationId, deviceId })
      this.onPushUnregisterQueued?.()
    } catch (error) {
      console.error('[runtime] Failed to persist a push token cleanup:', error)
    }
  }

  setOnPushUnregisterQueued(callback: (() => void) | null): void {
    this.onPushUnregisterQueued = callback ?? undefined
  }

  protected async queueRelayDeviceRevoke(binding: RelayDeviceBinding): Promise<boolean> {
    let item: RelayRevokeOutboxItem
    try {
      item = await this.relayRevokeOutbox.enqueue(binding)
    } catch (error) {
      console.error('[runtime] Failed to persist Relay device cleanup:', error)
      return false
    }
    try {
      this.mobileRelayPairingProvider?.onDeviceRevokeQueued(item)
    } catch (error) {
      console.warn('[runtime] Failed to notify Relay cleanup worker:', error)
    }
    return true
  }
}
