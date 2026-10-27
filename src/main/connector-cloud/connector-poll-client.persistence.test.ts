import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONNECTOR_PATHS } from '../../shared/connector-cloud-contract'
import { drainPendingPathWrites, serializePathWrite } from '../../shared/path-write-serializer'
import { UNREADABLE_ANSWER } from './connector-cloud-request'
import { connectorRetryDelayMs } from './connector-outbox'
import { ConnectorPollClient } from './connector-poll-client'
import { ConnectorAccountTransport } from './connector-transport'
import { ConnectorTurnEvents } from './connector-turn-events'
import { FakeConnectorCloud } from './fake-connector-cloud.test-fixture'
import { fakeMachine, fakeSeam } from './fake-connector-seam.test-fixture'

const NOW = 1_800_000_000_000
const conversation = { source: 'slack', externalId: 'synthetic-team:channel:thread' } as const
const wireTurn = (turnId: number) => ({
  kind: 'turn-ended' as const,
  conversation,
  paneKey: 'synthetic-pane',
  turnId,
  at: NOW + turnId,
  stopReason: 'success' as const,
  lastAssistantMessage: 'synthetic reply'
})
const turn = (turnId: number) => ({ ...wireTurn(turnId), worktreeId: 'synthetic-worktree' })
const heldWrites: { release: () => void; blocking: Promise<void> }[] = []
const clients: ConnectorPollClient[] = []
const published: { owner: string; body: unknown; stored: unknown; recordedBefore: number }[] = []
let userDataPath: string
let fake: FakeConnectorCloud
const outboxPath = () => join(userDataPath, 'connector-turn-outbox.json')

function diskAtPost(): unknown {
  try {
    return JSON.parse(readFileSync(outboxPath(), 'utf8'))
  } catch {
    return null
  }
}

function hasTurn(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    'events' in body &&
    Array.isArray(body.events) &&
    body.events.some((event) => event?.kind === 'turn-ended')
  )
}

function startClient(
  owner = 'original',
  account = 'ada',
  events = new ConnectorTurnEvents(userDataPath, account)
) {
  fake.signedIn.add(account)
  const seam = fakeSeam()
  const fetch: typeof globalThis.fetch = (input, init) => {
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined
    if (new URL(String(input)).pathname === CONNECTOR_PATHS.events && hasTurn(body)) {
      published.push({
        owner,
        body,
        stored: diskAtPost(),
        recordedBefore: fake.requestsTo(CONNECTOR_PATHS.events).length
      })
    }
    return fake.fetch(input, init)
  }
  const client = new ConnectorPollClient({
    transport: new ConnectorAccountTransport(fake.origin, fake.mintFor(account), fetch),
    events,
    seam: seam.seam,
    machine: fakeMachine(() => seam),
    random: () => 0.5
  })
  clients.push(client)
  client.start()
  return { client, events, ...seam }
}

// Pump the existing fake retry clock; never sleep on the wall clock.
async function settle(ms = 0): Promise<void> {
  for (let step = 0; step < 50; step++) {
    await vi.advanceTimersByTimeAsync(ms / 50)
  }
}

async function initialHello(): Promise<void> {
  await settle()
  await drainPendingPathWrites()
  await settle()
  expect(fake.hellos).toHaveLength(1)
  expect(fake.events).toEqual([{ kind: 'snapshot', conversations: [] }])
}

async function holdOutbox() {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const blocking = serializePathWrite(outboxPath(), async () => {
    entered.resolve()
    await release.promise
  })
  const held = { release: () => release.resolve(), blocking }
  heldWrites.push(held)
  await entered.promise
  return held
}

