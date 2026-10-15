// Host-support phase on the phone, from its producers: the real feedback hook owns the state, the real
// tab reconciliation hook wires the real status probe's retry owner to that hook's setters, and only the
// request port underneath is deferred. Nothing here injects a phase or restates the wiring, so a
// producer that never reports one fails as a phase that is not there, not as a missing import. The
// phase is read through an optional view of the feedback hook's result for the same reason.
//
// The terminal-tabs reconciliation and its fetch reporting are unrelated neighbours of the probe
// effect and are replaced; neither the feedback hook nor the probe is.

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_SESSION_CODEX_SERVICE_TIERS_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { structuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'

vi.mock('react-native', () => ({ Animated: { timing: vi.fn() }, Platform: { OS: 'ios' } }))
const neighbours = vi.hoisted(() => ({
  tabs: {
    fetchSessionTabs: vi.fn(),
    ensureSessionTabs: vi.fn(),
    fetchPendingBrowserSessionTabs: vi.fn(),
    retryPendingTerminalRecovery: vi.fn(),
    requestTerminalInventoryRecovery: vi.fn()
  }
}))
vi.mock('./use-mobile-session-tabs-fetch-reporting', () => ({
  useMobileSessionTabsFetchReporting: () => ({})
}))
vi.mock('./use-mobile-session-tabs-reconciliation', () => ({
  useMobileSessionTabsReconciliation: () => neighbours.tabs
}))
import { useMobileSessionFeedbackCapabilities } from './use-mobile-session-feedback-capabilities'
import { useMobileSessionTabReconciliation } from './use-mobile-session-tab-reconciliation'

type FeedbackScope = Parameters<typeof useMobileSessionFeedbackCapabilities>[0]
type ReconciliationScope = Parameters<typeof useMobileSessionTabReconciliation>[0]
// The phase is not in the hook's result type yet; once it is, the intersection carries its real type.
type FeedbackView = ReturnType<typeof useMobileSessionFeedbackCapabilities> & {
  agentSessionHostSupportPhase?: unknown
}
type Held = { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }
type Answer = RpcResponse | Error

const CAPABILITY = AGENT_SESSION_CODEX_SERVICE_TIERS_RUNTIME_CAPABILITY
const TIMED_OUT = new Error('request timed out')

const statusOf = (capabilities: readonly string[]): RpcResponse => ({
  ok: true,
  id: 'status-1',
  result: { capabilities },
  _meta: { runtimeId: 'runtime-1' }
})
const UNREADABLE: RpcResponse = {
  ok: true,
  id: 'status-1',
  result: null,
  _meta: { runtimeId: 'runtime-1' }
}
const REFUSED: RpcResponse = {
  ok: false,
  id: 'status-1',
  error: { code: 'unavailable', message: 'no' },
  _meta: { runtimeId: 'runtime-1' }
}

/** A host whose status.get requests wait for the test; the real probe asks through this port. */
function heldHost(): { client: RpcClient; requests: Held[] } {
  const requests: Held[] = []
  const client: RpcClient = {
    sendRequest: () =>
      new Promise<RpcResponse>((resolve, reject) => {
        requests.push({ resolve, reject })
      }),
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  return { client, requests }
}

async function drain(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) {
    await Promise.resolve()
  }
}

async function answerWith(request: Held | undefined, answer: Answer): Promise<void> {
  await act(async () => {
    if (answer instanceof Error) {
      request?.reject(answer)
    } else {
      request?.resolve(answer)
    }
    await drain()
  })
}

async function elapse(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
    await drain()
  })
}

let active: ReactTestRenderer | null = null

