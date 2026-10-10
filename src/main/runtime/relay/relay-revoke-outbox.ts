import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serializePathWrite } from '../../../shared/path-write-serializer'
import { hardenExistingSecureFile, isUnreadableError } from '../../../shared/secure-file'
import { writeSecureJsonFileAsync } from '../../../shared/secure-file-async-write'

export type RelayDeviceBinding = {
  relayHostId: string
  relayDeviceId: string
  ownerIdentityKey: string
  inviteExpiresAt?: number
}

export type RelayRevokeOutboxItem = RelayDeviceBinding & {
  reqId: string
  createdAt: number
}

const OUTBOX_FILENAME = 'mobile-relay-revoke-outbox.json'

function isItem(value: unknown): value is RelayRevokeOutboxItem {
  if (!value || typeof value !== 'object') {
    return false
  }
  const item = value as Partial<RelayRevokeOutboxItem>
  return (
    typeof item.reqId === 'string' &&
    typeof item.relayHostId === 'string' &&
    typeof item.relayDeviceId === 'string' &&
    typeof item.ownerIdentityKey === 'string' &&
    (item.inviteExpiresAt === undefined ||
      (typeof item.inviteExpiresAt === 'number' && Number.isFinite(item.inviteExpiresAt))) &&
    typeof item.createdAt === 'number' &&
    Number.isFinite(item.createdAt)
  )
}

export class RelayRevokeOutbox {
  private readonly path: string
  private items: RelayRevokeOutboxItem[]
  /** Set when the outbox exists but could not be read, so `items` is not what is on disk. */
  private outboxUnreadable = false

  constructor(userDataPath: string) {
    this.path = join(userDataPath, OUTBOX_FILENAME)
    this.items = this.load()
  }

  // Why: items are read, awaited through the write, then swapped in, so two mutations must not interleave.
  private serialized<T>(task: () => Promise<T>): Promise<T> {
    return serializePathWrite(`${this.path}#read-modify-write`, task)
  }

  enqueue(binding: RelayDeviceBinding): Promise<RelayRevokeOutboxItem> {
    return this.serialized(async () => {
      const existing = this.items.find(
        (item) =>
          item.relayHostId === binding.relayHostId &&
          item.relayDeviceId === binding.relayDeviceId &&
          item.ownerIdentityKey === binding.ownerIdentityKey
      )
      if (existing) {
        return existing
      }
      const item = { ...binding, reqId: randomUUID(), createdAt: Date.now() }
      await this.save([...this.items, item])
      return item
    })
  }

  pendingFor(ownerIdentityKey: string, relayHostId: string): readonly RelayRevokeOutboxItem[] {
    return this.items.filter(
      (item) => item.ownerIdentityKey === ownerIdentityKey && item.relayHostId === relayHostId
    )
  }

  remove(reqId: string): Promise<void> {
    return this.serialized(async () => {
      const next = this.items.filter((item) => item.reqId !== reqId)
      if (next.length === this.items.length) {
        return
      }
      await this.save(next)
    })
  }

  private load(): RelayRevokeOutboxItem[] {
    if (!existsSync(this.path)) {
      return []
    }
    try {
      hardenExistingSecureFile(this.path)
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf-8'))
      return Array.isArray(parsed) ? parsed.filter(isItem) : []
    } catch (error) {
      // An outbox we were denied is not an empty outbox. Saving [] over it would drop
      // revocations that have not reached the relay, so a revoked device stays live.
      this.outboxUnreadable = isUnreadableError(error)
      return []
    }
  }

  private async save(items: RelayRevokeOutboxItem[]): Promise<void> {
    if (this.outboxUnreadable) {
      throw new Error(
        `Cannot read the relay revoke outbox at ${this.path}: the read failed. Refusing to overwrite it, which would drop pending revocations.`
      )
    }
    await writeSecureJsonFileAsync(this.path, items)
    this.items = items
  }
}
