// The native chat controller builds the picker's controller from the structured session. Speed facts
// ride the session's options surface, so they must survive that hand-off: the real parent controller
// and the real option controller run, and only the session and the hooks around them are replaced.
// A hand-written copy of the parent's field list would pass whatever the parent actually forwards.

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodexSpeedLine } from '../../../src/shared/codex-speed-facts-presentation'
import type { SessionOptionDescriptor } from '../../../src/shared/native-chat-session-options'
import type { MobileNativeChatTab } from './mobile-native-chat-eligibility'
import {
  structuredAgentSessionHostSupport,
  type StructuredAgentSessionHostSupport
} from './mobile-structured-agent-session-host-support'

const SPEED_LINES: CodexSpeedLine[] = [
  { kind: 'stored', label: 'Fast' },
  { kind: 'last-request', outcome: 'accepted', label: 'Fast' },
  { kind: 'processing' }
]
const SNAPSHOT: SessionOptionDescriptor[] = [
  {
    id: 'model',
    label: 'Model',
    category: 'model',
    kind: {
      type: 'select',
      currentValue: 'gpt-fast',
      choices: [{ value: 'gpt-fast', label: 'GPT Fast' }]
    },
    valueSource: 'reported',
    transport: 'agent-session',
    settable: true
  }
]

vi.mock('./use-mobile-session-view-mode', () => ({
  useMobileSessionViewMode: () => ({ isTabChatView: () => true, toggleTabChatView: vi.fn() })
}))
vi.mock('./use-mobile-native-chat-session', () => ({
  useMobileNativeChatSession: () => ({ messages: [], status: 'ready', transcriptLoading: false })
}))
// What the real controller and lane hand the session hook, read after the fact.
const sessionArgs = vi.hoisted((): { calls: Record<string, unknown>[] } => ({ calls: [] }))

vi.mock('./use-mobile-structured-agent-session', () => ({
  useMobileStructuredAgentSession: (args: Record<string, unknown>) => {
    sessionArgs.calls.push(args)
    return {
      session: {
        messages: [],
        status: 'ready',
        transcriptLoading: false,
        error: undefined,
        hasMore: false,
        loadingEarlier: false,
        loadEarlier: vi.fn()
      },
      isWorking: false,
      turnId: null,
      queued: { cards: [], send: vi.fn(), delete: vi.fn(), edit: vi.fn() },
      sendWithOutcome: vi.fn(),
      cancel: vi.fn(),
      cancelPrompt: vi.fn(),
      permission: null,
      question: null,
      optionSnapshot: SNAPSHOT,
      // What the real options hook returns: the surface carries the speed lines.
      optionSurface: {
        getSnapshot: () => SNAPSHOT,
        setOption: async () => ({ snapshot: SNAPSHOT }),
        invokeAction: async () => ({ snapshot: SNAPSHOT }),
        subscribe: () => () => {},
        getSpeedLines: () => SPEED_LINES
      },
      pendingOptionId: null,
      respondPermission: vi.fn(),
      respondQuestion: vi.fn(),
      setStructuredOption: vi.fn(),
      invokeStructuredOption: vi.fn()
    }
  }
}))
vi.mock('./use-mobile-native-chat-drafts', () => ({
  useMobileNativeChatDrafts: () => ({
    composerText: '',
    setComposerText: vi.fn(),
    pending: [],
    imagePreviewsByMessageId: {},
    captureSendOrigin: vi.fn(),
    readSeededLaunchDraft: () => null,
    readSeededLaunchDraftSeed: () => null,
    clearDraftForSend: vi.fn(),
    restoreRejectedDraft: vi.fn(),
    acceptSend: vi.fn(),
    holdUnconfirmedSend: vi.fn()
  })
}))
vi.mock('./use-mobile-native-chat-prompts', () => ({
  useMobileNativeChatPrompts: () => ({
    permission: null,
    question: null,
    detectedAsk: null,
    ask: null
  })
}))
vi.mock('./use-mobile-native-chat-answer-send', () => ({
  useMobileNativeChatAnswerSend: () => ({ answerAsk: vi.fn(), cancelPending: vi.fn() })
}))
vi.mock('./mobile-native-chat-permission-send', () => ({
  useMobileNativeChatPermissionSend: () => vi.fn()
}))
vi.mock('./use-mobile-native-chat-stop', () => ({ useMobileNativeChatStop: () => vi.fn() }))
vi.mock('./use-mobile-native-chat-file-search', () => ({
  useMobileNativeChatFileSearch: () => ({ nativeChatFilePaths: [], loadNativeChatFiles: vi.fn() })
}))