async function mount(initial: RpcClient) {
  let client: RpcClient | null = initial
  let latest: FeedbackView | null = null
  const renderedPhases: unknown[] = []
  // Refs and mirrors the hooks keep across renders; the client is the only input that moves.
  const runtime = {
    connState: 'connected',
    initialCreateWarning: '',
    sessionTabs: [],
    sessionTabsRef: { current: [] },
    activeSessionTabId: null,
    activeSessionTabIdRef: { current: null },
    markdownDocs: new Map(),
    markdownDocsRef: { current: new Map() },
    createWarningState: { source: '', visible: '' },
    setCreateWarningState: vi.fn(),
    setToastMessage: vi.fn(),
    toastOpacityRef: { current: {} },
    toastHideTimerRef: { current: null },
    toastSeqRef: { current: 0 },
    clientRef: { current: null },
    connStateRef: { current: 'connected' },
    activeSessionTabTypeRef: { current: null },
    delayedActionTimersRef: { current: new Set() },
    activeSessionTab: null
  }
  const reconciliationFields = {
    worktreeId: 'folder:remote',
    terminalsRef: { current: [] },
    appliedSessionTabsRevisionRef: { current: 0 },
    closedTabTombstonesRef: { current: new Map() },
    setMarkdownDocs: vi.fn(),
    setShowQuickCommands: vi.fn(),
    terminalGestureInputQueuesRef: { current: new Map() },
    terminalGestureInputInFlightRef: { current: new Map() },
    terminalDiagnosticsRef: { current: null },
    pendingBrowserFocusPageIdRef: { current: null },
    switchSessionTabRef: { current: null },
    nativeChatStream: { hasTabsRecoveryNeed: () => false },
    fetchTerminals: vi.fn(),
    applySessionTabs: vi.fn(),
    terminalInventoryRecoveryScope: 'scope',
    registerTerminalInventoryRecoveryAction: vi.fn(() => () => undefined)
  }

  function Probe(): null {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The real feedback hook reads only the enumerated runtime fields above plus client; its type also carries unrelated composed terminal hooks.
    const feedbackScope = { ...runtime, client } as unknown as FeedbackScope
    const feedback: FeedbackView = useMobileSessionFeedbackCapabilities(feedbackScope)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The real reconciliation hook reads only the enumerated fields above plus the actual feedback setters it wires; its type also carries unrelated markdown and terminal hooks.
    const reconciliationScope = {
      ...feedbackScope,
      ...feedback,
      ...reconciliationFields
    } as unknown as ReconciliationScope
    useMobileSessionTabReconciliation(reconciliationScope)
    latest = feedback
    renderedPhases.push(feedback.agentSessionHostSupportPhase)
    return null
  }

  await act(async () => {
    active = create(createElement(Probe))
  })
  await act(drain)
  const read = (): FeedbackView => {
    if (!latest) {
      throw new Error('real feedback hook never rendered')
    }
    return latest
  }
  return {
    phase: (): unknown => read().agentSessionHostSupportPhase,
    support: () => read().agentSessionHostSupport,
    renderedPhases,
    swapClient: async (next: RpcClient): Promise<void> => {
      client = next
      await act(async () => {
        active?.update(createElement(Probe))
        await drain()
      })
    }
  }
}

