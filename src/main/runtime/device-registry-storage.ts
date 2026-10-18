import {
  writeDurableSecureJsonFileAsync,
  writeSecureJsonFileAsync
} from '../../shared/secure-file-async-write'
import { removeStaleDurableWriteTempFiles } from '../durable-file-write'
import { quarantineCorruptRegistry } from './device-registry-corruption'
import { readDeviceRegistryFile } from './device-registry-file-read'
import type { DeviceEntry } from './device-entry'

const STALE_WRITE_TEMP_AGE_MS = 24 * 60 * 60 * 1000

/** Owns disk readability and quarantine state; live credential rows remain in DeviceRegistry. */
export class DeviceRegistryStorage {
  private unreadable = false
  private doubtful = false
  private corruptFilePending = false

  constructor(private readonly path: string) {
    void removeStaleDurableWriteTempFiles(path, { minimumAgeMs: STALE_WRITE_TEMP_AGE_MS })
  }

  get isUnavailable(): boolean {
    return this.unreadable || this.doubtful
  }

  read(): ReturnType<typeof readDeviceRegistryFile> {
    const read = readDeviceRegistryFile(this.path)
    this.unreadable = read.unreadable
    this.doubtful = read.doubtful
    this.corruptFilePending = read.corruptFilePending
    return read
  }

  async write(devices: DeviceEntry[], options: { durable?: boolean }): Promise<void> {
    if (this.unreadable) {
      throw new Error(
        `Cannot read the device registry at ${this.path}: the read failed. Refusing to overwrite it, which would revoke every paired device.`
      )
    }
    if (this.corruptFilePending) {
      quarantineCorruptRegistry(this.path)
      this.corruptFilePending = false
    }
    const write = options.durable ? writeDurableSecureJsonFileAsync : writeSecureJsonFileAsync
    await write(this.path, devices)
  }
}
