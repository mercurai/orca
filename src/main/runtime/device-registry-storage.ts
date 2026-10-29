import { removeStaleDurableWriteTempFiles } from '../durable-file-write'
import { DeviceRegistryWriter } from './device-registry-disk-merge'
import type { readDeviceRegistryFile } from './device-registry-file-read'
import type { DeviceEntry } from './device-entry'

const STALE_WRITE_TEMP_AGE_MS = 24 * 60 * 60 * 1000

/** Owns disk readability and quarantine state; live credential rows remain in DeviceRegistry. */
export class DeviceRegistryStorage {
  private unreadable = false
  private doubtful = false
  private corruptFilePending = false
  private readonly writer: DeviceRegistryWriter

  constructor(private readonly path: string) {
    this.writer = new DeviceRegistryWriter(path)
    void removeStaleDurableWriteTempFiles(path, { minimumAgeMs: STALE_WRITE_TEMP_AGE_MS })
  }

  get isUnreadable(): boolean {
    return this.unreadable
  }

  get isUnavailable(): boolean {
    return this.unreadable || this.doubtful
  }

  read(): ReturnType<typeof readDeviceRegistryFile> {
    const read = this.writer.read()
    this.unreadable = read.unreadable
    this.doubtful = read.doubtful
    this.corruptFilePending = read.corruptFilePending
    return read
  }

  adopt(devices: DeviceEntry[]): DeviceEntry[] {
    const adopted = this.writer.adoptExternalEdits(devices)
    const read = this.writer.lastRead
    if (read) {
      this.unreadable = read.unreadable
      this.doubtful = read.doubtful
      this.corruptFilePending = read.corruptFilePending
    }
    return adopted ?? devices
  }

  reconcileWritten(written: readonly DeviceEntry[]): DeviceEntry[] {
    try {
      return this.writer.reconcileWritten(written)
    } finally {
      const read = this.writer.lastRead
      if (read) {
        this.unreadable = read.unreadable
        this.doubtful = read.doubtful
        this.corruptFilePending = read.corruptFilePending
      }
    }
  }

  markRemoved(ids: readonly string[]): void {
    this.writer.markRemoved(ids)
  }

  async write(
    devices: DeviceEntry[],
    options: { durable?: boolean },
    before: readonly DeviceEntry[] = devices
  ): Promise<DeviceEntry[]> {
    if (this.unreadable) {
      throw new Error(
        `Cannot read the device registry at ${this.path}: the read failed. Refusing to overwrite it, which would revoke every paired device.`
      )
    }
    if (this.corruptFilePending) {
      this.writer.quarantineCorrupt()
      this.corruptFilePending = false
    }
    return this.writer.write(before, devices, options)
  }
}
