import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hardenExistingSecureFile, isUnreadableError } from '../../shared/secure-file'
import { writeSecureJsonFileAsync } from '../../shared/secure-file-async-write'
import { removeStaleDurableWriteTempFiles } from '../durable-file-write'
import type { MobileNotificationEvent } from './runtime-mobile-notification-controller'
import type { DeliveredNotificationIdentity } from '../../shared/mobile-notification-identity'
import {
  isStructuredAttentionOrigin,
  type StructuredAttentionOrigin
} from '../../shared/agent-session-attention'

export type { DeliveredNotificationIdentity } from '../../shared/mobile-notification-identity'
export type DeliveredNotificationRecord = DeliveredNotificationIdentity & {
  structuredOrigin?: StructuredAttentionOrigin
}
type RecordEntry = DeliveredNotificationRecord & { dismissedThrough: number; expiresAt: number }
const LIMIT = 4096
const RETENTION_MS = 7 * 86400_000
const STALE_WRITE_TEMP_AGE_MS = 86400_000
// Why: every dispatch used to rewrite the whole file (two icacls spawns on Windows); bursts coalesce into one write of the latest snapshot.
const DEFAULT_PERSIST_DELAY_MS = 5_000

type PersistWaiter = { resolve: () => void; reject: (error: unknown) => void }

export class MobileNotificationDismissalStore {
  private readonly path: string
  private entries: RecordEntry[] = []
  private unreadable = false
  private readonly persistDelayMs: number
  private persistTimer: NodeJS.Timeout | null = null
  private persistWaiters: PersistWaiter[] = []
  private writing: Promise<void> | null = null
  // Sync by necessity: a constructor has no await. Runs once per process at startup, not per IPC call.
  constructor(userDataPath: string, options: { persistDelayMs?: number } = {}) {
    this.persistDelayMs = options.persistDelayMs ?? DEFAULT_PERSIST_DELAY_MS
    this.path = join(userDataPath, 'mobile-notification-dismissals.json')
    // Why: a write killed between writeFile and rename (e.g. a hung icacls, #20497) orphans its temp forever.
    void removeStaleDurableWriteTempFiles(this.path, { minimumAgeMs: STALE_WRITE_TEMP_AGE_MS })
    try {
      hardenExistingSecureFile(this.path)
      const value: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      if (Array.isArray(value)) {
        this.entries = value.flatMap(readEntry).slice(-LIMIT)
      }
    } catch (error) {
      this.unreadable = isUnreadableError(error)
      // Missing history cannot establish that a delivered alert was dismissed.
    }
  }

  /**
   * Updates the in-memory history at once and resolves when a snapshot that includes this event is
   * on disk. `persist: false` keeps the event in memory only (nothing paired could have received it).
   */
  async record(
    event: MobileNotificationEvent & { notificationEpoch: string; notificationSeq: number },
    options: { persist?: boolean } = {}
  ): Promise<void> {
    if (!event.notificationId) {
      return
    }
    const now = Date.now()
    const kept = this.entries.filter((entry) => entry.expiresAt > now)
    const same = (entry: RecordEntry) =>
      entry.notificationId === event.notificationId &&
      entry.notificationEpoch === event.notificationEpoch
    let next: RecordEntry[]
    if (event.type === 'dismiss' && event.dismissedDelivery) {
      const target = event.dismissedDelivery
      next = kept.map((entry) =>
        entry.notificationId === target.notificationId &&
        entry.notificationEpoch === target.notificationEpoch
          ? {
              ...entry,
              dismissedThrough: Math.max(entry.dismissedThrough, target.notificationSeq),
              expiresAt: now + RETENTION_MS
            }
          : entry
      )
    } else if (event.type === 'notification') {
      next = [
        ...kept.filter((entry) => !same(entry)),
        {
          notificationId: event.notificationId,
          notificationEpoch: event.notificationEpoch,
          notificationSeq: event.notificationSeq,
          ...(event.structuredOrigin ? { structuredOrigin: event.structuredOrigin } : {}),
          dismissedThrough: kept.find(same)?.dismissedThrough ?? -1,
          expiresAt: now + RETENTION_MS
        }
      ]
    } else {
      next = kept
        .filter((entry) => !same(entry))
        .map((entry) =>
          entry.notificationId === event.notificationId
            ? { ...entry, dismissedThrough: entry.notificationSeq, expiresAt: now + RETENTION_MS }
            : entry
        )
      next.push({
        notificationId: event.notificationId,
        notificationEpoch: event.notificationEpoch,
        notificationSeq: event.notificationSeq,
        dismissedThrough: event.notificationSeq,
        expiresAt: now + RETENTION_MS
      })
    }
    next = next.slice(-LIMIT)
    // Commit in memory before awaiting: two records that interleave across the persist would
    // otherwise both derive `next` from the same stale entries and lose one of them.
    this.entries = next
    if (!this.unreadable && options.persist !== false) {
      await this.schedulePersist()
    }
  }

