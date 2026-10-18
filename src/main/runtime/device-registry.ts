// Why: per-device tokens replace the shared runtime auth token for WebSocket
// (mobile) connections. Each paired device gets its own revocable token so
// compromising one device doesn't expose others. The registry is a simple
// JSON file with hardened permissions matching the runtime metadata pattern.
import { join } from 'node:path'
import { serializePathWrite } from '../../shared/path-write-serializer'
import {
  writeDurableSecureJsonFileAsync,
  writeSecureJsonFileAsync
} from '../../shared/secure-file-async-write'
import type { DeviceScope } from '../../shared/runtime-types'
import { removeStaleDurableWriteTempFiles } from '../durable-file-write'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'
import { mintDeviceCredential } from './device-credential'
import { DeviceKeyForkError, planDeviceKeyFork } from './device-key-fork'
import { planIdleEphemeralPrune, withoutEphemeralRows } from './ephemeral-device-rows'
import { quarantineCorruptRegistry } from './device-registry-corruption'
import { readDeviceRegistryFile } from './device-registry-file-read'
import { DeviceRevocationMarks } from './device-revocation-marks'
import type { RelayDeviceBinding } from './mobile-cloud-relay/relay-revoke-outbox'
import type { MobilePairingConnectionMode } from '../../shared/mobile-pairing-connection-mode'
import type { RuntimePairingReach } from '../../shared/runtime-pairing-reach'
import type { DelegatedPhone } from '../../shared/delegated-mobile-device-contract'
import {
  planDelegatedMobileDevices,
  type DelegatedMobileDeviceEntry
} from './delegated-mobile-devices'
import type { RuntimeDeviceGrant } from './rpc/rpc-method-permission'
import { validGrants } from './device-registry-row-validation'
import {
  isPendingTokenRow,
  mobilePairingConnectionModeOf,
  isStillAuthenticated,
  type AuthenticatedPrincipalBinding,
  lookupDeviceKeyRow,
  sameGrants,
  type DeviceEntry,
  type DeviceKeyLookup,
  type TokenDeviceEntry
} from './device-entry'
import type { MobilePushRegistration } from '../../shared/mobile-push-contract'

export type { DeviceScope }

export type { DeviceEntry, DeviceKeyLookup, TokenDeviceEntry }

// Why: a lastSeen refresh is pure bookkeeping, so coalesce reconnect bursts into one write instead of
// paying a secure-file rewrite (an ACL pass on Windows) per connection.
const LAST_SEEN_FLUSH_DELAY_MS = 250
const STALE_WRITE_TEMP_AGE_MS = 24 * 60 * 60 * 1000

export class DeviceRegistry {
  private readonly registryPath: string
  private devices: DeviceEntry[] = []
  private readonly revocations = new DeviceRevocationMarks()
  /** Set when the registry exists but could not be read, which makes `devices` a lie to save from. */
  private registryUnreadable = false
  /** A parse failure, now or in an earlier run, means an unlisted device may still exist. */
  private registryDoubtful = false
  private corruptFilePending = false
  private pendingLastSeenFlush: NodeJS.Timeout | null = null
  /** Bumped by every deferred lastSeen refresh, so a write in flight can tell it missed one. */
  private lastSeenRevision = 0

  constructor(userDataPath: string) {
    this.registryPath = join(userDataPath, DEVICE_REGISTRY_FILENAME)
    // Why: a write killed between writeFile and rename (e.g. a crash mid-write, #20497) orphans its temp forever.
    void removeStaleDurableWriteTempFiles(this.registryPath, {
      minimumAgeMs: STALE_WRITE_TEMP_AGE_MS
    })
    this.load()
  }

  // Why: every mutation reads this.devices, awaits the write, then swaps it in, so two of them must not interleave.
  private serialized<T>(task: () => Promise<T>): Promise<T> {
    return serializePathWrite(`${this.registryPath}#read-modify-write`, task)
  }

  addDevice(
    name: string,
    scope: DeviceScope = 'mobile',
    pairingReach: RuntimePairingReach = 'network',
    grants: readonly RuntimeDeviceGrant[] = []
  ): Promise<TokenDeviceEntry> {
    return this.serialized(() =>
      this.createAndPersistDevice(this.devices, name, scope, pairingReach, grants)
    )
  }

  private async createAndPersistDevice(
    existingDevices: DeviceEntry[],
    name: string,
    scope: DeviceScope,
    pairingReach: RuntimePairingReach,
    grants: readonly RuntimeDeviceGrant[]
  ): Promise<TokenDeviceEntry> {
    const validatedGrants = validGrants(grants, scope)
    const entry: TokenDeviceEntry = {
      ...mintDeviceCredential(),
      name,
      scope,
      pairedAt: Date.now(),
      lastSeenAt: 0,
      pairingReach,
      ...(validatedGrants ? { grants: validatedGrants } : {})
    }
    const nextDevices = [...existingDevices, entry]
    // Why: a credential is not valid until its durable registry write succeeds.
    await this.commit(nextDevices)
    return entry
  }

