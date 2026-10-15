import type { RpcClient } from '../transport/rpc-client'
import { useMobileOmpModelDiscovery } from './use-mobile-omp-model-discovery'
import type { AgentSessionConversationCommand } from '../../../src/shared/agent-session-conversation-command'
import { useCallback, useMemo } from 'react'
import type {
  SessionOptionDescriptor,
  SessionOptionValue
} from '../../../src/shared/native-chat-session-options'
import type {
  CodexSpeedLine,
  SpeedAwareSessionOptionsSurface
} from '../../../src/shared/codex-speed-facts-presentation'
import { mobileNativeChatScopeKey } from './mobile-native-chat-scope-key'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import type { MobileNativeChatSessionOptionPickersProps } from './MobileNativeChatSessionOptionPickers'
import {
  useMobileNativeChatSessionOptions,
  type MobileNativeChatSessionOptionsController
} from './use-mobile-native-chat-session-options'

/** The structured session's controller: the picker reads its speed lines off it. */
type StructuredSessionOptionsController = MobileNativeChatSessionOptionsController &
  Pick<SpeedAwareSessionOptionsSurface, 'getSpeedLines'>

export function useMobileNativeChatSessionOptionController(args: {
  client?: RpcClient | null
  activeChatStructured: boolean
  activeSessionTabId: string | null
  agent: string | null
  dispatchCommand: (text: string) => Promise<MobileNativeChatSendOutcome>
  hostId: string
  isTabChatView: (tabId: string) => boolean
  isWorking: boolean
  reportedModel: string | null
  modelSwitchCommand?: string
  structured: {
    conversationCommands?: readonly AgentSessionConversationCommand[]
    optionPickerRequest?: { id: string; sequence: number } | null
    snapshot: SessionOptionDescriptor[]
    pendingId: string | null
    setOption: (id: string, value: SessionOptionValue) => Promise<boolean>
    invokeAction: (id: string) => Promise<boolean>
    /** The speed facts the session's options surface reports; the picker reads them off the
     *  controller it is given. */
    speedLines?: readonly CodexSpeedLine[]
  }
  toggleTabChatView: (tabId: string) => void
  worktreeId: string
}): {
  nativeChatSessionOptions: MobileNativeChatSessionOptionPickersProps | null
  recordCommand: (command: string) => void
} {
  const {
    activeChatStructured,
    activeSessionTabId,
    agent,
    dispatchCommand,
    hostId,
    isTabChatView,
    isWorking,
    reportedModel,
    structured,
    toggleTabChatView,
    worktreeId
  } = args
  const {
    invokeAction: invokeStructuredAction,
    pendingId: structuredPendingId,
    setOption: setStructuredOption,
    snapshot: structuredSnapshot
  } = structured

  const handleAgentPicker = useCallback(() => {
    if (activeSessionTabId && isTabChatView(activeSessionTabId)) {
      toggleTabChatView(activeSessionTabId)
    }
  }, [activeSessionTabId, isTabChatView, toggleTabChatView])

  const discoveredModels = useMobileOmpModelDiscovery({
    client: args.client ?? null,
    hostId,
    worktreeId,
    enabled: !activeChatStructured && agent === 'omp' && activeSessionTabId !== null
  })
  const sessionOptions = useMobileNativeChatSessionOptions({
    discoveredModels,
    modelSwitchCommand: args.modelSwitchCommand,
    agent: activeChatStructured ? null : agent,
    scopeKey: mobileNativeChatScopeKey(hostId, worktreeId, activeSessionTabId),
    reportedModel,
    dispatchCommand,
    onAgentPicker: handleAgentPicker
  })
  const structuredSpeedLines = structured.speedLines
  const structuredController = useMemo<StructuredSessionOptionsController | null>(
    () =>
      activeChatStructured && structuredSnapshot.length > 0
        ? {
            snapshot: structuredSnapshot,
            optionPickerRequest: structured.optionPickerRequest,
            conversationCommands: structured.conversationCommands,
            pendingId: structuredPendingId,
            setOption: setStructuredOption,
            invokeAction: invokeStructuredAction,
            recordCommand: () => {},
            getSpeedLines: () => structuredSpeedLines ?? []
          }
        : null,
    [
      activeChatStructured,
      invokeStructuredAction,
      setStructuredOption,
      structuredPendingId,
      structuredSnapshot,
      structuredSpeedLines,
      structured.conversationCommands,
      structured.optionPickerRequest
    ]
  )
  const nativeChatSessionOptions = useMemo<MobileNativeChatSessionOptionPickersProps | null>(
    () =>
      activeChatStructured
        ? structuredController
          ? { controller: structuredController, isWorking }
          : null
        : sessionOptions.snapshot.length > 0
          ? { controller: sessionOptions, isWorking }
          : null,
    [activeChatStructured, isWorking, sessionOptions, structuredController]
  )

  return { nativeChatSessionOptions, recordCommand: sessionOptions.recordCommand }
}