async function releaseOutbox(held: (typeof heldWrites)[number]): Promise<void> {
  held.release()
  await held.blocking
  await drainPendingPathWrites()
  await settle()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'], now: NOW })
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-connector-client-persistence-'))
  fake = new FakeConnectorCloud()
  published.length = 0
})

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.stop()
  }
  fake.release(CONNECTOR_PATHS.events)
  for (const held of heldWrites) {
    held.release()
  }
  await Promise.allSettled(heldWrites.splice(0).map((held) => held.blocking))
  await drainPendingPathWrites()
  await settle()
  vi.restoreAllMocks()
  vi.useRealTimers()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('connector event publication waits for durable outbox state', () => {
  it('writes real turn bytes before fake.fetch records the turn POST', async () => {
    const current = startClient()
    await initialHello()
    const held = await holdOutbox()
    try {
      fake.holdAfter.add(CONNECTOR_PATHS.events)
      current.emit(turn(1))
      await settle()
      expect(existsSync(outboxPath())).toBe(false)
      expect(published).toEqual([])
      expect(fake.requestsTo(CONNECTOR_PATHS.events)).toHaveLength(1)
      await releaseOutbox(held)
      expect(published).toHaveLength(1)
      expect(published[0]).toMatchObject({
        owner: 'original',
        recordedBefore: 1,
        stored: { account: 'ada', turnEnds: [wireTurn(1)] }
      })
      expect(fake.requestsTo(CONNECTOR_PATHS.events)[1]?.body).toEqual(published[0]?.body)
      fake.release(CONNECTOR_PATHS.events)
      await settle()
      await drainPendingPathWrites()
      expect(existsSync(outboxPath())).toBe(false)
    } finally {
      current.client.stop()
      fake.release(CONNECTOR_PATHS.events)
      await releaseOutbox(held)
    }
  })

  it('reports a real write failure and retries the owed turn without another event', async () => {
    const current = startClient()
    await initialHello()
    const accepted = vi.spyOn(current.events, 'accepted')
    const report = vi.fn<(...args: unknown[]) => void>()
    vi.spyOn(console, 'warn').mockImplementation(report)
    vi.spyOn(console, 'error').mockImplementation(report)
    mkdirSync(outboxPath())
    try {
      expect(() => current.emit(turn(2))).not.toThrow()
      await drainPendingPathWrites()
      await settle()
      expect(report.mock.calls.flat().some((value) => value instanceof Error)).toBe(true)
      expect(published).toEqual([])
      expect(fake.requestsTo(CONNECTOR_PATHS.events)).toHaveLength(1)
      expect(accepted).not.toHaveBeenCalled()
      expect(current.events.next(1)?.batch).toEqual([wireTurn(2)])
      rmSync(outboxPath(), { recursive: true })
      fake.holdAfter.add(CONNECTOR_PATHS.events)
      const retryMs = connectorRetryDelayMs(0, UNREADABLE_ANSWER, () => 0.5)
      await vi.advanceTimersByTimeAsync(retryMs - 1)
      expect(published).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      await drainPendingPathWrites()
      await settle()
      expect(published).toHaveLength(1)
      expect(published[0]?.stored).toEqual({ account: 'ada', turnEnds: [wireTurn(2)] })
      expect(accepted).not.toHaveBeenCalled()
      fake.release(CONNECTOR_PATHS.events)
      await settle()
      await drainPendingPathWrites()
      expect(accepted).toHaveBeenCalledOnce()
      expect(current.events.next(1)).toBeNull()
      expect(existsSync(outboxPath())).toBe(false)
    } finally {
      current.client.stop()
      fake.release(CONNECTOR_PATHS.events)
    }
  })

  it('does not POST a captured batch under a superseded hello after its save', async () => {
    const current = startClient()
    await initialHello()
    const held = await holdOutbox()
    try {
      current.emit(turn(5))
      await settle()
      fake.answerPoll({ status: 409, body: { error: 'hello_required' } })
      await settle()
      expect(fake.hellos).toHaveLength(2)
      expect(published).toEqual([])
      await releaseOutbox(held)
      expect(published).toHaveLength(1)
      expect(published[0]).toMatchObject({
        body: { helloRev: 2 },
        stored: { account: 'ada', turnEnds: [wireTurn(5)] }
      })
      expect(
        fake.events.filter(
          (event) =>
            typeof event === 'object' &&
            event !== null &&
            'kind' in event &&
            event.kind === 'turn-ended'
        )
      ).toEqual([wireTurn(5)])
    } finally {
      current.client.stop()
      await releaseOutbox(held)
    }
  })

  it.each(['stop', 'account switch'] as const)(
    'fences a held old-client POST after %s',
    async (reason) => {
      const previous = startClient()
      await initialHello()
      const held = await holdOutbox()
      try {
        previous.emit(turn(3))
        previous.client.stop()
        if (reason === 'account switch') {
          previous.events.clear()
          const next = startClient('replacement', 'grace')
          next.emit(turn(4))
          await settle()
          expect(existsSync(outboxPath())).toBe(false)
          expect(published).toEqual([])
        }
        await releaseOutbox(held)
        if (reason === 'stop') {
          expect(published).toEqual([])
          expect(fake.events).toEqual([{ kind: 'snapshot', conversations: [] }])
          startClient('replacement', 'ada')
          await settle()
          await drainPendingPathWrites()
          await settle()
        }
        expect(fake.hellos).toHaveLength(2)
        expect(published).toHaveLength(1)
        const account = reason === 'stop' ? 'ada' : 'grace'
        expect(published[0]).toMatchObject({
          owner: 'replacement',
          stored: { account, turnEnds: [wireTurn(reason === 'stop' ? 3 : 4)] }
        })
        expect(
          fake.events.filter(
            (event) =>
              typeof event === 'object' &&
              event !== null &&
              'kind' in event &&
              event.kind === 'turn-ended'
          )
        ).toEqual([wireTurn(reason === 'stop' ? 3 : 4)])
        await drainPendingPathWrites()
        expect(existsSync(outboxPath())).toBe(false)
        if (reason === 'account switch') {
          expect(new ConnectorTurnEvents(userDataPath, 'ada').next(2)).toBeNull()
        }
      } finally {
        for (const client of clients) {
          client.stop()
        }
        fake.release(CONNECTOR_PATHS.events)
        await releaseOutbox(held)
      }
    }
  )
})
