// @vitest-environment happy-dom

// A Codex speed pick and the chat's sends, on the client: the real options hook and central sender;
// only RPC, composer-draft and capability boundaries are replaced. A pick the host has not
// acknowledged, and one it refused, must keep every send out so none goes at the prior speed, with
// the typed text still the person's to retry. The queue's Send now and Resume are driven through the
// real session controller in `use-structured-agent-session.queued-gating.test.tsx`.

import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'

type SendParams = { envelope?: { clientOperationId?: string }; value?: unknown }

const mocks = vi.hoisted(() => ({
  call: vi.fn<(target: unknown, method: string, params?: SendParams) => Promise<unknown>>(),
  history: vi.fn<() => Promise<unknown>>(),
  compatible: vi.fn<(environmentId: string) => Promise<void>>(),
  envSupports: vi.fn<(environmentId: string, capability: string) => Promise<boolean>>(),
  handBack: vi.fn<(...args: unknown[]) => boolean>(),
  speedSupport: vi.fn<() => Promise<'supported' | 'unsupported' | 'unknown'>>(),
  toastError: vi.fn<(message: string) => void>()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  readStructuredAgentSessionCodexSpeedSupport: mocks.speedSupport
}))

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClientModule>()),
  ensureRuntimeEnvironmentCompatible: mocks.compatible,
  runtimeEnvironmentSupportsCapability: mocks.envSupports
}))

vi.mock('./structured-agent-session-message-hand-back', () => ({
  handBackStructuredAgentSessionMessage: mocks.handBack
}))

vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: vi.fn()
}))

vi.mock('@/lib/structured-agent-session-launch-options', () => ({
  holdStructuredAgentSessionLaunchOption: () => null,
  getStructuredAgentSessionLaunchSelection: () => null
}))

// The real session controller reads the host's journal and sends through these two hooks; only
// they are replaced, so its options hook, mutation seam and queued-card controls run as shipped.
const QUEUED_DRAFT = {
  messageId: 'draft-1',
  position: 1,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'queued draft-1' }] },
  state: 'waiting'
}
const READ_STATE = {
  fence: 3,
  items: [],
  submissions: [],
  status: 'ready',
  error: null,
  hasOlder: false,
  queuedMessages: [QUEUED_DRAFT],
  nextQueuedMessageId: null
}

vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: READ_STATE,
    loadingOlder: false,
    loadOlder: vi.fn()
  })
}))

vi.mock('./use-structured-agent-session-sends', () => ({
  useStructuredAgentSessionSends: () => ({
    pending: [],
    error: null,
    send: vi.fn(),
    stopSends: vi.fn()
  })
}))

import {
  AGENT_SESSION_CODEX_SERVICE_TIERS_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache
} from './native-chat-draft-cache'
import { useStructuredAgentSession } from './use-structured-agent-session'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/host-model-catalog-snapshots'
import {
  reserveStructuredAgentSessionSend,
  resetStructuredAgentSessionSendsForTests,
  sendStructuredAgentSessionMessage
} from './structured-agent-session-message-sender'
import { structuredAgentSessionSendOut } from './structured-agent-session-pending-sends'
import {
  forgetStructuredAgentSessionFence,
  noteStructuredAgentSessionFence
} from './structured-agent-session-send-attempt'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'

const SESSION = 'session-1'
const LOCAL_TARGET = { kind: 'local' } as const
const PAIRED_TARGET = { kind: 'environment', environmentId: 'server-1' } as const
type Target = typeof LOCAL_TARGET | typeof PAIRED_TARGET

const MODEL_ID = 'synthetic-speed-model'
const STANDARD = { value: 'default', label: 'Standard' }
const FAST = { value: 'synthetic-fast-lane', label: 'Fast' }
const ULTRAFAST = { value: 'synthetic-ultra-lane', label: 'Ultrafast' }
const PENDING_ULTRAFAST = { kind: 'pending', label: 'Ultrafast' }
const RESERVED_TEXT = 'reserved launch prompt'