  /** Writes any pending snapshot now; resolves once it is durable. */
  async flush(): Promise<void> {
    if (this.persistTimer) {
      await this.persistNow()
    }
    await this.writing
  }

  private schedulePersist(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.persistWaiters.push({ resolve, reject })
      if (!this.persistTimer) {
        this.persistTimer = setTimeout(() => void this.persistNow(), this.persistDelayMs)
        this.persistTimer.unref()
      }
    })
  }

  private async persistNow(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    const waiters = this.persistWaiters
    this.persistWaiters = []
    const write = writeSecureJsonFileAsync(this.path, this.entries).then(
      () => waiters.forEach((waiter) => waiter.resolve()),
      (error: unknown) => waiters.forEach((waiter) => waiter.reject(error))
    )
    this.writing = write
    await write
  }

  liveDeliveries(prefix = ''): DeliveredNotificationRecord[] {
    const now = Date.now()
    return this.entries
      .filter(
        (entry) =>
          entry.expiresAt > now &&
          entry.notificationId.startsWith(prefix) &&
          entry.dismissedThrough < entry.notificationSeq
      )
      .map(({ notificationId, notificationEpoch, notificationSeq, structuredOrigin }) => ({
        notificationId,
        notificationEpoch,
        notificationSeq,
        ...(structuredOrigin ? { structuredOrigin } : {})
      }))
  }

  reconcile(delivered: readonly DeliveredNotificationIdentity[]): DeliveredNotificationIdentity[] {
    const now = Date.now()
    return delivered.filter((item) =>
      this.entries.some(
        (entry) =>
          entry.dismissedThrough >= 0 &&
          entry.expiresAt > now &&
          entry.notificationId === item.notificationId &&
          entry.notificationEpoch === item.notificationEpoch &&
          entry.dismissedThrough >= item.notificationSeq
      )
    )
  }
}

/** An origin this build cannot read (a newer cause kind) degrades to none; the record survives. */
function readEntry(value: unknown): RecordEntry[] {
  if (!isEntry(value)) {
    return []
  }
  const { structuredOrigin, ...entry } = value
  return [isStructuredAttentionOrigin(structuredOrigin) ? { ...entry, structuredOrigin } : entry]
}

function isEntry(
  value: unknown
): value is Omit<RecordEntry, 'structuredOrigin'> & { structuredOrigin?: unknown } {
  if (!value || typeof value !== 'object') {
    return false
  }
  const item = value as RecordEntry
  return (
    typeof item.notificationId === 'string' &&
    item.notificationId.length > 0 &&
    typeof item.notificationEpoch === 'string' &&
    item.notificationEpoch.length > 0 &&
    Number.isSafeInteger(item.notificationSeq) &&
    item.notificationSeq >= 0 &&
    Number.isSafeInteger(item.dismissedThrough) &&
    item.dismissedThrough >= -1 &&
    Number.isFinite(item.expiresAt)
  )
}