  // Why: coalesce repeated QR-regenerate clicks onto a single pending token.
  // Each call to addDevice() produces a valid auth credential; without
  // coalescing, every renderer call to mobile:getPairingQR (e.g. the new
  // copy-button flow that encourages regeneration) leaves an orphaned token
  // forever. Returns an existing never-scanned entry if present; otherwise
  // mints a new one and drops any stale pending entries.
  getOrCreatePendingDevice(
    name: string,
    scope: DeviceScope = 'mobile',
    pairingReach: RuntimePairingReach = 'network',
    grants: readonly RuntimeDeviceGrant[] = []
  ): Promise<TokenDeviceEntry> {
    return this.serialized(async () => {
      // Why: a pending token is reused only for the same grants, so re-advertising never widens one.
      const existing = this.devices.find(
        (d): d is TokenDeviceEntry =>
          isPendingTokenRow(d) &&
          d.scope === scope &&
          sameGrants(d, validGrants(grants, scope) ?? [])
      )
      if (!existing) {
        return await this.createAndPersistDevice(this.devices, name, scope, pairingReach, grants)
      }
      // Why: the same pending token can be re-advertised at a broader reach; widen it but never narrow it,
      // or a link already handed out for off-host use would stop being served after the next launch.
      return pairingReach === 'network' && existing.pairingReach === 'this-computer'
        ? await this.setPairingReach(existing, 'network')
        : existing
    })
  }

  private async setPairingReach(
    existing: TokenDeviceEntry,
    pairingReach: RuntimePairingReach
  ): Promise<TokenDeviceEntry> {
    const updated: TokenDeviceEntry = { ...existing, pairingReach }
    const nextDevices = this.devices.map((device) =>
      device.deviceId === existing.deviceId ? updated : device
    )
    // Why: persist before the memory swap so a failed write cannot leave the bind decision reading a
    // reach that never reached disk.
    await this.commit(nextDevices)
    return updated
  }

  // Why: explicit rotation path for "Regenerate QR" — invalidates any
  // existing never-scanned token (e.g. one that was screenshotted, copied
  // to clipboard, or shown on a screen-share) and mints a fresh one. Without
  // this, getOrCreatePendingDevice keeps returning the same token forever
  // until a phone actually pairs, so users have no way to revoke a leaked
  // pre-pairing token.
  rotatePendingDevice(
    name: string,
    scope: DeviceScope = 'mobile',
    pairingReach: RuntimePairingReach = 'network',
    grants: readonly RuntimeDeviceGrant[] = []
  ): Promise<TokenDeviceEntry> {
    return this.serialized(() => {
      // Why: a pending runtime device has no delegated children — its first auth sets lastSeenAt before any sync.
      const retainedDevices = this.devices.filter((d) => !isPendingTokenRow(d) || d.scope !== scope)
      return this.createAndPersistDevice(retainedDevices, name, scope, pairingReach, grants)
    })
  }

  listDelegatedMobileDevices(parentDeviceId: string): DeviceEntry[] {
    return this.devices.filter((device) => device.parentDeviceId === parentDeviceId)
  }

  /** Create-or-return one mobile child per phoneKey under `parent`, in `phones` order. */
  upsertDelegatedMobileDevices(
    parent: DeviceEntry,
    phones: readonly DelegatedPhone[]
  ): Promise<DelegatedMobileDeviceEntry[]> {
    return this.serialized(async () => {
      // Why: the parent may have been revoked while this waited; never mint children under it then.
      if (this.revocations.has(parent.deviceId) || !this.getDevice(parent.deviceId)) {
        throw new Error('delegated_device_parent_unavailable')
      }
      const { nextDevices, entries } = planDelegatedMobileDevices(this.devices, parent, phones)
      if (nextDevices !== this.devices) {
        await this.commit(nextDevices)
      }
      return entries
    })
  }

  /** Refuses the device's token until the returned release runs. */
  beginRevocation(deviceId: string): () => void {
    return this.revocations.begin(deviceId)
  }

  removeDevice(deviceId: string): Promise<boolean> {
    // Synchronous, before the queue: requests already in flight must not outlive the revoke.
    const release = this.beginRevocation(deviceId)
    return this.serialized(async () => {
      const nextDevices = this.devices.filter((d) => d.deviceId !== deviceId)
      if (nextDevices.length === this.devices.length) {
        return false
      }
      // Why: persist before memory swap so a failed write does not drop a device
      // only in-process while disk still lists it (and vice versa on reload).
      await this.commit(nextDevices)
      return true
    }).finally(release)
  }

