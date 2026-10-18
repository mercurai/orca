import type { DeviceEntry } from './device-entry'

const LAST_SEEN_FLUSH_DELAY_MS = 250

/** Coalesces bookkeeping writes without owning credential rows or the mutation queue. */
export class DeviceRegistryLastSeen {
  private pendingFlush: NodeJS.Timeout | null = null
  private currentRevision = 0

  constructor(private readonly persist: () => Promise<void>) {}

  get revision(): number {
    return this.currentRevision
  }

  markChanged(): void {
    this.currentRevision += 1
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
    owner: { persistFirst: () => Promise<void>; replaceRows: (devices: DeviceEntry[]) => void }
  ): void {
    const existing = devices.find((device) => device.deviceId === deviceId)
    if (!existing) {
      return
    }
    if (existing.lastSeenAt === 0) {
      void owner.persistFirst().catch((error) => {
        console.warn('[mobile] Failed to persist first device sighting:', error)
      })
      return
    }
    const seenAt = Date.now()
    this.markChanged()
    owner.replaceRows(
      devices.map((device) =>
        device.deviceId === deviceId ? { ...device, lastSeenAt: seenAt } : device
      )
    )
    this.schedule()
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
