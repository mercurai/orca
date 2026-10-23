// Why: a phone that turns background notifications off, or gets unpaired, must
// have its token deleted at the gateway even if the gateway is unreachable right
// then. Modelled on relay-revoke-outbox.ts: durable, hardened, drained on start.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { serializePathWrite } from '../../../shared/path-write-serializer'
import { hardenExistingSecureFile, isUnreadableError } from '../../../shared/secure-file'
import { writeSecureJsonFileAsync } from '../../../shared/secure-file-async-write'

export type PushUnregisterOutboxItem = {
  reqId: string
  registrationId: string
  deviceId: string
}

const OUTBOX_FILENAME = 'mobile-push-unregister-outbox.json'

function isItem(value: unknown): value is PushUnregisterOutboxItem {
  if (!value || typeof value !== 'object') {
    return false
  }
  const item = value as Partial<PushUnregisterOutboxItem>
  return (
    typeof item.reqId === 'string' &&
    typeof item.registrationId === 'string' &&
    item.registrationId.length > 0 &&
    typeof item.deviceId === 'string'
  )
}

export class PushUnregisterOutbox {
  private readonly path: string
  private outboxUnreadable = false
  private items: PushUnregisterOutboxItem[]

  constructor(userDataPath: string) {
    this.path = join(userDataPath, OUTBOX_FILENAME)
    this.items = this.load()
  }

  // Why: items are read, awaited through the write, then swapped in, so two mutations must not interleave.
  private serialized<T>(task: () => Promise<T>): Promise<T> {
    return serializePathWrite(`${this.path}#read-modify-write`, task)
  }

  enqueue(entry: { registrationId: string; deviceId: string }): Promise<PushUnregisterOutboxItem> {
    return this.serialized(async () => {
      const existing = this.items.find((item) => item.registrationId === entry.registrationId)
      if (existing) {
        return existing
      }
      const item = { ...entry, reqId: randomUUID() }
      await this.save([...this.items, item])
      return item
    })
  }

  isUnreadable(): boolean {
    return this.outboxUnreadable
  }

  pending(): readonly PushUnregisterOutboxItem[] {
    return this.items
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

  private load(): PushUnregisterOutboxItem[] {
    if (!existsSync(this.path)) {
      return []
    }
    try {
      hardenExistingSecureFile(this.path)
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf-8'))
      return Array.isArray(parsed) ? parsed.filter(isItem) : []
    } catch (error) {
      this.outboxUnreadable = isUnreadableError(error)
      return []
    }
  }

  private async save(items: PushUnregisterOutboxItem[]): Promise<void> {
    if (this.outboxUnreadable) {
      throw new Error('Cannot overwrite unreadable push unregister outbox')
    }
    await writeSecureJsonFileAsync(this.path, items)
    this.items = items
  }
}