  getDevice(deviceId: string): DeviceEntry | null {
    return this.devices.find((d) => d.deviceId === deviceId) ?? null
  }

  getPendingDevice(scope: DeviceScope = 'mobile'): TokenDeviceEntry | null {
    return (
      this.devices.find(
        (device): device is TokenDeviceEntry => isPendingTokenRow(device) && device.scope === scope
      ) ?? null
    )
  }

  setRelayBinding(deviceId: string, binding: RelayDeviceBinding): Promise<boolean> {
    if (binding.relayDeviceId !== deviceId) {
      return Promise.resolve(false)
    }
    return this.replaceRow(deviceId, (device) => ({ ...device, relayBinding: binding }))
  }

  /** Passing null clears the registration (unregister, or a token the gateway reported dead). */
  setPushRegistration(
    deviceId: string,
    registration: MobilePushRegistration | null
  ): Promise<boolean> {
    // Why: persist before the memory swap so a failed write cannot leave the dispatcher
    // pushing to a registration disk says is gone (or vice versa on reload).
    return this.replaceRow(
      deviceId,
      (device) => {
        const { pushRegistration: _dropped, ...rest } = device
        return registration ? { ...rest, pushRegistration: registration } : rest
      },
      (device) => device.scope === 'mobile'
    )
  }

  setMobilePairingConnectionMode(
    deviceId: string,
    mode: MobilePairingConnectionMode
  ): Promise<boolean> {
    // Why: persist before swapping memory so a failed write does not leave a
    // mode the UI/runtime believe was stored.
    return this.replaceRow(
      deviceId,
      (device) => ({ ...device, mobilePairingConnectionMode: mode }),
      (device) => device.scope === 'mobile'
    )
  }

  getMobilePairingConnectionMode(deviceId: string): MobilePairingConnectionMode | null {
    return mobilePairingConnectionModeOf(this.getDevice(deviceId))
  }

  listDevices(): readonly DeviceEntry[] {
    return this.devices
  }

  validateToken(token: string): DeviceEntry | null {
    if (!token) {
      return null
    }
    const device = this.devices.find((d) => d.credentialKind === undefined && d.token === token)
    return device && !this.revocations.has(device.deviceId) ? device : null
  }

  // Why: "unknown" must mean "readable and absent" — clients delete their key only on that verdict.
  lookupDeviceKey(deviceId: string): DeviceKeyLookup {
    // Why: a revoke in flight may still fail and roll back, so the row is neither found nor absent.
    if (this.revocations.has(deviceId)) {
      return { kind: 'unavailable' }
    }
    const lookup = lookupDeviceKeyRow(this.getDevice(deviceId))
    return lookup.kind === 'unknown' && (this.registryUnreadable || this.registryDoubtful)
      ? { kind: 'unavailable' }
      : lookup
  }

  /** Forks `legacyDeviceId` into a keyed row; durable before it resolves (security transition). */
  forkDeviceKey(
    legacyDeviceId: string,
    devicePublicKeyB64: string,
    label: string,
    options: { ephemeral?: boolean } = {}
  ): Promise<DeviceEntry> {
    return this.serialized(async () => {
      // Why: a fork outlives its token row's removal, so none may start once that revoke has begun.
      if (this.revocations.has(legacyDeviceId)) {
        throw new DeviceKeyForkError('device_not_found')
      }
      const fork = planDeviceKeyFork(
        this.devices,
        legacyDeviceId,
        devicePublicKeyB64,
        label,
        Date.now(),
        options
      )
      if (fork.created) {
        await this.commit(fork.nextDevices, { durable: true })
      }
      return fork.entry
    })
  }

  /** Drops idle session-only rows; durable, since a removed row is a revocation. */
  pruneIdleEphemeralDevices(now: number, isLive: (deviceId: string) => boolean): Promise<string[]> {
    return this.serialized(async () => {
      const plan = planIdleEphemeralPrune(this.devices, now, isLive)
      if (plan.removed.length > 0) {
        await this.commit(plan.nextDevices, { durable: true })
      }
      return plan.removed
    })
  }

  /** The row an authenticated socket is still entitled to, or null once revoked or re-credentialed. */
  resolveAuthenticatedPrincipal(principal: AuthenticatedPrincipalBinding): DeviceEntry | null {
    if (this.revocations.has(principal.deviceId)) {
      return null
    }
    const device = this.getDevice(principal.deviceId)
    return device && isStillAuthenticated(device, principal) ? device : null
  }

  updateLastSeen(deviceId: string): Promise<void> {
    return this.serialized(async () => {
      const index = this.devices.findIndex((d) => d.deviceId === deviceId)
      if (index === -1) {
        return
      }
      // Why: persist before memory swap so a failed write cannot leave a scanned
      // device looking never-scanned on disk, where rotation would drop it.
      const seenAt = Date.now()
      const nextDevices = this.devices.map((device, candidateIndex) =>
        candidateIndex === index ? { ...device, lastSeenAt: seenAt } : device
      )
      await this.commit(nextDevices)
    })
  }