describe('host-support phase from the real feedback, reconciliation and status probe', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(async () => {
    await act(async () => active?.unmount())
    active = null
    vi.useRealTimers()
  })

  it('is pending while the first request waits, then settled with the support', async () => {
    const host = heldHost()
    const view = await mount(host.client)

    expect(host.requests).toHaveLength(1)
    expect(view.phase()).toBe('pending')
    expect(view.support()).toBeNull()
    // Nothing reported an end before there was an answer to end on.
    const ended = view.renderedPhases.filter((p) => p === 'failed' || p === 'settled')
    expect(ended).toEqual([])

    await answerWith(host.requests[0], statusOf([CAPABILITY]))

    expect(view.phase()).toBe('settled')
    expect(view.support()).toEqual(structuredAgentSessionHostSupport([CAPABILITY]))
    await elapse(60_000)
    expect(host.requests).toHaveLength(1)
    expect(view.phase()).toBe('settled')
  })

  it.each([
    ['a rejected request', TIMED_OUT],
    ['a refused request', REFUSED]
  ] as const)(
    'is failed through the backoff after %s and pending again only for the real retry',
    async (_name, failure) => {
      const host = heldHost()
      const view = await mount(host.client)
      await answerWith(host.requests[0], failure)

      expect(view.phase()).toBe('failed')
      expect(view.support()).toBeNull()
      await elapse(999)
      expect(host.requests).toHaveLength(1)
      expect(view.phase()).toBe('failed')
      await elapse(1)
      expect(host.requests).toHaveLength(2)
      expect(view.phase()).toBe('pending')

      // The backoff doubles, and the wait between attempts is still a failure, never loading.
      await answerWith(host.requests[1], TIMED_OUT)
      expect(view.phase()).toBe('failed')
      await elapse(1_999)
      expect(host.requests).toHaveLength(2)
      expect(view.phase()).toBe('failed')
      await elapse(1)
      expect(host.requests).toHaveLength(3)
      expect(view.phase()).toBe('pending')

      await answerWith(host.requests[2], statusOf([CAPABILITY]))
      expect(view.phase()).toBe('settled')
      expect(view.support()).toEqual(structuredAgentSessionHostSupport([CAPABILITY]))
    }
  )

  it('settles an unreadable status as an older host, with no failure and no retry', async () => {
    const host = heldHost()
    const view = await mount(host.client)

    await answerWith(host.requests[0], UNREADABLE)

    expect(view.phase()).toBe('settled')
    expect(view.support()).toEqual(structuredAgentSessionHostSupport([]))
    await elapse(60_000)
    expect(host.requests).toHaveLength(1)
    expect(view.phase()).toBe('settled')
    expect(view.renderedPhases).not.toContain('failed')
  })

  it.each([
    ['rejects', 'pending'],
    ['answers', 'pending'],
    ['rejects', 'failed'],
    ['answers', 'failed'],
    ['rejects', 'settled'],
    ['answers', 'settled']
  ] as const)(
    'a replaced client that %s late leaves its %s replacement as it was',
    async (late, replacementState) => {
      const previous = heldHost()
      const replacement = heldHost()
      const view = await mount(previous.client)
      expect(view.phase()).toBe('pending')

      await view.swapClient(replacement.client)
      expect(replacement.requests).toHaveLength(1)
      expect(view.phase()).toBe('pending')
      expect(view.support()).toBeNull()

      if (replacementState === 'failed') {
        await answerWith(replacement.requests[0], TIMED_OUT)
      } else if (replacementState === 'settled') {
        await answerWith(replacement.requests[0], statusOf([CAPABILITY]))
      }
      const expectedSupport =
        replacementState === 'settled' ? structuredAgentSessionHostSupport([CAPABILITY]) : null
      expect(view.phase()).toBe(replacementState)
      expect(view.support()).toEqual(expectedSupport)

      // The old host's answer carries different support, so a leak would show in both fields.
      await answerWith(previous.requests[0], late === 'answers' ? statusOf([]) : TIMED_OUT)

      expect(view.phase()).toBe(replacementState)
      expect(view.support()).toEqual(expectedSupport)
      expect(previous.requests).toHaveLength(1)
      expect(replacement.requests).toHaveLength(1)
    }
  )

  it('drops a failure on a client swap and never lets the old probe ask again', async () => {
    const previous = heldHost()
    const replacement = heldHost()
    const view = await mount(previous.client)
    await answerWith(previous.requests[0], TIMED_OUT)
    expect(view.phase()).toBe('failed')

    await view.swapClient(replacement.client)

    expect(view.phase()).toBe('pending')
    expect(view.support()).toBeNull()
    expect(replacement.requests).toHaveLength(1)
    // The old probe's backoff would have asked at 1s; the replacement's held request waits.
    await elapse(60_000)
    expect(previous.requests).toHaveLength(1)
    expect(replacement.requests).toHaveLength(1)
    expect(view.phase()).toBe('pending')
  })
})
