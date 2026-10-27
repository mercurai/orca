import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  drainPendingPathWrites,
  pendingPathWritePaths,
  serializePathWrite
} from '../../shared/path-write-serializer'
import * as secureWrites from '../../shared/secure-file-async-write'
import * as syncWrites from '../../shared/secure-file'
import { ConnectorTurnEvents } from './connector-turn-events'

const conversation = { source: 'slack', externalId: 'synthetic-team:channel:thread' } as const
const wireTurn = (turnId: number) =>
  ({
    kind: 'turn-ended',
    conversation,
    paneKey: 'synthetic-pane',
    turnId,
    at: turnId,
    stopReason: null,
    lastAssistantMessage: 'synthetic reply'
  }) as const
const turn = (turnId: number) => ({ ...wireTurn(turnId), worktreeId: 'synthetic-worktree' })
const outboxPath = (path: string) => join(path, 'connector-turn-outbox.json')
const stored = (path: string): unknown => JSON.parse(readFileSync(outboxPath(path), 'utf8'))
const paths: string[] = []
let userDataPath: string

function flushPending(events: ConnectorTurnEvents): Promise<void> {
  if (!('flushPendingWrites' in events) || typeof events.flushPendingWrites !== 'function') {
    throw new Error('ConnectorTurnEvents must expose its awaited persistence barrier')
  }
  const pending: unknown = events.flushPendingWrites()
  if (!(pending instanceof Promise)) {
    throw new Error('The persistence barrier must return a Promise')
  }
  return pending
}

async function holdPath(path = userDataPath) {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const blocking = serializePathWrite(outboxPath(path), async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  return { release: () => release.resolve(), blocking }
}

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-connector-persistence-'))
  paths.push(userDataPath)
})