import {
  useMobileNativeChatController,
  type MobileNativeChatController
} from './use-mobile-native-chat-controller'

const STRUCTURED_TAB: MobileNativeChatTab = {
  type: 'agent-session',
  sessionId: 'session-structured',
  agent: 'codex'
}

const HOST_SUPPORT = structuredAgentSessionHostSupport([])

describe('useMobileNativeChatController speed facts', () => {
  let renderer: ReactTestRenderer | null = null
  let controller: MobileNativeChatController | null = null
  // What the feedback layer owns beside the support: the phase of the probe that produced it.
  let hostSupport: StructuredAgentSessionHostSupport | null = null
  let hostSupportPhase: 'pending' | 'failed' | 'settled' | undefined

  function Harness(): null {
    controller = useMobileNativeChatController({
      client: null,
      connState: 'connected',
      hostId: 'h',
      worktreeId: 'w',
      activeSessionTab: STRUCTURED_TAB,
      activeSessionTabId: 'agent-tab-1',
      activeHandleRef: { current: null },
      deviceTokenRef: { current: null },
      nativeChatTranscriptIsLocalReadable: true,
      nativeChatInputLeaseReady: false,
      onSendError: vi.fn(),
      onSendResolved: vi.fn(),
      agentSessionHostSupport: hostSupport,
      // Spread: the controller does not type the phase argument yet.
      ...(hostSupportPhase ? { agentSessionHostSupportPhase: hostSupportPhase } : {})
    })
    return null
  }

  const lastSessionArgs = () => sessionArgs.calls.at(-1)

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    controller = null
    hostSupport = null
    hostSupportPhase = undefined
    sessionArgs.calls.length = 0
  })

  it('hands the session the support phase the feedback layer reports, and nothing it was not given', () => {
    act(() => {
      renderer = create(createElement(Harness))
    })
    expect(lastSessionArgs()?.hostSupport).toBeNull()
    expect(lastSessionArgs()?.hostSupportPhase).toBeUndefined()

    hostSupportPhase = 'pending'
    act(() => renderer?.update(createElement(Harness)))
    expect(lastSessionArgs()).toMatchObject({ hostSupport: null, hostSupportPhase: 'pending' })

    hostSupportPhase = 'failed'
    act(() => renderer?.update(createElement(Harness)))
    expect(lastSessionArgs()).toMatchObject({ hostSupport: null, hostSupportPhase: 'failed' })

    hostSupport = HOST_SUPPORT
    hostSupportPhase = 'settled'
    act(() => renderer?.update(createElement(Harness)))
    expect(lastSessionArgs()).toMatchObject({
      hostSupport: HOST_SUPPORT,
      hostSupportPhase: 'settled'
    })
    expect(lastSessionArgs()?.hostSupport).toBe(HOST_SUPPORT)
  })

  it('hands the picker a controller that reads the speed lines the session reports', () => {
    act(() => {
      renderer = create(createElement(Harness))
    })

    const pickerController = controller?.nativeChatSessionOptions?.controller
    expect(pickerController?.snapshot).toEqual(SNAPSHOT)
    // The picker reads `getSpeedLines` off the controller it is given.
    const lines =
      pickerController &&
      'getSpeedLines' in pickerController &&
      typeof pickerController.getSpeedLines === 'function'
        ? pickerController.getSpeedLines()
        : null
    expect(lines).toEqual(SPEED_LINES)
  })
})