  /**
   * Marks a device seen without blocking the caller on disk — the E2EE auth handshake runs this and
   * must not wait on a secure-file rewrite.
   * The first-ever sighting still persists: rotatePendingDevice drops entries that disk says were
   * never scanned, so only that 0 -> non-zero transition is load-bearing.
   */
  updateLastSeenDeferred(deviceId: string): void {
    const existing = this.getDevice(deviceId)
    if (!existing) {
      return
    }
    if (existing.lastSeenAt === 0) {
      void this.updateLastSeen(deviceId).catch((error) => {
        console.warn('[mobile] Failed to persist first device sighting:', error)
      })
      return
    }
    const seenAt = Date.now()
    this.lastSeenRevision += 1
    this.devices = this.devices.map((device) =>
      device.deviceId === deviceId ? { ...device, lastSeenAt: seenAt } : device
    )
    if (this.pendingLastSeenFlush) {
      return
    }
    this.pendingLastSeenFlush = setTimeout(
      () => void this.flushPendingLastSeen(),
      LAST_SEEN_FLUSH_DELAY_MS
    )
    // Why: bookkeeping must never hold the process open.
    this.pendingLastSeenFlush.unref?.()
  }

  /** Persists a deferred lastSeen refresh now; no-op when nothing is pending. */
  async flushPendingLastSeen(): Promise<void> {
    if (!this.pendingLastSeenFlush) {
      return
    }
    this.cancelPendingLastSeenFlush()
    // Why: a failed bookkeeping write must not take down the runtime.
    await this.persistOrLog('persist device lastSeen')
  }

  private async persistOrLog(action: string, options: { durable?: boolean } = {}): Promise<void> {
    try {
      await this.serialized(() => this.commit(this.devices, options))
    } catch (error) {
      console.error(`[runtime] Failed to ${action}:`, error)
    }
  }

  private cancelPendingLastSeenFlush(): void {
    if (this.pendingLastSeenFlush) {
      clearTimeout(this.pendingLastSeenFlush)
      this.pendingLastSeenFlush = null
    }
  }

  private load(): void {
    const read = readDeviceRegistryFile(this.registryPath)
    this.registryUnreadable = read.unreadable
    this.registryDoubtful = read.doubtful
    this.corruptFilePending = read.corruptFilePending
    this.devices = withoutEphemeralRows(read.devices)
    // Why: a session-only browser's key died with the last host process; its row must not outlive it.
    if (this.devices.length !== read.devices.length) {
      void this.persistOrLog('drop session-only devices after restart', { durable: true })
    }
  }

  // Why: persist before the memory swap so a failed write never leaves memory claiming what disk lacks.
  private replaceRow(
    deviceId: string,
    update: (device: DeviceEntry) => DeviceEntry,
    accepts: (device: DeviceEntry) => boolean = () => true
  ): Promise<boolean> {
    return this.serialized(async () => {
      const current = this.devices.find((candidate) => candidate.deviceId === deviceId)
      if (!current || !accepts(current)) {
        return false
      }
      const nextDevices = this.devices.map((device) =>
        device === current ? update(device) : device
      )
      await this.commit(nextDevices)
      return true
    })
  }

  private assertReadable(): void {
    if (this.registryUnreadable) {
      throw new Error(
        `Cannot read the device registry at ${this.registryPath}: the read failed. Refusing to overwrite it, which would revoke every paired device.`
      )
    }
    if (this.corruptFilePending) {
      quarantineCorruptRegistry(this.registryPath)
      this.corruptFilePending = false
    }
  }

  /** Persists `devices`, then makes them the in-memory list. Durable (fsync'd) for security transitions. */
  private async commit(
    devices: DeviceEntry[],
    options: { durable?: boolean } = {}
  ): Promise<void> {
    this.assertReadable()
    const revision = this.lastSeenRevision
    const write = options.durable ? writeDurableSecureJsonFileAsync : writeSecureJsonFileAsync
    await write(this.registryPath, devices)
    if (revision === this.lastSeenRevision) {
      this.devices = devices
      // Why: this write included the latest in-memory timestamps, so a pending timer would only rewrite it.
      this.cancelPendingLastSeenFlush()
      return
    }
    // Why: a deferred refresh landed during the write; keep its newer timestamps and its pending timer.
    const seen = new Map(this.devices.map((device) => [device.deviceId, device.lastSeenAt]))
    this.devices = devices.map((device) => ({
      ...device,
      lastSeenAt: Math.max(device.lastSeenAt, seen.get(device.deviceId) ?? 0)
    }))
  }
}