afterEach(async () => {
  await drainPendingPathWrites()
  vi.restoreAllMocks()
  for (const path of paths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('ConnectorTurnEvents async persistence', () => {
  it('queues real turn bytes behind the shared path lane instead of writing synchronously', async () => {
    const events = new ConnectorTurnEvents(userDataPath, 'synthetic-account-a')
    const held = await holdPath()
    try {
      events.observe(turn(1))
      events.observe(turn(2))
      expect(existsSync(outboxPath(userDataPath))).toBe(false)
      held.release()
      await held.blocking
      await drainPendingPathWrites()
      expect(stored(userDataPath)).toEqual({
        account: 'synthetic-account-a',
        turnEnds: [wireTurn(1), wireTurn(2)]
      })
    } finally {
      held.release()
      await held.blocking
      await drainPendingPathWrites()
    }
  })

  it('persists only the newer turn when an acknowledgement clears a queued head', async () => {
    const events = new ConnectorTurnEvents(userDataPath, 'synthetic-account-a')
    events.observe(turn(1))
    await drainPendingPathWrites()
    const before = readFileSync(outboxPath(userDataPath), 'utf8')
    const head = events.next(1)
    expect(head?.batch).toEqual([wireTurn(1)])
    if (!head) {
      throw new Error('missing sent head')
    }
    const held = await holdPath()
    try {
      events.observe(turn(2))
      events.accepted(head.stamp)
      expect(readFileSync(outboxPath(userDataPath), 'utf8')).toBe(before)
      expect(events.next(1)?.batch).toEqual([wireTurn(2)])
      held.release()
      await held.blocking
      await drainPendingPathWrites()
      expect(stored(userDataPath)).toEqual({
        account: 'synthetic-account-a',
        turnEnds: [wireTurn(2)]
      })
      expect(new ConnectorTurnEvents(userDataPath, 'synthetic-account-a').next(1)?.batch).toEqual([
        wireTurn(2)
      ])
    } finally {
      held.release()
      await held.blocking
      await drainPendingPathWrites()
    }
  })

  it.each(['owner', 'stored'] as const)(
    'does not resurrect a queued turn after %s clear',
    async (cleared) => {
      const events = new ConnectorTurnEvents(userDataPath, 'synthetic-account-a')
      const held = await holdPath()
      try {
        events.observe(turn(1))
        if (cleared === 'owner') {
          events.clear()
          expect(events.next(1)).toBeNull()
        } else {
          ConnectorTurnEvents.clearStored(userDataPath)
        }
        held.release()
        await held.blocking
        await drainPendingPathWrites()
        expect(existsSync(outboxPath(userDataPath))).toBe(false)
        expect(new ConnectorTurnEvents(userDataPath, 'synthetic-account-a').next(1)).toBeNull()
      } finally {
        held.release()
        await held.blocking
        await drainPendingPathWrites()
      }
    }
  )

  it.each(['owner', 'stored'] as const)(
    'keeps a new account isolated after %s clear invalidates an older queued save',
    async (cleared) => {
      const previous = new ConnectorTurnEvents(userDataPath, 'synthetic-account-a')
      const held = await holdPath()
      try {
        previous.observe(turn(1))
        if (cleared === 'owner') {
          previous.clear()
        } else {
          ConnectorTurnEvents.clearStored(userDataPath)
        }
        const next = new ConnectorTurnEvents(userDataPath, 'synthetic-account-b')
        expect(next.next(1)).toBeNull()
        next.observe(turn(2))
        expect(existsSync(outboxPath(userDataPath))).toBe(false)
        held.release()
        await held.blocking
        await drainPendingPathWrites()
        expect(stored(userDataPath)).toEqual({
          account: 'synthetic-account-b',
          turnEnds: [wireTurn(2)]
        })
        expect(new ConnectorTurnEvents(userDataPath, 'synthetic-account-a').next(1)).toBeNull()
      } finally {
        held.release()
        await held.blocking
        await drainPendingPathWrites()
      }
    }
  )

  it('persists another profile while this profile has a blocked outbox path', async () => {
    const otherPath = mkdtempSync(join(tmpdir(), 'orca-connector-other-'))
    paths.push(otherPath)
    const events = new ConnectorTurnEvents(userDataPath, 'synthetic-account-a')
    const other = new ConnectorTurnEvents(otherPath, 'synthetic-account-b')
    const held = await holdPath()
    const operations: Promise<unknown>[] = []
    try {
      events.observe(turn(1))
      other.observe(turn(2))
      expect(existsSync(outboxPath(userDataPath))).toBe(false)
      // This is the same per-profile admission lane the quit drain owns.
      expect(pendingPathWritePaths()).toContain(`${outboxPath(otherPath)}#mutation`)
      const saving = flushPending(other)
      operations.push(saving)
      await expect(saving).resolves.toBeUndefined()
      expect(stored(otherPath)).toEqual({
        account: 'synthetic-account-b',
        turnEnds: [wireTurn(2)]
      })
    } finally {
      held.release()
      await Promise.allSettled([held.blocking, ...operations])
      await drainPendingPathWrites()
    }
    expect(stored(userDataPath)).toEqual({
      account: 'synthetic-account-a',
      turnEnds: [wireTurn(1)]
    })
  })

  it('coalesces a blocked turn burst into bounded saves while retaining the newest 200 turns', async () => {
    const events = new ConnectorTurnEvents(userDataPath, 'synthetic-account-a')
    const asyncWrite = vi.spyOn(secureWrites, 'writeSecureFileAsync')
    const syncWrite = vi.spyOn(syncWrites, 'writeSecureJsonFile')
    const held = await holdPath()
    try {
      events.observe(turn(1))
      expect(syncWrite).not.toHaveBeenCalled()
      for (let turnId = 2; turnId <= 301; turnId += 1) {
        events.observe(turn(turnId))
      }
      expect(existsSync(outboxPath(userDataPath))).toBe(false)
      held.release()
      await held.blocking
      await drainPendingPathWrites()
      expect(asyncWrite.mock.calls.length).toBeGreaterThanOrEqual(1)
      expect(asyncWrite.mock.calls.length).toBeLessThanOrEqual(2)
      expect(syncWrite).not.toHaveBeenCalled()
      expect(stored(userDataPath)).toEqual({
        account: 'synthetic-account-a',
        turnEnds: Array.from({ length: 200 }, (_, index) => wireTurn(index + 102))
      })
    } finally {
      held.release()
      await held.blocking
      await drainPendingPathWrites()
    }
  })

  it('exposes failure to its owner and retains dirty turn memory for one bounded retry', async () => {
    const events = new ConnectorTurnEvents(userDataPath, 'synthetic-account-a')
    const report = vi.fn<(...args: unknown[]) => void>()
    vi.spyOn(console, 'warn').mockImplementation(report)
    vi.spyOn(console, 'error').mockImplementation(report)
    const writing = vi.spyOn(secureWrites, 'writeSecureFileAsync')
    mkdirSync(outboxPath(userDataPath))
    expect(() => events.observe(turn(1))).not.toThrow()
    await expect(flushPending(events)).rejects.toBeInstanceOf(Error)
    expect(report.mock.calls.flat().some((value) => value instanceof Error)).toBe(true)
    expect(writing).toHaveBeenCalledOnce()
    // Retained memory is inspectable; publication still requires the awaited barrier.
    expect(events.next(1)?.batch).toEqual([wireTurn(1)])
    rmSync(outboxPath(userDataPath), { recursive: true, force: true })
    await expect(flushPending(events)).resolves.toBeUndefined()
    expect(writing).toHaveBeenCalledTimes(2)
    expect(stored(userDataPath)).toEqual({
      account: 'synthetic-account-a',
      turnEnds: [wireTurn(1)]
    })
  })
})
