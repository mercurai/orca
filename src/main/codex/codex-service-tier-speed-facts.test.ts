// What the host can honestly say about speed: the stored next-turn selection, the exact request each
// turn/start carried and what became of it, and nothing about the tier a server processed. Only the
// app-server connection is faked; options, the catalog store and its disk persistence are real.

import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { spawnProcess } from '../../shared/child-process/run-process'
import { agentModelCatalogSessionAccess } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import { createAgentModelCatalogFilePersistence } from '../native-chat/agent-model-catalog/agent-model-catalog-persistence'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { CodexAcquisitionWindow } from './codex-structured-acquisition-window'
import { openCodexAppServerConnection } from './codex-app-server-connection'
import { CodexAppServerRequestError } from './codex-app-server-request-error'
import { CodexBackgroundTaskTracker } from './codex-background-task-tracker'
import { CODEX_STRUCTURED_AGENT } from './codex-structured-agent-definition'
import { codexSpeedCatalog } from './codex-structured-catalog-entry'
import { createCodexDispatchEchoes } from './codex-structured-dispatch-echo'
import { fetchCodexModelCatalogListing } from './codex-structured-model-catalog'
import {
  applyCodexStructuredSessionOption,
  readLiveCodexSessionOptions,
  restoredCodexSessionOptions
} from './codex-structured-session-options'
import type { CodexSession } from './codex-structured-session-state'
import { dispatchCodexTurn, startCodexTurn } from './codex-structured-turn-start'
import { createCodexTurnOpenWaits } from './codex-structured-turn-open-wait'
import {
  THREAD_ID as ADAPTER_THREAD_ID,
  USER_MESSAGE,
  adapterFor,
  answerWithOpenedTurn,
  fakeCodex,
  identityFor
} from './codex-structured-session-adapter-fixture'

// Synthetic ids throughout: the provider catalog, not Orca, decides which request tiers exist.
const STANDARD = { id: 'default', name: 'Standard', description: 'Regular speed and usage' }
const FAST = { id: 'tier-fast-7f3', name: 'Fast', description: 'Faster responses, more usage' }
const ULTRAFAST = { id: 'tier-ultra-9c1', name: 'Ultrafast', description: 'Fastest, highest usage' }
const CUSTOM = { id: 'tier-custom-5e2', name: 'Custom', description: 'A bounded custom request id' }
const MODEL_A = 'synthetic-model-a'
const MODEL_B = 'synthetic-model-b'
const THREAD_ID = 'thread-1'
const FINGERPRINT = 'codex-test-account'

type TierRow = { id: string; name: string; description: string }
type Rows = Record<string, unknown>[]
// The request options once the transport reports submission; typed here so a variable, not an
// object literal, carries the callback into a signature that does not declare it yet.
type SubmissionOptions = { timeoutMs?: number; onSubmitted?: () => void }

function modelRow(id: string, tiers?: readonly TierRow[]): Record<string, unknown> {
  return {
    model: id,
    displayName: id.toUpperCase(),
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
    defaultReasoningEffort: 'high',
    isDefault: id === MODEL_A,
    ...(tiers ? { serviceTiers: tiers } : {})
  }
}

