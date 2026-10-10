// Why: per-device tokens replace the shared runtime auth token for WebSocket
// (mobile) connections. Each paired device gets its own revocable token so
// compromising one device doesn't expose others. The registry is a simple
// JSON file with hardened permissions matching the runtime metadata pattern.
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serializePathWrite } from '../../shared/path-write-serializer'
import { hardenExistingSecureFile, isUnreadableError } from '../../shared/secure-file'
import { writeSecureJsonFileAsync } from '../../shared/secure-file-async-write'
import type { DeviceScope } from '../../shared/runtime-types'
import { removeStaleDurableWriteTempFiles } from '../durable-file-write'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'
import type { RelayDeviceBinding } from './relay/relay-revoke-outbox'
import { validRelayBinding } from './device-registry-relay-binding'
import type { MobilePairingConnectionMode } from '../../shared/mobile-pairing-connection-mode'
import type { RuntimePairingReach } from '../../shared/runtime-pairing-reach'
import {
  parseMobilePushRegistration,
  type MobilePushRegistration
} from '../../shared/mobile-push-contract'

export type { DeviceScope }

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
}

// Why: a lastSeen refresh is pure bookkeeping, so coalesce reconnect bursts into one write instead of
// paying a secure-file rewrite (two synchronous PowerShell ACL spawns on Windows) per connection.
const LAST_SEEN_FLUSH_DELAY_MS = 250
const STALE_WRITE_TEMP_AGE_MS = 24 * 60 * 60 * 1000

export class DeviceRegistry {
  private readonly registryPath: string
  private devices: DeviceEntry[] = []
  /** Set when the registry exists but could not be read, which makes `devices` a lie to save from. */
  private registryUnreadable = false
  private pendingLastSeenFlush: NodeJS.Timeout | null = null
  /** Bumped by every deferred lastSeen refresh, so a write in flight can tell it missed one. */
  private lastSeenRevision = 0

  constructor(userDataPath: string) {
    this.registryPath = join(userDataPath, DEVICE_REGISTRY_FILENAME)
    // Why: a write killed between writeFile and rename (e.g. a hung icacls, #20497) orphans its temp forever.
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
    pairingReach: RuntimePairingReach = 'network'
  ): Promise<DeviceEntry> {
    return this.serialized(() =>
      this.createAndPersistDevice(this.devices, name, scope, pairingReach)
    )
  }

