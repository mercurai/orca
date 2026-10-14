// A Codex speed pick and the phone's sends, through the real session controller: its options hook,
// send seam and queued-card controls, with only the client's wire replaced. A pick the host has not
// acknowledged, and one it refused, keep every send and queue send out so none goes at the prior
// speed; deleting or editing a draft sends nothing and is never held back.

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionOptionsResult } from '../../../src/shared/agent-session-wire'
import { codexSpeedLinesOfSurface } from '../../../src/shared/codex-speed-facts-presentation'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import type { StructuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
import {
  CAPABLE,
  SESSION_ID,
  acceptedSubmission,
  fieldsOf,
  mutationOk,
  ok,
  queuedDraft,
  snapshotEvent
} from './use-mobile-structured-agent-session-queued.test-fixture'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined)
  }
}))

const STANDARD_TIER = { value: 'default', label: 'Standard' }
const ULTRAFAST_TIER = { value: 'synthetic-ultra-lane', label: 'Ultrafast' }
const CUSTOM_TIER = { value: 'synthetic-custom-lane', label: 'Custom lane' }
const SPEED_HOST: StructuredAgentSessionHostSupport = { ...CAPABLE, codexServiceTiers: true }
const OLDER_HOST: StructuredAgentSessionHostSupport = { ...CAPABLE, codexServiceTiers: false }
const SOURCE_A = 'host-a\0workspace-a'
const SOURCE_B = 'host-b\0workspace-b'
const SETTINGS_WRITE = 'settings.mutateNativeChatSessionOptions'

/** `refused` is a tier the host refused earlier: only its facts say so, current stays accepted. */
function optionsReply(
  serviceTier: string,
  refused: string | null = null
): AgentSessionOptionsResult {
  return {
    ...(refused
      ? { speed: { selection: { tierId: refused, state: 'unavailable' as const } } }
      : {}),
    models: [
      {
        id: 'synthetic-speed-model',
        label: 'Synthetic Speed Model',
        isDefault: true,
        efforts: [],
        supportsFastMode: true,
        serviceTiers: [STANDARD_TIER, ULTRAFAST_TIER]
      }
    ],
    fastModeSupport: { supported: true },
    current: { model: 'synthetic-speed-model', serviceTier, confirmed: ['model', 'serviceTier'] }
  }
}

type Write = { value: string; reply: (response: RpcResponse) => void }

/** One host as the phone's client sees it: records every request, stores the tier a write it
 *  accepted names, and holds each `agentSession.setOption` until the test answers it. */