function message(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

async function listRows(rows: Rows, config: unknown = {}) {
  const request = vi.fn(async (method: string) =>
    method === 'model/list' ? { data: rows, nextCursor: null } : { config }
  )
  return fetchCodexModelCatalogListing({ connection: { request } })
}

async function record(store: AgentModelCatalogStore, fingerprint: string, rows: Rows) {
  const listing = await listRows(rows)
  store.recordSuccess(
    fingerprint,
    'codex',
    {
      models: listing.models,
      fastModeTierByModel: listing.fastModeTierByModel,
      origin: 'live-session'
    },
    'discovery'
  )
}

function sessionFor(
  request: CodexSession['connection']['request'],
  options: Record<string, string>,
  store?: AgentModelCatalogStore,
  fingerprint = FINGERPRINT
): CodexSession {
  return {
    connection: {
      pid: 1,
      closed: false,
      request,
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => true
    },
    backgroundTasks: new CodexBackgroundTaskTracker(THREAD_ID),
    ended: false,
    fence: 1,
    acquisitionGeneration: 'generation-1',
    threadId: THREAD_ID,
    prompts: new CodexAcquisitionWindow().prompts,
    options: new Map(Object.entries(options)),
    reportedOptions: { model: MODEL_A, effort: 'high' },
    dispatchEchoes: createCodexDispatchEchoes(),
    turnOpenWaits: createCodexTurnOpenWaits(),
    activeTurnIds: new Set(),
    translator: null,
    ...(store ? { catalogAccess: { store, fingerprint, accountHomePath: `/${fingerprint}` } } : {})
  }
}

function speedActions(session: CodexSession) {
  return {
    // A dispatch binds the turn it was answered into, so a second one would wait for that turn to
    // open; `send` is the same write without the binding, for sends that only prime the evidence.
    send: (clientMessageId: string) =>
      startCodexTurn(session, { clientMessageId, body: message(clientMessageId) }),
    dispatch: (clientMessageId: string) =>
      dispatchCodexTurn(
        session,
        { sessionId: 'session-1', clientMessageId, body: message(clientMessageId) },
        undefined
      ),
    speed: async () => (await readLiveCodexSessionOptions(session, undefined)).speed
  }
}

async function rig(input: {
  options: Record<string, string>
  rows?: Rows
  turnStart?: () => unknown
}) {
  const requests: { method: string; params?: Record<string, unknown> }[] = []
  const request = vi.fn(
    async (method: string, params?: Record<string, unknown>, options?: SubmissionOptions) => {
      requests.push({ method, params })
      // The simulated write: a transport that submitted the frame says so before any answer.
      options?.onSubmitted?.()
      if (method === 'turn/steer') {
        return { turnId: 'turn-running' }
      }
      if (method === 'turn/start') {
        return input.turnStart ? input.turnStart() : { turn: { id: 'turn-started' } }
      }
      throw new Error(`unexpected ${method}`)
    }
  )
  const store = new AgentModelCatalogStore()
  await record(store, FINGERPRINT, input.rows ?? [modelRow(MODEL_A, [STANDARD, FAST, ULTRAFAST])])
  const session = sessionFor(request, input.options, store)
  return {
    session,
    store,
    requests,
    ...speedActions(session),
    turnStarts: () => requests.filter(({ method }) => method === 'turn/start')
  }
}

const providerRefusal = (): never => {
  throw new CodexAppServerRequestError('turn/start', -32600, 'refused', 'tier not available')
}

type Rig = Awaited<ReturnType<typeof rig>>

// Fast accepted and already requested once; then a bounded custom id the catalog never advertised
// is refused. The marker that holds the refused intent is private, so tests read behavior only.
async function rigWithRefusedCustomTier(rows?: Rows): Promise<Rig> {
  const r = await rig({ options: { model: MODEL_A }, ...(rows ? { rows } : {}) })
  await applyCodexStructuredSessionOption(r.session, 'serviceTier', FAST.id)
  await r.send('m1')
  await expect(
    applyCodexStructuredSessionOption(r.session, 'serviceTier', CUSTOM.id)
  ).rejects.toThrow('is not offered')
  return r
}

async function expectBlockedBeforeAnyRequest(r: Rig, clientMessageId: string): Promise<void> {
  const requestCount = r.requests.length
  await expect(r.dispatch(clientMessageId)).resolves.toMatchObject({ state: 'rejected' })
  expect(r.requests).toHaveLength(requestCount)
}

describe('speed facts for the next turn', () => {
  it('reports the stored selection as ready without claiming any request or processing', async () => {
    const r = await rig({ options: { model: MODEL_A, serviceTier: ULTRAFAST.id } })

    expect(await r.speed()).toEqual({ selection: { tierId: ULTRAFAST.id, state: 'ready' } })
  })

  it('reports an unselected session as unselected', async () => {
    const r = await rig({ options: { model: MODEL_A } })

    expect(await r.speed()).toEqual({ selection: { state: 'unselected' } })
  })

  it('binds an accepted request to its message and turn, with no processing claim', async () => {
    const r = await rig({
      options: { model: MODEL_A, serviceTier: ULTRAFAST.id },
      turnStart: () => ({ turn: { id: 'turn-9' } })
    })

    await expect(r.dispatch('m1')).resolves.toEqual({ state: 'admitted' })

    expect(await r.speed()).toEqual({
      selection: { tierId: ULTRAFAST.id, state: 'ready' },
      lastRequest: {
        clientMessageId: 'm1',
        tierId: ULTRAFAST.id,
        turnId: 'turn-9',
        state: 'accepted'
      },
      applied: { clientMessageId: 'm1', tierId: ULTRAFAST.id, turnId: 'turn-9' }
    })
    expect(await r.speed()).not.toHaveProperty('processing')
  })

  it('keeps the last turn’s evidence when the next-turn selection changes', async () => {
    const r = await rig({ options: { model: MODEL_A, serviceTier: ULTRAFAST.id } })
    await r.dispatch('m1')

    // Only stored intent changed: a setOption acknowledgement is not news about any turn.
    await applyCodexStructuredSessionOption(r.session, 'serviceTier', STANDARD.id)
    const speed = await r.speed()

    expect(speed?.selection).toEqual({ tierId: STANDARD.id, state: 'ready' })
    expect(speed?.lastRequest).toMatchObject({ clientMessageId: 'm1', tierId: ULTRAFAST.id })
    expect(speed?.applied).toMatchObject({ clientMessageId: 'm1', tierId: ULTRAFAST.id })
  })

  it('leaves a steer out of the evidence because a steer carries no speed', async () => {
    const r = await rig({ options: { model: MODEL_A, serviceTier: ULTRAFAST.id } })
    r.session.activeTurnIds?.add('turn-running')

    await r.dispatch('during')

    expect(r.turnStarts()).toEqual([])
    expect((await r.speed())?.lastRequest).toBeUndefined()
  })
})

describe('what a failed request does to the evidence', () => {
  it('labels a definite provider refusal rejected, with its bounded words, and keeps prior applied', async () => {
    let refuse = false
    const r = await rig({
      options: { model: MODEL_A, serviceTier: ULTRAFAST.id },
      turnStart: () => (refuse ? providerRefusal() : { turn: { id: 'turn-ok' } })
    })
    await r.send('m1')
    refuse = true

    await expect(r.dispatch('m2')).resolves.toMatchObject({ state: 'rejected' })

    const speed = await r.speed()
    expect(speed?.lastRequest).toEqual({
      clientMessageId: 'm2',
      tierId: ULTRAFAST.id,
      state: 'rejected',
      detail: 'tier not available'
    })
    expect(speed?.applied).toEqual({
      clientMessageId: 'm1',
      tierId: ULTRAFAST.id,
      turnId: 'turn-ok'
    })
    expect(speed?.selection).toEqual({ tierId: ULTRAFAST.id, state: 'ready' })
  })

  it('leaves an unknown delivery sent, neither accepted nor rejected, and never resends', async () => {
    const r = await rig({
      options: { model: MODEL_A, serviceTier: ULTRAFAST.id },
      turnStart: () => {
        throw new Error('socket closed before an answer')
      }
    })

    // Not a definite refusal: the frame may have been written, so the dispatch stays uncertain.
    await expect(r.dispatch('m1')).rejects.toThrow('socket closed')

    expect((await r.speed())?.lastRequest).toEqual({
      clientMessageId: 'm1',
      tierId: ULTRAFAST.id,
      state: 'sent'
    })
    expect((await r.speed())?.applied).toBeUndefined()
    expect(r.turnStarts()).toHaveLength(1)
  })

  it('records a refusal before the write as rejected and keeps the stored selection', async () => {
    const r = await rig({ options: { model: MODEL_A, serviceTier: ULTRAFAST.id } })
    await r.send('m1')
    await record(r.store, FINGERPRINT, [modelRow(MODEL_A, [STANDARD, FAST])])

    await expect(r.dispatch('m2')).resolves.toMatchObject({ state: 'rejected' })

    const speed = await r.speed()
    expect(speed?.selection).toEqual({ tierId: ULTRAFAST.id, state: 'unavailable' })
    expect(speed?.lastRequest).toMatchObject({
      clientMessageId: 'm2',
      tierId: ULTRAFAST.id,
      state: 'rejected',
      detail: expect.stringContaining('not offered')
    })
    expect(speed?.applied).toMatchObject({ clientMessageId: 'm1' })
    expect(r.turnStarts()).toHaveLength(1)
    expect(r.session.options.get('serviceTier')).toBe(ULTRAFAST.id)
  })

  it('bounds a provider’s diagnostic stored with a rejection', async () => {
    const r = await rig({
      options: { model: MODEL_A, serviceTier: ULTRAFAST.id },
      turnStart: () => {
        throw new CodexAppServerRequestError('turn/start', -32600, 'refused', 'x'.repeat(5_000))
      }
    })

    await r.dispatch('m1')

    expect((await r.speed())?.lastRequest?.detail?.length).toBeLessThanOrEqual(512)
  })
})

function readFrame(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`the stub child was written a non-object frame: ${line}`)
  }
  return Object.fromEntries(Object.entries(parsed))
}