  private async createAndPersistDevice(
    existingDevices: DeviceEntry[],
    name: string,
    scope: DeviceScope,
    pairingReach: RuntimePairingReach
  ): Promise<DeviceEntry> {
    const entry: DeviceEntry = {
      deviceId: randomUUID(),
      name,
      token: randomBytes(24).toString('hex'),
      scope,
      pairedAt: Date.now(),
      lastSeenAt: 0,
      pairingReach
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
    pairingReach: RuntimePairingReach = 'network'
  ): Promise<DeviceEntry> {
    return this.serialized(async () => {
      const existing = this.devices.find((d) => d.lastSeenAt === 0 && d.scope === scope)
      if (!existing) {
        return await this.createAndPersistDevice(this.devices, name, scope, pairingReach)
      }
      // Why: the same pending token can be re-advertised at a broader reach; widen it but never narrow it,
      // or a link already handed out for off-host use would stop being served after the next launch.
      return pairingReach === 'network' && existing.pairingReach === 'this-computer'
        ? await this.setPairingReach(existing, 'network')
        : existing
    })
  }

  private async setPairingReach(
    existing: DeviceEntry,
    pairingReach: RuntimePairingReach
  ): Promise<DeviceEntry> {
    const updated: DeviceEntry = { ...existing, pairingReach }
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
    pairingReach: RuntimePairingReach = 'network'
  ): Promise<DeviceEntry> {
    return this.serialized(() => {
      const retainedDevices = this.devices.filter((d) => d.lastSeenAt !== 0 || d.scope !== scope)
      return this.createAndPersistDevice(retainedDevices, name, scope, pairingReach)
    })
  }

  removeDevice(deviceId: string): Promise<boolean> {
    return this.serialized(async () => {
      const nextDevices = this.devices.filter((d) => d.deviceId !== deviceId)
      if (nextDevices.length === this.devices.length) {
        return false
      }
      // Why: persist before memory swap so a failed write does not drop a device
      // only in-process while disk still lists it (and vice versa on reload).
      await this.commit(nextDevices)
      return true
    })
  }

  getDevice(deviceId: string): DeviceEntry | null {
    return this.devices.find((d) => d.deviceId === deviceId) ?? null
  }

  getPendingDevice(scope: DeviceScope = 'mobile'): DeviceEntry | null {
    return this.devices.find((device) => device.lastSeenAt === 0 && device.scope === scope) ?? null
  }

  setRelayBinding(deviceId: string, binding: RelayDeviceBinding): Promise<boolean> {
    return this.serialized(async () => {
      const index = this.devices.findIndex((candidate) => candidate.deviceId === deviceId)
      if (index === -1 || binding.relayDeviceId !== deviceId) {
        return false
      }
      const nextDevices = this.devices.map((device, candidateIndex) =>
        candidateIndex === index ? { ...device, relayBinding: binding } : device
      )
      await this.commit(nextDevices)
      return true
    })
  }

  /** Passing null clears the registration (unregister, or a token the gateway reported dead). */
  setPushRegistration(
    deviceId: string,
    registration: MobilePushRegistration | null
  ): Promise<boolean> {
    return this.serialized(async () => {
      const index = this.devices.findIndex((candidate) => candidate.deviceId === deviceId)
      if (index === -1 || this.devices[index]?.scope !== 'mobile') {
        return false
      }
      const nextDevices = this.devices.map((device, candidateIndex) => {
        if (candidateIndex !== index) {
          return device
        }
        const { pushRegistration: _dropped, ...rest } = device
        return registration ? { ...rest, pushRegistration: registration } : rest
      })
      // Why: persist before the memory swap so a failed write cannot leave the dispatcher
      // pushing to a registration disk says is gone (or vice versa on reload).
      await this.commit(nextDevices)
      return true
    })
  }

  setMobilePairingConnectionMode(
    deviceId: string,
    mode: MobilePairingConnectionMode
  ): Promise<boolean> {
    return this.serialized(async () => {
      const index = this.devices.findIndex((candidate) => candidate.deviceId === deviceId)
      if (index === -1 || this.devices[index]?.scope !== 'mobile') {
        return false
      }
      // Why: persist before swapping memory so a failed write does not leave a
      // mode the UI/runtime believe was stored.
      const nextDevices = this.devices.map((device, candidateIndex) =>
        candidateIndex === index ? { ...device, mobilePairingConnectionMode: mode } : device
      )
      await this.commit(nextDevices)
      return true
    })
  }

  getMobilePairingConnectionMode(deviceId: string): MobilePairingConnectionMode | null {
    const device = this.devices.find((candidate) => candidate.deviceId === deviceId)
    if (!device || device.scope !== 'mobile') {
      return null
    }
    // Why: pairings created before this preference existed used automatic
    // direct-first Relay fallback, so missing state must preserve that behavior.
    return device.mobilePairingConnectionMode === 'local-only' ? 'local-only' : 'automatic'
  }

  listDevices(): readonly DeviceEntry[] {
    return this.devices
  }

  validateToken(token: string): DeviceEntry | null {
    return this.devices.find((d) => d.token === token) ?? null
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
    const index = this.devices.findIndex((d) => d.deviceId === deviceId)
    if (index === -1) {
      return
    }
    if (this.devices[index]!.lastSeenAt === 0) {
      void this.updateLastSeen(deviceId).catch((error) => {
        console.warn('[mobile] Failed to persist first device sighting:', error)
      })
      return
    }
    const seenAt = Date.now()
    this.lastSeenRevision += 1
    this.devices = this.devices.map((device, candidateIndex) =>
      candidateIndex === index ? { ...device, lastSeenAt: seenAt } : device
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
    try {
      await this.serialized(() => this.commit(this.devices))
    } catch (error) {
      // Why: matches the async hardening path — a failed bookkeeping write must not take down the runtime.
      console.error('[mobile] Failed to persist device lastSeen:', error)
    }
  }

  private cancelPendingLastSeenFlush(): void {
    if (this.pendingLastSeenFlush) {
      clearTimeout(this.pendingLastSeenFlush)
      this.pendingLastSeenFlush = null
    }
  }

  private load(): void {
    if (!existsSync(this.registryPath)) {
      this.devices = []
      return
    }
    try {
      hardenExistingSecureFile(this.registryPath)
      const parsed = JSON.parse(readFileSync(this.registryPath, 'utf-8')) as DeviceEntry[]
      this.devices = parsed.map((device) => ({
        ...device,
        // Why: older registries only existed for phone pairing. Treat missing
        // scope as mobile so legacy device tokens do not gain new CLI powers.
        scope: device.scope === 'runtime' ? 'runtime' : 'mobile',
        relayBinding: validRelayBinding(device.relayBinding, device.deviceId),
        mobilePairingConnectionMode:
          device.mobilePairingConnectionMode === 'local-only' ? 'local-only' : 'automatic',
        // Why: registries written before this field existed only ever held network-reach grants (phones and
        // LAN links), so a missing value must keep binding every interface on reconnect.
        pairingReach: device.pairingReach === 'this-computer' ? 'this-computer' : 'network',
        // Why: a malformed row must degrade to "no background push", never fail the load
        // and strand every paired device.
        pushRegistration: parseMobilePushRegistration(device.pushRegistration)
      }))
      this.registryUnreadable = false
    } catch (error) {
      // "Cannot read" is not "is empty". Saving an empty list over a registry we were merely
      // denied would erase every paired device's bearer token, and the write would succeed.
      this.registryUnreadable = isUnreadableError(error)
      this.devices = []
    }
  }

  /** Persists `devices`, then makes them the in-memory list. */
  private async commit(devices: DeviceEntry[]): Promise<void> {
    if (this.registryUnreadable) {
      throw new Error(
        `Cannot read the device registry at ${this.registryPath}: the read failed. Refusing to overwrite it, which would revoke every paired device.`
      )
    }
    const revision = this.lastSeenRevision
    await writeSecureJsonFileAsync(this.registryPath, devices)
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