const HOST_MODELS = {
  models: [
    {
      id: MODEL_ID,
      label: 'Synthetic Speed Model',
      isDefault: true,
      efforts: [],
      supportsFastMode: true,
      serviceTiers: [STANDARD, FAST, ULTRAFAST]
    }
  ],
  fastModeSupport: { supported: true }
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

// The host's stored next-turn tier: Fast until a write it accepted says otherwise.
let hostTier = FAST.value

const CUSTOM = { value: 'synthetic-custom-lane', label: 'Custom lane' }
// A tier the host refused before this client existed: only its facts say so, current stays accepted.
const hostRefused: { tierId: string | null; catalogOffersIt: boolean } = {
  tierId: null,
  catalogOffersIt: false
}

// The live catalog and the resting read report the stored tier in `current` and name no `confirmed`
// list; the host's own ready selection fact then says what it stored.
let hostOmitsConfirmed = false

// A read the test holds open: the first `agentSession.options` request after it is set waits on it.
type HeldRead = Deferred<unknown> & { taken: boolean }
let heldRead: HeldRead | null = null

function hostSpeedFacts(): { speed?: unknown } {
  if (hostRefused.tierId) {
    return { speed: { selection: { tierId: hostRefused.tierId, state: 'unavailable' } } }
  }
  return hostOmitsConfirmed ? { speed: { selection: { tierId: hostTier, state: 'ready' } } } : {}
}

function optionsReply() {
  const { tierId, catalogOffersIt } = hostRefused
  return {
    ...HOST_MODELS,
    models: HOST_MODELS.models.map((model) => ({
      ...model,
      serviceTiers: [...model.serviceTiers, ...(tierId && catalogOffersIt ? [CUSTOM] : [])]
    })),
    current: {
      model: MODEL_ID,
      serviceTier: hostTier,
      ...(hostOmitsConfirmed ? {} : { confirmed: ['model', 'serviceTier'] })
    },
    ...hostSpeedFacts()
  }
}

function recordedSend(clientMessageId: string) {
  return {
    ok: true,
    replayed: false,
    fence: 4,
    cursor: { epoch: 'e', sequence: 1 },
    value: {
      clientMessageId,
      submission: { clientMessageId, dispatchState: 'accepted', submittedAt: 1 }
    }
  }
}

function answerRpc(_target: unknown, method: string, params?: SendParams): Promise<unknown> {
  if (method === 'agentSession.options') {
    if (heldRead && !heldRead.taken) {
      heldRead.taken = true
      return heldRead.promise
    }
    return Promise.resolve(optionsReply())
  }
  if (method === 'agentSession.history') {
    return mocks.history()
  }
  if (method === 'agentSession.send') {
    return Promise.resolve(recordedSend(params?.envelope?.clientOperationId ?? ''))
  }
  return new Promise(() => {})
}

type Write = { value: string; reply: Deferred<unknown> }

// Each `agentSession.setOption` waits for the test's answer.
const writes: Write[] = []

const mutate = vi.fn(
  async (_method: string, _fingerprintMethod: string, fields: Record<string, unknown>) => {
    const write = { value: String(fields.value), reply: deferred<unknown>() }
    writes.push(write)
    return write.reply.promise
  }
)
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scripted answer is the AgentSessionOptionResult (or null) the options hook reads; generic erasure cannot express that.
const scriptedMutate = mutate as unknown as StructuredAgentSessionMutate

type Props = { paired?: boolean; turnId?: string | null }

function renderChat(initial: Props = {}) {
  return renderHook(
    (props: Props) => ({
      options: useStructuredAgentSessionOptions({
        agent: 'codex',
        sessionId: SESSION,
        target: props.paired ? PAIRED_TARGET : LOCAL_TARGET,
        transportEnabled: true,
        isVisible: true,
        providerVisible: true,
        fence: 1,
        turnId: props.turnId ?? null,
        unloadedTurnRevisions: undefined,
        mutate: scriptedMutate
      })
    }),
    { initialProps: initial }
  )
}

type Chat = ReturnType<typeof renderChat>

function tierDescriptor(chat: Chat) {
  return chat.result.current.options.optionSnapshot.find((entry) => entry.id === 'serviceTier')
}

function speedLines(chat: Chat) {
  return chat.result.current.options.optionSurface.getSpeedLines()
}

async function mountChat(initial: Props = {}): Promise<Chat> {
  const chat = renderChat(initial)
  await waitFor(() => expect(tierDescriptor(chat)).toBeDefined())
  return chat
}

/** Starts a pick and returns with only its synchronous part run. */
function pick(chat: Chat, value: string): Promise<boolean> {
  let outcome: Promise<boolean> = Promise.resolve(false)
  act(() => {
    outcome = chat.result.current.options.setStructuredOption('serviceTier', value)
  })
  return outcome
}

function writeAt(index: number): Write {
  const write = writes[index]
  if (!write) {
    throw new Error(`no setOption write #${index}`)
  }
  return write
}

/** The host stores the tier and says so. */
async function acceptWrite(index: number, outcome: Promise<boolean>): Promise<void> {
  await waitFor(() => expect(writes.length).toBeGreaterThan(index))
  const { value, reply } = writeAt(index)
  hostTier = value
  hostRefused.tierId = null
  await act(async () => {
    reply.resolve({ key: 'serviceTier', value, options: { serviceTier: value } })
    await outcome
  })
}

/** The host refuses (or the write fails): the mutate wrapper has already toasted and answers null. */
async function refuseWrite(index: number, outcome: Promise<boolean>): Promise<void> {
  await waitFor(() => expect(writes.length).toBeGreaterThan(index))
  await act(async () => {
    writeAt(index).reply.resolve(null)
    await outcome
  })
}

function sendRpcs() {
  return mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.send')
}

function optionsReads(): number {
  return mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.options').length
}

function tryOrdinarySend(text: string, target: Target = LOCAL_TARGET) {
  return sendStructuredAgentSessionMessage({ sessionId: SESSION, target, text })
}

/** An ordinary send to `target` is not taken, so the typed text stays in the box, and no request
 *  went out to any host. */
function expectChatBlocked(text = 'typed meanwhile', target: Target = LOCAL_TARGET): void {
  expect(structuredAgentSessionSendOut(SESSION)).toBe(true)
  expect(tryOrdinarySend(text, target)).toBeNull()
  expect(sendRpcs()).toHaveLength(0)
}

/** The chat takes the text and sends it as one request, then holds nothing. */
async function expectChatTakesSend(text: string, target: Target = LOCAL_TARGET): Promise<void> {
  const sent = tryOrdinarySend(text, target)
  expect(sent).not.toBeNull()
  await expect(sent?.outcome).resolves.toBe('recorded')
  expect(sendRpcs()).toHaveLength(1)
  expect(sendRpcs()[0]?.[2]).toMatchObject({ body: { blocks: [{ type: 'text', text }] } })
  expect(structuredAgentSessionSendOut(SESSION)).toBe(false)
}

describe('Codex speed pick and the chat sends', () => {
  beforeEach(() => {
    writes.length = 0
    hostTier = FAST.value
    hostRefused.tierId = null
    hostRefused.catalogOffersIt = false
    hostOmitsConfirmed = false
    heldRead = null
    mutate.mockClear()
    mocks.call.mockReset()
    mocks.history.mockReset()
    mocks.compatible.mockReset()
    mocks.envSupports.mockReset()
    mocks.handBack.mockReset()
    mocks.speedSupport.mockReset()
    mocks.toastError.mockReset()
    mocks.call.mockImplementation(answerRpc)
    mocks.history.mockResolvedValue({ ok: true, page: { fence: 4 } })
    mocks.compatible.mockResolvedValue(undefined)
    mocks.envSupports.mockResolvedValue(true)
    mocks.handBack.mockReturnValue(true)
    mocks.speedSupport.mockResolvedValue('supported')
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_CODEX_SERVICE_TIERS_RUNTIME_CAPABILITY])
    resetHostModelCatalogSnapshotsForTests()
    noteStructuredAgentSessionFence(SESSION, 4)
  })

  afterEach(() => {
    cleanup()
    resetStructuredAgentSessionSendsForTests()
    setLocalRuntimeCapabilitiesForTests(null)
  })

  it('takes the chat sends and shows the attempted tier from the pick, before the capability answer', async () => {
    const chat = await mountChat()
    const capability = deferred<'supported'>()
    mocks.speedSupport.mockReturnValue(capability.promise)

    const outcome = pick(chat, ULTRAFAST.value)

    expectChatBlocked()
    expect(writes).toHaveLength(0)
    expect(speedLines(chat)).toContainEqual(PENDING_ULTRAFAST)

    await act(async () => {
      capability.resolve('supported')
    })
    await waitFor(() => expect(writes).toHaveLength(1))
    expectChatBlocked()
    await refuseWrite(0, outcome)
  })

  it('keeps sends out and the attempted tier visible after the host refuses it, while the host stays on Fast', async () => {
    const chat = await mountChat()
    const outcome = pick(chat, ULTRAFAST.value)
    await refuseWrite(0, outcome)
    expect(await outcome).toBe(false)
    expectChatBlocked()

    const reads = optionsReads()
    chat.rerender({ turnId: 'turn-2' })
    await waitFor(() => expect(optionsReads()).toBeGreaterThan(reads))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(speedLines(chat)).toContainEqual(PENDING_ULTRAFAST)
    expectChatBlocked()
    // Nothing quietly wrote a cheaper tier in its place.
    expect(writes).toHaveLength(1)
  })

  it('keeps blocking while a replacement is unanswered and when it is refused too', async () => {
    const chat = await mountChat()
    await refuseWrite(0, pick(chat, ULTRAFAST.value))

    const replacement = pick(chat, STANDARD.value)
    await waitFor(() => expect(writes).toHaveLength(2))
    expectChatBlocked()

    await refuseWrite(1, replacement)
    expectChatBlocked()
  })

  it('releases the block on an accepted Standard and sends the same text once', async () => {
    const chat = await mountChat()
    await refuseWrite(0, pick(chat, ULTRAFAST.value))
    expectChatBlocked('the message I typed')

    const replacement = pick(chat, STANDARD.value)
    await waitFor(() => expect(writes).toHaveLength(2))
    expectChatBlocked('the message I typed')
    await acceptWrite(1, replacement)

    expect(await replacement).toBe(true)
    expect(speedLines(chat)).not.toContainEqual(PENDING_ULTRAFAST)
    await expectChatTakesSend('the message I typed')
  })

  it('blocks sends for a refused tier a fresh client reads only as facts, even once the catalog offers it', async () => {
    hostRefused.tierId = CUSTOM.value
    const chat = await mountChat()
    const requested = () =>
      speedLines(chat).filter((line) => JSON.stringify(line).includes(CUSTOM.value))
    await waitFor(() => expect(speedLines(chat)).toContainEqual({ kind: 'stored', label: 'Fast' }))

    // No pick was made here, so the block and its requested tier come from the host's facts alone.
    expect(requested()).toHaveLength(1)
    expect(requested()[0]?.kind).not.toBe('stored')
    expectChatBlocked('typed after the restart')

    hostRefused.catalogOffersIt = true
    const reads = optionsReads()
    chat.rerender({ turnId: 'turn-2' })
    await waitFor(() => expect(optionsReads()).toBeGreaterThan(reads))
    await waitFor(() => expect(JSON.stringify(tierDescriptor(chat)?.kind)).toContain(CUSTOM.value))
    expectChatBlocked('typed after the catalog refresh')
    expect(writes).toHaveLength(0)

    const replacement = pick(chat, STANDARD.value)
    await acceptWrite(0, replacement)
    expect(await replacement).toBe(true)
    await expectChatTakesSend('typed after the replacement')
  })

  // A read that began before the pick describes the host before it. Landing while the pick still
  // waits on its capability probe, it can neither commit nor end the hold: the pick restates the
  // stored tier, so that very read would otherwise look like its acknowledgement.
  describe('a read begun before the pick that lands during its capability probe', () => {
    async function pickWhileStaleReadLands(chat: Chat) {
      const stale: HeldRead = { ...deferred<unknown>(), taken: false }
      heldRead = stale
      // The turn change is the real seam that begins an options read.
      chat.rerender({ turnId: 'turn-2' })
      await waitFor(() => expect(stale.taken).toBe(true))

      const capability = deferred<'supported' | 'unsupported'>()
      mocks.speedSupport.mockReturnValueOnce(capability.promise)
      const outcome = pick(chat, FAST.value)
      expectChatBlocked()

      await act(async () => {
        stale.resolve({
          ...optionsReply(),
          speed: {
            selection: { tierId: FAST.value, state: 'ready' },
            lastRequest: {
              clientMessageId: 'before-the-pick',
              tierId: FAST.value,
              state: 'accepted'
            }
          }
        })
        await stale.promise
      })

      expectChatBlocked('typed while the probe is pending')
      expect(writes).toHaveLength(0)
      expect(mutate).not.toHaveBeenCalled()
      expect(speedLines(chat).some((line) => line.kind === 'last-request')).toBe(false)
      return { outcome, capability }
    }

    it('writes only after a fresh probe supports it, and sends only after the host accepts', async () => {
      const chat = await mountChat()
      const { outcome, capability } = await pickWhileStaleReadLands(chat)

      await act(async () => {
        capability.resolve('supported')
      })
      await waitFor(() => expect(writes).toHaveLength(1))
      expectChatBlocked('typed while the write is unanswered')

      await acceptWrite(0, outcome)
      expect(await outcome).toBe(true)
      await expectChatTakesSend('typed after the acceptance')
    })

    it('leaves every send out when the fresh probe refuses, until an accepted replacement', async () => {
      const chat = await mountChat()
      const { outcome, capability } = await pickWhileStaleReadLands(chat)

      await act(async () => {
        capability.resolve('unsupported')
      })
      expect(await outcome).toBe(false)
      expect(writes).toHaveLength(0)
      expectChatBlocked('typed after the refusal')

      const replacement = pick(chat, STANDARD.value)
      await acceptWrite(0, replacement)
      expect(await replacement).toBe(true)
      await expectChatTakesSend('typed after the replacement')
    })
  })

  // B's live catalog and C's resting read report the stored tier without naming it confirmed, so a
  // pick whose answer was lost is recovered only through the host's own ready selection fact.
  it('releases a pick whose answer was lost once a read reports it stored with no confirmed list', async () => {
    hostOmitsConfirmed = true
    const chat = await mountChat()
    const outcome = pick(chat, ULTRAFAST.value)
    // The host stored it, but the answer never reached this client.
    hostTier = ULTRAFAST.value
    await refuseWrite(0, outcome)
    expect(await outcome).toBe(false)
    expectChatBlocked()

    const reads = optionsReads()
    chat.rerender({ turnId: 'turn-2' })
    await waitFor(() => expect(optionsReads()).toBeGreaterThan(reads))
    await waitFor(() => expect(structuredAgentSessionSendOut(SESSION)).toBe(false))

    // Stored on the host and reported by it, not a pick still waiting for an answer.
    expect(speedLines(chat)).toContainEqual({ kind: 'stored', label: 'Ultrafast' })
    expect(speedLines(chat)).not.toContainEqual(PENDING_ULTRAFAST)
    await expectChatTakesSend('typed after the host reported it stored')
  })

  it('keeps blocking when a read with no confirmed list still shows the prior tier', async () => {
    hostOmitsConfirmed = true
    const chat = await mountChat()
    await refuseWrite(0, pick(chat, ULTRAFAST.value))

    const reads = optionsReads()
    chat.rerender({ turnId: 'turn-2' })
    await waitFor(() => expect(optionsReads()).toBeGreaterThan(reads))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(speedLines(chat)).toContainEqual(PENDING_ULTRAFAST)
    expectChatBlocked()
    expect(writes).toHaveLength(1)
  })

  it.each([
    {
      name: 'history read under way when the pick begins',
      paired: false,
      delay: 'history',
      sendFirst: true
    },
    {
      name: 'compatibility check under way when the pick begins',
      paired: true,
      delay: 'compatibility',
      sendFirst: true
    },
    {
      name: 'reserved send issued after the pick begins',
      paired: false,
      delay: 'history',
      sendFirst: false
    }
  ])(
    'never issues a reserved send at the prior speed: $name',
    async ({ paired, delay, sendFirst }) => {
      const target = paired ? PAIRED_TARGET : LOCAL_TARGET
      const history = deferred<unknown>()
      const compatibility = deferred<void>()
      if (delay === 'history') {
        forgetStructuredAgentSessionFence(SESSION)
        mocks.history.mockReturnValue(history.promise)
      } else {
        mocks.compatible.mockReturnValue(compatibility.promise)
      }
      const chat = await mountChat({ paired })
      const reserved = reserveStructuredAgentSessionSend({
        sessionId: SESSION,
        text: RESERVED_TEXT
      })
      expect(reserved).not.toBeNull()
      let sent = sendFirst ? (reserved?.send(target) ?? null) : null

      const outcome = pick(chat, ULTRAFAST.value)
      sent ??= reserved?.send(target) ?? null
      expect(sent).not.toBeNull()
      await act(async () => {
        history.resolve({ ok: true, page: { fence: 4 } })
        compatibility.resolve()
        await Promise.resolve()
      })
      await refuseWrite(0, outcome)

      // Not sent, not dropped: the text goes back to the composer for the person to retry.
      await expect(sent?.outcome).resolves.toBe('returned')
      expect(sendRpcs()).toHaveLength(0)
      expect(mocks.handBack).toHaveBeenCalledTimes(1)
      expect(mocks.handBack.mock.calls[0]?.[2]).toMatchObject({
        blocks: [{ type: 'text', text: RESERVED_TEXT }]
      })

      const replacement = pick(chat, STANDARD.value)
      await acceptWrite(1, replacement)
      await expectChatTakesSend(RESERVED_TEXT, target)
    }
  )

  it.each([
    {
      name: 'accepted',
      reply: {
        key: 'serviceTier',
        value: ULTRAFAST.value,
        options: { serviceTier: ULTRAFAST.value }
      }
    },
    { name: 'refused', reply: null }
  ])('does not let the previous host $name write clear the new host block', async ({ reply }) => {
    const chat = await mountChat()
    const previousPick = pick(chat, ULTRAFAST.value)
    await waitFor(() => expect(writes).toHaveLength(1))

    chat.rerender({ paired: true })
    await waitFor(() => expect(tierDescriptor(chat)).toBeDefined())
    const newPick = pick(chat, ULTRAFAST.value)
    await refuseWrite(1, newPick)
    expectChatBlocked('after the host moved', PAIRED_TARGET)

    await act(async () => {
      writeAt(0).reply.resolve(reply)
      await previousPick
    })

    expectChatBlocked('after the old host answered', PAIRED_TARGET)
    expect(speedLines(chat)).toContainEqual(PENDING_ULTRAFAST)

    const replacement = pick(chat, STANDARD.value)
    await acceptWrite(2, replacement)
    await expectChatTakesSend('after the replacement', PAIRED_TARGET)
  })

  // The queue's Send now and Resume start a turn at the stored speed, so neither goes while a pick
  // is unanswered or refused. Delete and Edit send nothing and are never held back.
  describe('through the real session controller', () => {
    type ControllerWrite = { value: string; write: (answer: unknown) => void }
    const controllerWrites: ControllerWrite[] = []
    const accepted = (value: string) => ({
      ok: true,
      replayed: false,
      fence: 3,
      cursor: { epoch: 'e', sequence: 1 },
      value: { key: 'serviceTier', value, options: { serviceTier: value } }
    })
    const REFUSED = {
      ok: false,
      refusal: { code: 'agent_session_operation_invalid', message: 'Not on this plan.' }
    }
    const done = (value: Record<string, unknown>) => ({
      ok: true,
      replayed: false,
      fence: 3,
      cursor: { epoch: 'e', sequence: 1 },
      value
    })

    const renderController = () =>
      renderHook(() =>
        useStructuredAgentSession({
          sessionId: SESSION,
          agent: 'codex',
          target: LOCAL_TARGET,
          isVisible: true,
          composerScopeKey: 'scope-1'
        })
      )
    type Session = ReturnType<typeof renderController>

    const callsTo = (method: string) =>
      mocks.call.mock.calls.filter(([, called]) => called === method)

    beforeEach(() => {
      controllerWrites.length = 0
      clearNativeChatDraftCacheForTests()
      setLocalRuntimeCapabilitiesForTests([
        AGENT_SESSION_CODEX_SERVICE_TIERS_RUNTIME_CAPABILITY,
        AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY
      ])
      mocks.call.mockImplementation(async (_target, method, params) => {
        switch (method) {
          case 'agentSession.options':
            return optionsReply()
          case 'agentSession.setOption':
            return new Promise((resolve) => {
              controllerWrites.push({ value: String(params?.value), write: resolve })
            })
          case 'agentSession.queuedMessagesResume':
            return done({ resumed: true })
          case 'agentSession.queuedMessageDelete':
            return done({ deleted: true })
          case 'agentSession.queuedMessageSend':
            return done({})
          default:
            return null
        }
      })
    })

    async function mountSession(): Promise<Session> {
      const session = renderController()
      await waitFor(() =>
        expect(
          session.result.current.optionSnapshot.some((entry) => entry.id === 'serviceTier')
        ).toBe(true)
      )
      return session
    }

    function pickOn(session: Session, value: string): Promise<boolean> {
      let outcome: Promise<boolean> = Promise.resolve(false)
      act(() => {
        outcome = session.result.current.setStructuredOption('serviceTier', value)
      })
      return outcome
    }

    async function answer(index: number, outcome: Promise<boolean>, accept: boolean) {
      await waitFor(() => expect(controllerWrites.length).toBeGreaterThan(index))
      const write = controllerWrites.at(index)
      if (!write) {
        throw new Error(`no setOption write #${index}`)
      }
      if (accept) {
        hostTier = write.value
      }
      await act(async () => {
        write.write(accept ? accepted(write.value) : REFUSED)
        await outcome
      })
    }

    it.each([
      {
        name: 'Send now',
        method: 'agentSession.queuedMessageSend',
        run: (session: Session) => session.result.current.queuedMessages.steer('draft-1')
      },
      {
        name: 'Resume',
        method: 'agentSession.queuedMessagesResume',
        run: (session: Session) => session.result.current.queuedMessages.resume()
      }
    ])(
      'holds $name behind an unanswered or refused pick until an accepted Standard',
      async ({ method, run }) => {
        const capability = deferred<'supported'>()
        mocks.speedSupport.mockReturnValue(capability.promise)
        const session = await mountSession()
        const outcome = pickOn(session, ULTRAFAST.value)

        // Parked at the capability read: nothing has been written, and nothing sends.
        await act(async () => {
          await run(session)
        })
        expect(callsTo(method)).toHaveLength(0)

        await act(async () => {
          capability.resolve('supported')
        })
        await waitFor(() => expect(controllerWrites).toHaveLength(1))
        await act(async () => {
          await run(session)
        })
        expect(callsTo(method)).toHaveLength(0)

        await answer(0, outcome, false)
        expect(await outcome).toBe(false)
        await act(async () => {
          await run(session)
        })
        expect(callsTo(method)).toHaveLength(0)

        // Removing a draft or copying it back to the composer sends nothing.
        await act(async () => {
          await session.result.current.queuedMessages.remove('draft-1')
          await session.result.current.queuedMessages.edit('draft-1')
        })
        expect(callsTo('agentSession.queuedMessageDelete')).toHaveLength(2)
        expect(readNativeChatDraftCache('scope-1')).toBe('queued draft-1')

        const replacement = pickOn(session, STANDARD.value)
        await answer(1, replacement, true)
        await act(async () => {
          await run(session)
        })
        expect(callsTo(method)).toHaveLength(1)
      }
    )
  })
})