// A child whose stdin is a real Writable with a one-byte high-water mark, so every `write` reports
// backpressure (false) exactly as a saturated pipe does, while still delivering each frame.
class StubChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin: Writable
  // Outside any real process table so teardown never mistakes an unrelated process for it.
  readonly pid = 9_999_999
  readonly kill = vi.fn(() => true)

  constructor(onFrame: (frame: Record<string, unknown>) => void) {
    super()
    this.stdin = new Writable({
      highWaterMark: 1,
      write: (chunk, _encoding, done) => {
        for (const line of String(chunk).split('\n')) {
          if (line.trim()) {
            onFrame(readFrame(line))
          }
        }
        done()
      }
    })
    this.stdin.on('finish', () => this.emit('exit', 0, null))
  }
}

// The real connection over a scripted child: its closed / terminal / exited guards are what decide
// whether a frame is ever serialized, so they cannot be stood in for by a mocked request.
async function openRealConnection() {
  const written: Record<string, unknown>[] = []
  const child: StubChild = new StubChild((frame) => {
    written.push(frame)
    if (frame.method === 'initialize') {
      child.stdout.write(`${JSON.stringify({ id: frame.id, result: {} })}\n`)
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The connection reads only events, pid, streams and kill from this stub.
  const spawnImpl = (() => child) as unknown as typeof spawnProcess
  const connection = await openCodexAppServerConnection(
    { command: 'codex', args: ['app-server'] },
    {},
    spawnImpl
  )
  return { child, connection, written }
}

async function realConnectionRig(options: Record<string, string>) {
  const store = new AgentModelCatalogStore()
  await record(store, FINGERPRINT, [modelRow(MODEL_A, [STANDARD, FAST, ULTRAFAST])])
  const { child, connection, written } = await openRealConnection()
  const session = { ...sessionFor(connection.request, options, store), connection }
  return {
    child,
    connection,
    session,
    ...speedActions(session),
    turnStartFrame: () => written.find((frame) => frame.method === 'turn/start'),
    frameCount: () => written.length
  }
}

type RealRig = Awaited<ReturnType<typeof realConnectionRig>>

// The three ways a connection is already unusable before a frame is serialized.
const ENDINGS: [string, (r: Pick<RealRig, 'child' | 'connection'>) => unknown][] = [
  ['closed by its owner', (r) => r.connection.close()],
  [
    'failed with a terminal transport error',
    (r) => r.child.emit('error', new Error('provider transport failed'))
  ],
  [
    'exited',
    (r) => {
      r.child.emit('exit', 1, null)
      r.child.emit('close', 1, null)
    }
  ]
]

async function answerTurnStart(r: RealRig, turnId: string): Promise<void> {
  await vi.waitFor(() => expect(r.turnStartFrame()).toBeDefined())
  r.child.stdout.write(
    `${JSON.stringify({ id: r.turnStartFrame()?.id, result: { turn: { id: turnId } } })}\n`
  )
}

const WRITE_FAILED = { state: 'rejected', rejection: { kind: 'writeFailed' } }

describe('a speed request on the real app-server connection', () => {
  it('is sent, then accepted with the turn the provider answered', async () => {
    const r = await realConnectionRig({ model: MODEL_A, serviceTier: ULTRAFAST.id })

    const dispatching = r.dispatch('m1')
    await vi.waitFor(() => expect(r.turnStartFrame()).toBeDefined())

    expect(r.turnStartFrame()?.params).toMatchObject({ serviceTier: ULTRAFAST.id })
    // `sent` lands when the transport reports the submission, which follows the write.
    await vi.waitFor(async () =>
      expect((await r.speed())?.lastRequest).toEqual({
        clientMessageId: 'm1',
        tierId: ULTRAFAST.id,
        state: 'sent'
      })
    )
    await answerTurnStart(r, 'turn-real')
    await expect(dispatching).resolves.toEqual({ state: 'admitted' })

    expect((await r.speed())?.lastRequest).toEqual({
      clientMessageId: 'm1',
      tierId: ULTRAFAST.id,
      turnId: 'turn-real',
      state: 'accepted'
    })
    await r.connection.close()
  })

  it.each(ENDINGS)(
    'is a definite write failure with no frame and no sent tier when the connection was %s',
    async (_name, end) => {
      const r = await realConnectionRig({ model: MODEL_A, serviceTier: ULTRAFAST.id })
      expect(r.connection.closed).toBe(false)
      await end(r)
      expect(r.connection.closed).toBe(true)
      const framesBefore = r.frameCount()

      await expect(r.dispatch('m1')).resolves.toMatchObject(WRITE_FAILED)

      // Refused before serialization: nothing reached the provider, so nothing is "sent" and the
      // attempt, though the newest, is a refusal rather than an execution.
      expect(r.frameCount()).toBe(framesBefore)
      expect(r.turnStartFrame()).toBeUndefined()
      const speed = await r.speed()
      expect(speed?.lastRequest).toMatchObject({
        clientMessageId: 'm1',
        tierId: ULTRAFAST.id,
        state: 'rejected'
      })
      expect(speed?.lastRequest).not.toHaveProperty('turnId')
      expect(speed?.applied).toBeUndefined()
      expect(speed?.selection).toEqual({ tierId: ULTRAFAST.id, state: 'ready' })
      await r.connection.close()
    }
  )

  it('keeps the accepted turn applied when the next attempt is refused after the close', async () => {
    const r = await realConnectionRig({ model: MODEL_A, serviceTier: ULTRAFAST.id })
    // `send` is the unbound write: a bound dispatch would make the second wait for that turn to open.
    const first = r.send('m1')
    await answerTurnStart(r, 'turn-real')
    await first
    await r.connection.close()
    const framesBefore = r.frameCount()

    await expect(r.dispatch('m2')).resolves.toMatchObject(WRITE_FAILED)

    expect(r.frameCount()).toBe(framesBefore)
    const speed = await r.speed()
    expect(speed?.lastRequest).toMatchObject({
      clientMessageId: 'm2',
      tierId: ULTRAFAST.id,
      state: 'rejected'
    })
    expect(speed?.lastRequest).not.toHaveProperty('turnId')
    expect(speed?.applied).toEqual({
      clientMessageId: 'm1',
      tierId: ULTRAFAST.id,
      turnId: 'turn-real'
    })
    expect(speed?.selection).toEqual({ tierId: ULTRAFAST.id, state: 'ready' })
  })

  it('stays sent, neither accepted nor rejected, when the pipe fails after the write', async () => {
    const r = await realConnectionRig({ model: MODEL_A, serviceTier: ULTRAFAST.id })
    const dispatching = r.dispatch('m1')
    await vi.waitFor(() => expect(r.turnStartFrame()).toBeDefined())

    r.child.stdin.emit('error', new Error('write EPIPE'))

    // The frame was written, so it may have been delivered: uncertain, never a definite refusal.
    await expect(dispatching).rejects.toThrow()
    const speed = await r.speed()
    expect(speed?.lastRequest).toEqual({
      clientMessageId: 'm1',
      tierId: ULTRAFAST.id,
      state: 'sent'
    })
    expect(speed?.applied).toBeUndefined()
    await r.connection.close()
  })

  it('does not fall back to turn/start when the steer was refused before the write', async () => {
    const r = await realConnectionRig({ model: MODEL_A, serviceTier: ULTRAFAST.id })
    r.session.activeTurnIds?.add('turn-running')
    await r.connection.close()
    const framesBefore = r.frameCount()

    await expect(r.dispatch('during')).resolves.toMatchObject(WRITE_FAILED)

    expect(r.frameCount()).toBe(framesBefore)
    expect(r.turnStartFrame()).toBeUndefined()
    expect((await r.speed())?.lastRequest).toBeUndefined()
  })
})

describe('the transport boundary where a frame counts as submitted', () => {
  it('fails serialization before the callback and before any write', async () => {
    const { connection, written } = await openRealConnection()
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const onSubmitted = vi.fn()
    const options: SubmissionOptions = { onSubmitted }
    const framesBefore = written.length

    await expect(connection.request('turn/start', circular, options)).rejects.toThrow()

    expect(onSubmitted).not.toHaveBeenCalled()
    expect(written).toHaveLength(framesBefore)
    await connection.close()
  })

  it.each(ENDINGS)(
    'never calls back or writes for a request made after the connection was %s',
    async (_name, end) => {
      const { child, connection, written } = await openRealConnection()
      await end({ child, connection })
      const framesBefore = written.length
      const onSubmitted = vi.fn()
      const options: SubmissionOptions = { onSubmitted }

      await expect(
        connection.request('turn/start', { threadId: THREAD_ID }, options)
      ).rejects.toThrow()

      expect(onSubmitted).not.toHaveBeenCalled()
      expect(written).toHaveLength(framesBefore)
      await connection.close()
    }
  )

  it('calls back once, after the frame is written, even when stdin reports backpressure', async () => {
    const { child, connection, written } = await openRealConnection()
    const write = vi.spyOn(child.stdin, 'write')
    const framesAtCallback: number[] = []
    const options: SubmissionOptions = {
      onSubmitted: () => {
        framesAtCallback.push(written.length)
      }
    }
    const framesBefore = written.length

    const pending = connection.request('turn/start', { threadId: THREAD_ID }, options)
    await vi.waitFor(() => expect(framesAtCallback).toEqual([framesBefore + 1]))

    expect(write).toHaveLastReturnedWith(false)
    child.stdout.write(`${JSON.stringify({ id: written.at(-1)?.id, result: {} })}\n`)
    await expect(pending).resolves.toEqual({})
    expect(framesAtCallback).toHaveLength(1)
    await connection.close()
  })
})

describe('account isolation', () => {
  it('judges each session by the catalog of the account it was pinned to', async () => {
    const store = new AgentModelCatalogStore()
    await record(store, 'account-a', [modelRow(MODEL_A, [STANDARD, FAST, ULTRAFAST])])
    await record(store, 'account-b', [modelRow(MODEL_A, [STANDARD, FAST])])
    const requests: string[] = []
    const request = vi.fn(async (method: string) => {
      requests.push(method)
      return { turn: { id: 'turn-1' } }
    })
    const options = { model: MODEL_A, serviceTier: ULTRAFAST.id }
    const a = sessionFor(request, options, store, 'account-a')
    const b = sessionFor(request, options, store, 'account-b')
    const send = (session: CodexSession) =>
      dispatchCodexTurn(
        session,
        { sessionId: 's', clientMessageId: 'm', body: message('m') },
        undefined
      )

    await expect(send(a)).resolves.toEqual({ state: 'admitted' })
    await expect(send(b)).resolves.toMatchObject({ state: 'rejected' })

    // B's later refresh cannot widen or narrow A.
    await record(store, 'account-b', [modelRow(MODEL_A, [STANDARD, FAST])])
    const advertisedToA = codexSpeedCatalog(a.catalogAccess).models[0]?.serviceTiers
    expect(advertisedToA?.map((tier) => tier.value)).toEqual([STANDARD.id, FAST.id, ULTRAFAST.id])
    expect(requests).toEqual(['turn/start'])
  })

  it('treats an account that was never listed as unknown, not Standard-only', async () => {
    const store = new AgentModelCatalogStore()

    expect(codexSpeedCatalog({ store, fingerprint: 'never', accountHomePath: '/never' })).toEqual({
      models: [],
      known: false
    })
    expect(codexSpeedCatalog(undefined)).toEqual({ models: [], known: false })
  })
})

describe('configured launch defaults', () => {
  it('keep every advertised tier and make no speed selection of their own', async () => {
    const listing = await listRows(
      [modelRow(MODEL_A, [STANDARD, FAST]), modelRow(MODEL_B, [STANDARD, FAST, ULTRAFAST])],
      { model: MODEL_B, model_reasoning_effort: 'high', service_tier: ULTRAFAST.id }
    )

    const [a, b] = listing.models
    expect(b).toMatchObject({ id: MODEL_B, isDefault: true })
    expect(a?.isDefault).toBe(false)
    expect(a?.serviceTiers?.map((tier) => tier.value)).toEqual([STANDARD.id, FAST.id])
    expect(b?.serviceTiers?.map((tier) => tier.value)).toEqual([
      STANDARD.id,
      FAST.id,
      ULTRAFAST.id
    ])
  })

  it('send no speed override for a session that never chose one', async () => {
    const r = await rig({ options: { model: MODEL_A } })

    await r.dispatch('m1')

    expect(r.turnStarts()[0]?.params).not.toHaveProperty('serviceTier')
    expect(r.turnStarts()[0]?.params).not.toHaveProperty('fastMode')
    expect((await r.speed())?.lastRequest).toBeUndefined()
  })

  it('cannot displace an explicit canonical choice, which rides every turn/start', async () => {
    const r = await rig({ options: { model: MODEL_A, serviceTier: FAST.id } })
    // A thread that reports another tier (for instance from launch config) is routing, not choice.
    r.session.reportedOptions.serviceTier = ULTRAFAST.id
    r.session.reportedOptions.serviceTierKnown = true

    expect((await readLiveCodexSessionOptions(r.session, undefined)).current).toMatchObject({
      serviceTier: FAST.id
    })
    await r.send('m1')
    await r.send('m2')

    expect(r.turnStarts().map(({ params }) => params?.serviceTier)).toEqual([FAST.id, FAST.id])
  })
})

describe('a saved selection through the real catalog store and a resumed conversation', () => {
  it('survives disk persistence and reaches the resumed thread’s next turn exactly', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'codex-speed-'))
    const first = new AgentModelCatalogStore()
    await first.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    const access = agentModelCatalogSessionAccess(first, CODEX_STRUCTURED_AGENT, '/codex/home')!
    await record(first, access.fingerprint, [modelRow(MODEL_A, [STANDARD, FAST, ULTRAFAST])])
    await first.flushPersistence()

    const restarted = new AgentModelCatalogStore()
    await restarted.attachPersistence(createAgentModelCatalogFilePersistence(directory))
    const codex = fakeCodex()
    codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'turn-resumed')
    const adapter = adapterFor(
      codex,
      { codexHome: '/codex/home', resumeThreadId: ADAPTER_THREAD_ID },
      [],
      { modelCatalog: restarted }
    )
    await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-resume',
      options: { model: MODEL_A, serviceTier: ULTRAFAST.id }
    })

    const calls = codex.connections[0].calls
    expect(calls.map((call) => call.method)).toContain('thread/resume')
    expect(calls.map((call) => call.method)).not.toContain('thread/start')
    expect(adapter.readAcquisitionOptions({ sessionId: 'session-1', fence: 7 })).toMatchObject({
      model: MODEL_A,
      serviceTier: ULTRAFAST.id
    })
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'first',
        body: USER_MESSAGE,
        fence: 7
      })
    ).resolves.toEqual({ state: 'admitted' })

    const start = calls.find((call) => call.method === 'turn/start')
    expect(start?.params).toMatchObject({ threadId: ADAPTER_THREAD_ID, serviceTier: ULTRAFAST.id })
    // The hydrated entry already vouches for the tier, so nothing re-lists to send it.
    expect(calls.some((call) => call.method === 'model/list')).toBe(false)
  })
})

