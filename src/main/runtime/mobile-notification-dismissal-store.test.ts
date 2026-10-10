import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type * as SecureFileAsyncWrite from '../../shared/secure-file-async-write'
import { MobileNotificationDismissalStore } from './mobile-notification-dismissal-store'

// Every snapshot handed to the async writer, so a test can count writes and read what they carried.
const snapshots = vi.hoisted((): unknown[] => [])

vi.mock('../../shared/secure-file-async-write', async (importOriginal) => {
  const actual = await importOriginal<typeof SecureFileAsyncWrite>()
  return {
    ...actual,
    writeSecureJsonFileAsync: (path: string, value: unknown) => {
      snapshots.push(value)
      return actual.writeSecureJsonFileAsync(path, value)
    }
  }
})
const paths: string[] = []
afterEach(() => {
  paths.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
  vi.restoreAllMocks()
})
function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'orca-dismissals-'))
  paths.push(path)
  return { path, store: new MobileNotificationDismissalStore(path, { persistDelayMs: 0 }) }
}
const shown = { notificationId: 'same', notificationEpoch: 'old', notificationSeq: 12 }
const alert = {
  type: 'notification' as const,
  source: 'terminal-bell' as const,
  title: 'QA',
  body: ''
}
it('reconciles an old delivered alert after desktop restart and preserves unrelated identities', async () => {
  const h = fixture()
  await h.store.record({ ...alert, ...shown })
  const restarted = new MobileNotificationDismissalStore(h.path)
  await restarted.record({
    type: 'dismiss',
    notificationId: 'same',
    notificationEpoch: 'new',
    notificationSeq: 1
  })
  const loaded = new MobileNotificationDismissalStore(h.path)
  expect(
    loaded.reconcile([
      shown,
      { ...shown, notificationEpoch: 'other' },
      { ...shown, notificationId: 'other' },
      { ...shown, notificationSeq: 13 }
    ])
  ).toEqual([shown])
})
it('does not dismiss a newer replacement and does not treat missing or expired history as dismissal', async () => {
  const h = fixture()
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now)
  await h.store.record({ ...alert, ...shown })
  await h.store.record({ type: 'dismiss', ...shown, notificationSeq: 13 })
  expect(h.store.reconcile([shown])).toEqual([shown])
  await h.store.record({ ...alert, ...shown, notificationSeq: 14 })
  expect(h.store.reconcile([{ ...shown, notificationSeq: 14 }])).toEqual([])
  expect(h.store.reconcile([shown])).toEqual([shown])
  await h.store.record({ type: 'dismiss', ...shown, notificationSeq: 15 })
  vi.mocked(Date.now).mockReturnValue(now + 7 * 86400_000)
  expect(h.store.reconcile([shown])).toEqual([])
  expect(new MobileNotificationDismissalStore(`${h.path}-unknown`).reconcile([shown])).toEqual([])
})
it('names the live deliveries a subject can still retire, across a restart', async () => {
  const h = fixture()
  const keyed = (notificationId: string, notificationSeq: number) => ({
    ...alert,
    notificationId,
    notificationEpoch: 'e',
    notificationSeq
  })
  await h.store.record(keyed('subject:prompt:a1', 1))
  await h.store.record(keyed('subject:prompt:a10', 2))
  await h.store.record(keyed('other:prompt:a1', 3))
  await h.store.record({
    type: 'dismiss',
    notificationId: 'subject:prompt:a10',
    notificationEpoch: 'e',
    notificationSeq: 4
  })
  const restarted = new MobileNotificationDismissalStore(h.path)
  expect(restarted.liveDeliveries('subject:').map((entry) => entry.notificationId)).toEqual([
    'subject:prompt:a1'
  ])
})

