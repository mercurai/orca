import type { AuthenticatedPrincipalBinding, DeviceEntry } from './device-entry'

const LAST_SEEN_FLUSH_DELAY_MS = 250

/** Coalesces bookkeeping writes without owning credential rows or the mutation queue. */
export class DeviceRegistryLastSeen {
  private pendingFlush: NodeJS.Timeout | null = null
  private currentRevision = 0
  private readonly firstSightings = new Map<string, Promise<void>>()

  constructor(private readonly persist: () => Promise<void>) {}

  get revision(): number {
    return this.currentRevision
  }

  markChanged(): void {
    this.currentRevision += 1
  }

  /** Concurrent first sockets share one write; a failed write may be retried on reconnect. */
  firstSighting(deviceId: string, persist: () => Promise<void>): Promise<void> {
    const pending = this.firstSightings.get(deviceId)
    if (pending) {
      return pending
    }
    const writing = persist().finally(() => {
      if (this.firstSightings.get(deviceId) === writing) {
        this.firstSightings.delete(deviceId)
      }
    })
    this.firstSightings.set(deviceId, writing)
    return writing
  }

  /** Preserves synchronous admission for established devices and fences first-sighting writes. */
  prepareAuthentication(
    principal: AuthenticatedPrincipalBinding,
    owner: {
      resolve: (principal: AuthenticatedPrincipalBinding) => DeviceEntry | null
      serialized: (task: () => Promise<void>) => Promise<void>
      persistFirst: (deviceId: string) => Promise<void>
    }
  ): void | Promise<void> {
    const device = owner.resolve(principal)
    if (!device) {
      throw new Error('Device authentication changed before admission')
    }
    if (device.lastSeenAt !== 0) {
      return
    }
    return this.firstSighting(device.deviceId, () =>
      owner.serialized(async () => {
        const current = owner.resolve(principal)
        if (!current) {
          throw new Error('Device authentication changed before persistence')
        }
        if (current.lastSeenAt === 0) {
          await owner.persistFirst(current.deviceId)
        }
      })
    ).then(() => {
      if (!owner.resolve(principal)) {
        throw new Error('Device authentication changed while persisting')
      }
    })
  }

  async update(
    devices: DeviceEntry[],
    deviceId: string,
    commit: (devices: DeviceEntry[]) => Promise<void>
  ): Promise<void> {
    const index = devices.findIndex((device) => device.deviceId === deviceId)
    if (index === -1) {
      return
    }
    // The first sighting must reach disk before rotation can safely retain this row.
    const seenAt = Date.now()
    await commit(
      devices.map((device, candidateIndex) =>
        candidateIndex === index ? { ...device, lastSeenAt: seenAt } : device
      )
    )
  }

  /** Preserve newer deferred timestamps when a durable write overlapped a refresh. */
  afterPersist(written: DeviceEntry[], current: DeviceEntry[], revision: number): DeviceEntry[] {
    if (revision === this.revision) {
      this.cancel()
      return written
    }
    return this.merge(written, current)
  }

  merge(written: DeviceEntry[], current: DeviceEntry[]): DeviceEntry[] {
    const seen = new Map(current.map((device) => [device.deviceId, device.lastSeenAt]))
    return written.map((device) => ({
      ...device,
      lastSeenAt: Math.max(device.lastSeenAt, seen.get(device.deviceId) ?? 0)
    }))
  }

  defer(
    devices: DeviceEntry[],
    deviceId: string,
    persistFirst: () => Promise<void>
  ): DeviceEntry[] {
    const existing = devices.find((device) => device.deviceId === deviceId)
    if (!existing) {
      return devices
    }
    if (existing.lastSeenAt === 0) {
      void this.firstSighting(deviceId, persistFirst).catch((error) => {
        console.warn('[mobile] Failed to persist first device sighting:', error)
      })
      return devices
    }
    const seenAt = Date.now()
    this.markChanged()
    const refreshed = devices.map((device) =>
      device.deviceId === deviceId ? { ...device, lastSeenAt: seenAt } : device
    )
    this.schedule()
    return refreshed
  }

  schedule(): void {
    if (this.pendingFlush) {
      return
    }
    this.pendingFlush = setTimeout(() => void this.flush(), LAST_SEEN_FLUSH_DELAY_MS)
    this.pendingFlush.unref?.()
  }

  cancel(): void {
    if (this.pendingFlush) {
      clearTimeout(this.pendingFlush)
      this.pendingFlush = null
    }
  }

  async flush(): Promise<void> {
    if (!this.pendingFlush) {
      return
    }
    this.cancel()
    await this.persist()
  }
}