function makeHost(start: { tier?: string; refused?: string } = {}) {
  const sent: { method: string; params: unknown }[] = []
  const writes: Write[] = []
  let listener: ((value: unknown) => void) | null = null
  let tier = start.tier ?? STANDARD_TIER.value
  let refused = start.refused ?? null
  const respond = (method: string, params: unknown): Promise<RpcResponse> | RpcResponse => {
    switch (method) {
      case 'agentSession.options':
        return ok(optionsReply(tier, refused))
      case 'agentSession.setOption':
        return new Promise((reply) => writes.push({ value: String(fieldsOf(params).value), reply }))
      case 'agentSession.send':
        return mutationOk({
          clientMessageId: 'client-1',
          submission: acceptedSubmission('client-1')
        })
      case 'agentSession.queuedMessageSend':
        return mutationOk({})
      case 'agentSession.queuedMessagesResume':
        return mutationOk({ resumed: true })
      case 'agentSession.queuedMessageDelete':
        return mutationOk({ deleted: true })
      default:
        return ok({})
    }
  }
  const client: RpcClient = {
    sendRequest: async (method: string, params?: unknown) => {
      sent.push({ method, params })
      return respond(method, params)
    },
    subscribe: (_method, _params, onData) => {
      listener = onData
      return () => {}
    },
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  return {
    client,
    writes,
    calls: (method: string) => sent.filter((entry) => entry.method === method),
    listener: () => listener,
    /** `stores: false` answers as a host whose own tier this one never reads. */
    accept(index: number, stores = true) {
      const write = writes.at(index)
      if (!write) {
        throw new Error(`no setOption write #${index}`)
      }
      if (stores) {
        tier = write.value
        refused = null
      }
      write.reply(
        mutationOk({
          key: 'serviceTier',
          value: write.value,
          options: { serviceTier: write.value }
        })
      )
    },
    /** An older host acknowledges a toggle with the prior stored options merged in. */
    acceptFastOff(index: number) {
      writes.at(index)?.reply(
        mutationOk({
          key: 'fastMode',
          value: 'false',
          options: {
            model: 'synthetic-speed-model',
            serviceTier: ULTRAFAST_TIER.value,
            fastMode: 'false'
          }
        })
      )
    },
    refuse(index: number) {
      writes.at(index)?.reply(
        ok({
          ok: false,
          refusal: { code: 'agent_session_operation_invalid', message: 'Not on this plan.' }
        })
      )
    }
  }
}

type Host = ReturnType<typeof makeHost>

describe('Codex speed pick and the phone sends', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: ReturnType<typeof useMobileStructuredAgentSession> | null = null
  const appendText = vi.fn((_text: string) => true)

  function Harness({
    host,
    source,
    support = SPEED_HOST
  }: {
    host: Host
    source: string
    support?: StructuredAgentSessionHostSupport
  }): null {
    hook = useMobileStructuredAgentSession({
      client: host.client,
      sessionId: SESSION_ID,
      sourceIdentity: source,
      enabled: true,
      connected: true,
      agent: 'codex',
      hostSupport: support,
      appendComposerText: appendText,
      onSendError: vi.fn()
    })
    return null
  }

  const chat = () => {
    if (!hook) {
      throw new Error('harness never rendered')
    }
    return hook
  }

  const tierValue = () => {
    const kind = chat().optionSnapshot.find((entry) => entry.id === 'serviceTier')?.kind
    return kind && 'currentValue' in kind ? kind.currentValue : undefined
  }

  async function mountOn(
    host: Host,
    source = SOURCE_A,
    storedTier = STANDARD_TIER.value
  ): Promise<void> {
    act(() => {
      renderer = create(createElement(Harness, { host, source }))
    })
    await vi.waitFor(() => expect(host.listener()).toEqual(expect.any(Function)))
    act(() =>
      host.listener()?.(snapshotEvent({ queuedMessages: [queuedDraft({ messageId: 'draft-1' })] }))
    )
    await vi.waitFor(() => expect(tierValue()).toBe(storedTier))
  }

  /** Starts a pick and returns with only its synchronous part run. */
  function pick(value: string): Promise<boolean> {
    let outcome: Promise<boolean> = Promise.resolve(false)
    act(() => {
      outcome = chat().setStructuredOption('serviceTier', value)
    })
    return outcome
  }

  async function settle(answer: () => void, outcome: Promise<boolean>): Promise<boolean> {
    let settled = false
    await act(async () => {
      answer()
      settled = await outcome
    })
    return settled
  }

  /** An ordinary send, a queue Send now and a Resume, each tried once. */
  async function tryEverySend(): Promise<{
    send: MobileNativeChatSendOutcome
    steer: boolean
    resume: boolean
  }> {
    let result = { send: 'accepted' as MobileNativeChatSendOutcome, steer: true, resume: true }
    await act(async () => {
      result = {
        send: await chat().sendWithOutcome('typed meanwhile'),
        steer: await chat().queued.send('draft-1'),
        resume: await chat().queued.resume()
      }
    })
    return result
  }

  const wireSends = (host: Host) =>
    [
      'agentSession.send',
      'agentSession.queuedMessageSend',
      'agentSession.queuedMessagesResume'
    ].flatMap((method) => host.calls(method))

  beforeEach(() => {
    appendText.mockClear()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    hook = null
  })

  it('holds sends from the instant a pick starts, through a refusal, until an accepted Standard', async () => {
    const host = makeHost()
    await mountOn(host)

    // The send is made in the same tick as the pick, before the pick's state has rendered.
    let typed: Promise<MobileNativeChatSendOutcome> = Promise.resolve('accepted')
    let outcome: Promise<boolean> = Promise.resolve(false)
    act(() => {
      outcome = chat().setStructuredOption('serviceTier', ULTRAFAST_TIER.value)
      typed = chat().sendWithOutcome('typed at once')
    })
    await expect(typed).resolves.toBe('rejected')
    expect(await tryEverySend()).toEqual({ send: 'rejected', steer: false, resume: false })
    expect(wireSends(host)).toEqual([])

    await vi.waitFor(() => expect(host.writes).toHaveLength(1))
    expect(await settle(() => host.refuse(0), outcome)).toBe(false)
    expect(await tryEverySend()).toEqual({ send: 'rejected', steer: false, resume: false })
    expect(wireSends(host)).toEqual([])

    // Delete and Edit send nothing, so a refused pick never holds them back.
    await act(async () => {
      expect(await chat().queued.delete('draft-1')).toBe(true)
      expect(await chat().queued.edit('draft-1')).toBe(true)
    })
    expect(host.calls('agentSession.queuedMessageDelete')).toHaveLength(2)
    expect(appendText).toHaveBeenCalledWith('text of draft-1')

    const replacement = pick(STANDARD_TIER.value)
    await vi.waitFor(() => expect(host.writes).toHaveLength(2))
    expect(await tryEverySend()).toEqual({ send: 'rejected', steer: false, resume: false })
    expect(await settle(() => host.accept(1), replacement)).toBe(true)

    const released = await tryEverySend()
    expect(released.send).not.toBe('rejected')
    expect(released).toMatchObject({ steer: true, resume: true })
    expect(wireSends(host).map((entry) => entry.method)).toEqual([
      'agentSession.send',
      'agentSession.queuedMessageSend',
      'agentSession.queuedMessagesResume'
    ])
  })

  it('does not let a pick still unanswered on the previous source hold, change or persist on the next', async () => {
    const previous = makeHost()
    const next = makeHost()
    await mountOn(previous, SOURCE_A)
    const late = pick(ULTRAFAST_TIER.value)
    await vi.waitFor(() => expect(previous.writes).toHaveLength(1))

    // Same session id, another host: the parent controller is handed a new client and source.
    await act(async () => {
      renderer?.update(createElement(Harness, { host: next, source: SOURCE_B }))
    })
    await vi.waitFor(() => expect(next.listener()).toEqual(expect.any(Function)))
    act(() => next.listener()?.(snapshotEvent()))
    await vi.waitFor(() => expect(next.calls('agentSession.options')).not.toHaveLength(0))

    // The previous host's pick holds nothing here: this host's send goes out on its own client.
    let outcome: MobileNativeChatSendOutcome = 'rejected'
    await act(async () => {
      outcome = await chat().sendWithOutcome('on the new host')
    })
    expect(outcome).not.toBe('rejected')
    expect(next.calls('agentSession.send')).toHaveLength(1)
    expect(previous.calls('agentSession.send')).toEqual([])

    await settle(() => previous.accept(0), late)

    // That answer was the previous host's: the new host's stored tier stays its own read, and
    // nothing was written back to either host.
    expect(tierValue()).toBe('default')
    expect(previous.calls(SETTINGS_WRITE)).toEqual([])
    expect(next.calls(SETTINGS_WRITE)).toEqual([])
    expect(previous.calls('agentSession.options')).toHaveLength(1)
  })

  it('does not let a pick answered after only the source identity changed commit or persist', async () => {
    const host = makeHost()
    await mountOn(host, SOURCE_A)
    const late = pick(ULTRAFAST_TIER.value)
    await vi.waitFor(() => expect(host.writes).toHaveLength(1))
    const readsBefore = host.calls('agentSession.options').length

    // The same client and session id now stand for another host or workspace: only the source moved.
    await act(async () => {
      renderer?.update(createElement(Harness, { host, source: SOURCE_B }))
    })
    await vi.waitFor(() =>
      expect(host.calls('agentSession.options').length).toBeGreaterThan(readsBefore)
    )
    act(() => host.listener()?.(snapshotEvent()))

    let outcome: MobileNativeChatSendOutcome = 'rejected'
    await act(async () => {
      outcome = await chat().sendWithOutcome('on the new source')
    })
    expect(outcome).not.toBe('rejected')

    // The answer belongs to the previous source, so it is neither stored nor remembered here.
    await settle(() => host.accept(0, false), late)
    expect(tierValue()).toBe('default')
    expect(host.calls(SETTINGS_WRITE)).toEqual([])
  })

  it('blocks every send for a refused tier a fresh phone reads only as facts, until an explicit pick', async () => {
    const host = makeHost({ tier: ULTRAFAST_TIER.value, refused: CUSTOM_TIER.value })
    await mountOn(host, SOURCE_A, ULTRAFAST_TIER.value)

    // No pick was made on this phone, so the requested tier and the block come from facts alone.
    const requested = codexSpeedLinesOfSurface(chat().optionSurface).filter((line) =>
      JSON.stringify(line).includes(CUSTOM_TIER.value)
    )
    expect(requested).toHaveLength(1)
    expect(requested[0]?.kind).not.toBe('stored')
    expect(await tryEverySend()).toEqual({ send: 'rejected', steer: false, resume: false })
    expect(wireSends(host)).toEqual([])

    const replacement = pick(STANDARD_TIER.value)
    await vi.waitFor(() => expect(host.writes).toHaveLength(1))
    expect(await settle(() => host.accept(0), replacement)).toBe(true)

    const released = await tryEverySend()
    expect(released.send).not.toBe('rejected')
    expect(released).toMatchObject({ steer: true, resume: true })
  })

  it('releases a refused pick when an older host acknowledges an explicit Fast off beside the saved tier', async () => {
    const host = makeHost()
    await mountOn(host)
    const refusedPick = pick(ULTRAFAST_TIER.value)
    await vi.waitFor(() => expect(host.writes).toHaveLength(1))
    expect(await settle(() => host.refuse(0), refusedPick)).toBe(false)
    expect(await tryEverySend()).toEqual({ send: 'rejected', steer: false, resume: false })

    // The same phone now reads a host that predates tiers: only the Fast toggle remains.
    await act(async () => {
      renderer?.update(createElement(Harness, { host, source: SOURCE_A, support: OLDER_HOST }))
    })
    await vi.waitFor(() =>
      expect(chat().optionSnapshot.some((entry) => entry.id === 'fastMode')).toBe(true)
    )
    let fastOff: Promise<boolean> = Promise.resolve(false)
    act(() => {
      fastOff = chat().setStructuredOption('fastMode', false)
    })
    await vi.waitFor(() => expect(host.writes).toHaveLength(2))
    expect(await settle(() => host.acceptFastOff(1), fastOff)).toBe(true)

    const released = await tryEverySend()
    expect(released.send).not.toBe('rejected')
    expect(released).toMatchObject({ steer: true, resume: true })
    await vi.waitFor(() => expect(host.calls(SETTINGS_WRITE)).toHaveLength(1))
    expect(JSON.stringify(host.calls(SETTINGS_WRITE))).not.toContain(ULTRAFAST_TIER.value)
  })
})