describe('an explicit serviceTier write on the live path', () => {
  it('stores nothing and reports nothing when the catalog does not advertise the tier', async () => {
    const r = await rig({
      options: { model: MODEL_A },
      rows: [modelRow(MODEL_A, [STANDARD, FAST])]
    })

    await expect(
      applyCodexStructuredSessionOption(r.session, 'serviceTier', ULTRAFAST.id)
    ).rejects.toThrow('is not offered')

    expect(r.session.options.has('serviceTier')).toBe(false)
    expect(await r.speed()).toEqual({ selection: { state: 'unselected' } })
  })

  it('is applied on the next startCodexTurn only after the host stored it', async () => {
    const r = await rig({ options: { model: MODEL_A } })

    await applyCodexStructuredSessionOption(r.session, 'serviceTier', FAST.id)
    await startCodexTurn(r.session, { clientMessageId: 'm1', body: message('m1') })

    expect(r.turnStarts()[0]?.params).toMatchObject({ serviceTier: FAST.id })
  })
})

describe('an explicit tier refused after an accepted one', () => {
  it('keeps the accepted tier canonical and reports the refused one as blocked', async () => {
    const r = await rigWithRefusedCustomTier()

    expect(r.session.options.get('serviceTier')).toBe(FAST.id)
    const options = await readLiveCodexSessionOptions(r.session, undefined)
    expect(options.current.serviceTier).toBe(FAST.id)
    expect(options.speed?.selection.tierId).toBe(CUSTOM.id)
    expect(['unknown', 'unavailable']).toContain(options.speed?.selection.state)
    expect(options.speed?.applied).toMatchObject({ clientMessageId: 'm1', tierId: FAST.id })
  })

  it('blocks the next turn/start before any provider request, with no Fast fallback', async () => {
    const r = await rigWithRefusedCustomTier()
    const requestCount = r.requests.length

    await expectBlockedBeforeAnyRequest(r, 'm2')
    await expect(r.send('m3')).rejects.toThrow()

    expect(r.requests).toHaveLength(requestCount)
    expect(r.turnStarts()).toHaveLength(1)
  })

  it('stays blocked after the model changes', async () => {
    const r = await rigWithRefusedCustomTier([
      modelRow(MODEL_A, [STANDARD, FAST, ULTRAFAST]),
      modelRow(MODEL_B, [STANDARD, FAST, ULTRAFAST])
    ])

    await applyCodexStructuredSessionOption(r.session, 'model', MODEL_B)

    await expectBlockedBeforeAnyRequest(r, 'm2')
  })

  it('stays blocked after the effort changes', async () => {
    const r = await rigWithRefusedCustomTier()

    await applyCodexStructuredSessionOption(r.session, 'effort', 'high')

    await expectBlockedBeforeAnyRequest(r, 'm2')
  })

  it('stays blocked after a refresh, even one that now offers the refused id', async () => {
    const r = await rigWithRefusedCustomTier()

    await record(r.store, FINGERPRINT, [modelRow(MODEL_A, [STANDARD, FAST, ULTRAFAST, CUSTOM])])
    await r.speed()

    await expectBlockedBeforeAnyRequest(r, 'm2')
  })

  it('stays blocked in a session restored from the full current option map', async () => {
    const r = await rigWithRefusedCustomTier()
    const restored = restoredCodexSessionOptions(Object.fromEntries(r.session.options))
    const resumed = sessionFor(r.session.connection.request, Object.fromEntries(restored), r.store)
    const requestCount = r.requests.length

    await expect(
      dispatchCodexTurn(
        resumed,
        { sessionId: 'session-1', clientMessageId: 'resumed', body: message('resumed') },
        undefined
      )
    ).resolves.toMatchObject({ state: 'rejected' })

    expect(r.requests).toHaveLength(requestCount)
    expect(restored.get('serviceTier')).toBe(FAST.id)
    const options = await readLiveCodexSessionOptions(resumed, undefined)
    expect(options.speed?.selection.tierId).toBe(CUSTOM.id)
  })

  it.each([STANDARD.id, ULTRAFAST.id])(
    'clears only on an explicit valid replacement (%s), and the same session then sends it',
    async (tierId) => {
      const r = await rigWithRefusedCustomTier()
      await expectBlockedBeforeAnyRequest(r, 'blocked')

      await applyCodexStructuredSessionOption(r.session, 'serviceTier', tierId)

      await expect(r.dispatch('m2')).resolves.toEqual({ state: 'admitted' })
      const params = r.turnStarts().at(-1)?.params
      expect(r.turnStarts()).toHaveLength(2)
      expect(params).toMatchObject({ threadId: THREAD_ID, serviceTier: tierId })
      // Only the provider's own request fields: the refused intent is bookkeeping, never a parameter.
      expect(Object.keys(params ?? {}).sort()).toEqual([
        'clientUserMessageId',
        'input',
        'model',
        'serviceTier',
        'threadId'
      ])
      expect(JSON.stringify(params)).not.toContain(CUSTOM.id)
      const stored = [...r.session.options.values()]
      expect(stored.some((value) => value.includes(CUSTOM.id))).toBe(false)
      expect((await r.speed())?.selection).toEqual({ tierId, state: 'ready' })
    }
  )
})