it('keeps a record whose origin a newer build wrote, losing only that origin', () => {
  const h = fixture()
  const origin = {
    scope: {
      executionHostId: 'runtime:h',
      wslDistro: null,
      workspaceId: 'w',
      workspaceKind: 'folder'
    },
    sessionId: 's',
    journalCursor: { epoch: 'j', sequence: 3 }
  }
  const entry = { ...shown, dismissedThrough: -1, expiresAt: Date.now() + 86400_000 }
  writeFileSync(
    join(h.path, 'mobile-notification-dismissals.json'),
    JSON.stringify([
      {
        ...entry,
        structuredOrigin: { ...origin, cause: { kind: 'subagent-prompt', promptId: 'p' } }
      },
      {
        ...entry,
        notificationId: 'known',
        structuredOrigin: { ...origin, cause: { kind: 'prompt', promptId: 'p' } }
      }
    ])
  )
  expect(new MobileNotificationDismissalStore(h.path).liveDeliveries()).toEqual([
    shown,
    expect.objectContaining({ notificationId: 'known', structuredOrigin: expect.anything() })
  ])
})

it('retains in-memory delivery and retirement when durable writes fail', async () => {
  const h = fixture()
  mkdirSync(join(h.path, 'mobile-notification-dismissals.json'))
  await expect(h.store.record({ ...alert, ...shown })).rejects.toThrow()
  expect(h.store.liveDeliveries(shown.notificationId)).toHaveLength(1)
  await expect(
    h.store.record({
      type: 'dismiss',
      notificationId: shown.notificationId,
      notificationEpoch: 'current',
      notificationSeq: 1,
      dismissedDelivery: shown
    })
  ).rejects.toThrow()
  expect(h.store.liveDeliveries(shown.notificationId)).toEqual([])
  expect(h.store.reconcile([shown])).toEqual([shown])
})

it('a targeted old delivery cannot retire a newer replacement with the same logical id', async () => {
  const h = fixture()
  await h.store.record({ ...alert, ...shown })
  await h.store.record({ ...alert, ...shown, notificationSeq: shown.notificationSeq + 1 })
  await h.store.record({ ...alert, ...shown, notificationEpoch: 'different' })
  await h.store.record({
    type: 'dismiss',
    notificationId: shown.notificationId,
    notificationEpoch: 'current',
    notificationSeq: 1,
    dismissedDelivery: shown
  })
  expect(
    h.store.liveDeliveries().map((record) => [record.notificationEpoch, record.notificationSeq])
  ).toEqual([
    ['old', 13],
    ['different', 12]
  ])
  expect(h.store.reconcile([shown, { ...shown, notificationSeq: 13 }])).toEqual([shown])
})

it('keeps an unpersisted record in memory only when nothing could have received it', async () => {
  const h = fixture()
  await h.store.record({ ...alert, ...shown }, { persist: false })
  expect(h.store.liveDeliveries(shown.notificationId)).toHaveLength(1)
  expect(existsSync(join(h.path, 'mobile-notification-dismissals.json'))).toBe(false)
})

it('coalesces a burst of records into one debounced write of the latest snapshot', async () => {
  vi.useFakeTimers()
  try {
    snapshots.length = 0
    const h = fixture()
    const debounced = new MobileNotificationDismissalStore(h.path, { persistDelayMs: 5_000 })
    const writes = [1, 2, 3].map((seq) =>
      debounced.record({ ...alert, ...shown, notificationId: `n${seq}`, notificationSeq: seq })
    )

    await vi.advanceTimersByTimeAsync(4_999)
    expect(snapshots).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    await Promise.all(writes)

    expect(snapshots).toHaveLength(1)
    expect(JSON.stringify(snapshots[0])).toContain('n1')
    expect(JSON.stringify(snapshots[0])).toContain('n3')
    expect(
      new MobileNotificationDismissalStore(h.path)
        .liveDeliveries()
        .map((entry) => entry.notificationId)
        .sort()
    ).toEqual(['n1', 'n2', 'n3'])
  } finally {
    vi.useRealTimers()
  }
})
