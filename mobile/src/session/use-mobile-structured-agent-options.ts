import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSessionConversationCommand } from '../../../src/shared/agent-session-conversation-command'
import { structuredAgentSessionSeedCatalog } from '../../../src/shared/structured-agent-session-seed-catalog'
import type { AgentSessionOptionsResult } from '../../../src/shared/agent-session-wire'
import type {
  SessionOptionDescriptor,
  SessionOptionValue
} from '../../../src/shared/native-chat-session-options'
import {
  codexSpeedLines,
  type SessionOptionProbePhase,
  type SpeedAwareSessionOptionsSurface
} from '../../../src/shared/codex-speed-facts-presentation'
import {
  structuredAgentSessionSpeedBlocked,
  withoutStructuredAgentSessionSpeedRequest
} from '../../../src/shared/structured-agent-session-option-acknowledgement'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot,
  type StructuredAgentSessionOptionState
} from '../../../src/shared/structured-agent-session-options'
import type { RpcClient } from '../transport/rpc-client'
import { reportedOptionRecord } from './mobile-structured-agent-option-record'
import {
  callAgentSession,
  type StructuredAgentSessionMutate
} from './mobile-structured-agent-session-rpc'
import {
  mobileStructuredOptionView,
  useMobileStructuredAgentOptionWrite
} from './use-mobile-structured-agent-option-write'
import { useMobileHostModelCatalogUpgrade } from './use-mobile-host-model-catalog-upgrade'
import {
  forgetMobileCreatedStructuredSession,
  mobileCreatedStructuredSession
} from './mobile-created-structured-sessions'
import {
  CODEX_SERVICE_TIER_OPTION_ID,
  type CodexSpeedHostSupport
} from '../../../src/shared/codex-service-tier-presentation'

type StructuredOptionsController = {
  optionPickerRequest: { id: string; sequence: number } | null
  conversationCommands: readonly AgentSessionConversationCommand[]
  optionSnapshot: SessionOptionDescriptor[]
  optionSurface: SpeedAwareSessionOptionsSurface
  pendingOptionId: string | null
  setStructuredOption: (id: string, value: SessionOptionValue) => Promise<boolean>
  invokeStructuredOption: (id: string) => Promise<boolean>
  /** Read when a send or a queue action runs, never from a render: whether a speed the host has
   *  not accepted keeps every turn out. */
  isSpeedSendBlocked: () => boolean
}

export function useMobileStructuredAgentOptions(args: {
  agent: string | null
  client: RpcClient | null
  sessionId: string | null
  /** Host and workspace of the session: one client can serve another source under the same ids. */
  sourceIdentity?: string
  enabled: boolean
  fence: number | null
  /** The running turn: its start and end read the host's speed facts again. */
  turnId?: string | null
  mutate: StructuredAgentSessionMutate
  /** The host's speed capability from the one status probe; only `supported` admits a canonical
   *  tier. Absent reads as unknown. */
  codexSpeedHost?: CodexSpeedHostSupport
  /** Whether the probe behind `codexSpeedHost` is asking, failed or answered; absent when idle. */
  codexSpeedHostPhase?: SessionOptionProbePhase | undefined
}): StructuredOptionsController {
  const { agent, client, enabled, fence, mutate, sessionId, turnId = null } = args
  const { codexSpeedHostPhase } = args
  const sourceIdentity = args.sourceIdentity ?? ''
  // Another agent has no speed control, so its reads never wait on the answer.
  const codexSpeedHost: CodexSpeedHostSupport =
    agent === 'codex' ? (args.codexSpeedHost ?? 'unknown') : 'unsupported'
  // Every agent's seed, as on the desktop: a built-in list or the provider-default pill.
  const optionCatalog = useMemo(
    () => (agent ? structuredAgentSessionSeedCatalog(agent) : null),
    [agent]
  )
  const [optionState, setOptionState] = useState(() =>
    createStructuredAgentSessionOptionState(agent ?? 'codex', optionCatalog)
  )
  const optionStateRef = useRef(optionState)
  const activeOptionRecordRef = useRef(optionState.record)
  const pendingOptionRef = useRef<string | null>(null)
  const optionMutationGeneration = useRef(0)
  const updateOptionState = useCallback(
    (update: (current: StructuredAgentSessionOptionState) => StructuredAgentSessionOptionState) => {
      const next = update(optionStateRef.current)
      optionStateRef.current = next
      setOptionState(next)
    },
    []
  )
  const [optionPickerRequest, setOptionPickerRequest] = useState<{
    id: string
    sequence: number
  } | null>(null)
  const [conversationSupport, setConversationSupport] = useState<{
    sessionId: string
    commands: readonly AgentSessionConversationCommand[]
  } | null>(null)

  const identity = `${sourceIdentity}\0${agent}\0${sessionId}`
  const optionIdentityRef = useRef(identity)
  useEffect(() => {
    const sameSession = optionIdentityRef.current === identity
    optionIdentityRef.current = identity
    const previous = optionStateRef.current
    const seeded = createStructuredAgentSessionOptionState(agent ?? 'codex', optionCatalog)
    // A host or live answer is the account's, not the fence's: keep it, and the model it reported,
    // rather than fall back to a placeholder that offers no speed tier. Picks the host never
    // reported stay behind. So is a speed the person asked for and what the host said of it;
    // another host or session never inherits any of it.
    const keepsCatalog =
      sameSession && previous.catalogSource !== null && previous.catalogSource !== 'seed'
    const next: StructuredAgentSessionOptionState = {
      ...(keepsCatalog
        ? {
            ...seeded,
            catalog: previous.catalog,
            catalogSource: previous.catalogSource,
            record: reportedOptionRecord(previous.record)
          }
        : seeded),
      ...(sameSession && previous.requested ? { requested: previous.requested } : {}),
      ...(sameSession && previous.speed ? { speed: previous.speed } : {})
    }
    optionMutationGeneration.current += 1
    pendingOptionRef.current = null
    optionStateRef.current = next
    activeOptionRecordRef.current = next.record
    setOptionState(next)
  }, [agent, enabled, fence, identity, optionCatalog])

  // Another connection is another generation: what the previous one has in flight (a write, an
  // unknown outcome, a settings write) is no longer this view's. Its request holds nothing here,
  // its speed facts describe another conversation, and a pick it dispatched but never had
  // reported is no stored value; only what the host reported stays until the new read lands.
  const clientRef = useRef(client)
  useEffect(() => {
    if (clientRef.current === client) {
      return
    }
    clientRef.current = client
    const { speed: _speed, ...rest } = withoutStructuredAgentSessionSpeedRequest(
      optionStateRef.current
    )
    const next: StructuredAgentSessionOptionState = {
      ...rest,
      pendingId: null,
      record: reportedOptionRecord(rest.record)
    }
    optionMutationGeneration.current += 1
    pendingOptionRef.current = null
    optionStateRef.current = next
    activeOptionRecordRef.current = next.record
    setOptionState(next)
  }, [client])

  // A chat this phone created runs the listed default, as a desktop chat its own view launched does.
  const createdHere = useMemo(
    () => (sessionId ? mobileCreatedStructuredSession(sessionId) : undefined),
    [sessionId]
  )
  const catalogPhase = useMobileHostModelCatalogUpgrade({
    agent,
    client,
    sessionId,
    sourceIdentity,
    enabled,
    fence,
    newLaunch: createdHere !== undefined,
    ...(createdHere ? { worktree: createdHere.worktree } : {}),
    optionCatalog,
    codexSpeedHost,
    activeOptionRecordRef,
    updateOptionState
  })

  // The options read's own wait, apart from the catalog's: either one still pending keeps loading.
  const [optionsPhase, setOptionsPhase] = useState<SessionOptionProbePhase | undefined>(undefined)
  // An accepted write asks this one owner to read again: it supersedes a read in flight, and the
  // answer or failure below is the wait the speed lines show.
  const [acceptedRefresh, setAcceptedRefresh] = useState(0)
  const onAcceptedOptionRefresh = useCallback(() => setAcceptedRefresh((count) => count + 1), [])
  useEffect(() => {
    if (!client || !sessionId || !enabled || !optionCatalog) {
      setOptionsPhase(undefined)
      return
    }
    let stale = false
    const readGeneration = optionMutationGeneration.current
    setOptionsPhase('pending')
    void callAgentSession<AgentSessionOptionsResult>(client, 'agentSession.options', { sessionId })
      .then((result) => {
        // This view keeps its latch; a later one may run a model picked here.
        forgetMobileCreatedStructuredSession(sessionId)
        if (!stale && optionMutationGeneration.current === readGeneration) {
          setConversationSupport({ sessionId, commands: result.conversationCommands ?? [] })
          updateOptionState((current) =>
            current.record === activeOptionRecordRef.current
              ? applyStructuredAgentSessionOptions(current, optionCatalog, result, codexSpeedHost)
              : current
          )
        }
        // A write that outdated this read still ends its wait; its values were not applied.
        if (!stale) {
          setOptionsPhase('settled')
        }
      })
      .catch(() => {
        if (!stale) {
          setOptionsPhase('failed')
        }
      })
    return () => {
      stale = true
    }
  }, [
    acceptedRefresh,
    client,
    codexSpeedHost,
    enabled,
    optionCatalog,
    sessionId,
    sourceIdentity,
    fence,
    turnId,
    updateOptionState
  ])

  const optionSnapshot = useMemo(
    () => structuredAgentSessionOptionSnapshot(mobileStructuredOptionView(optionState)),
    [optionState]
  )
  const speedLines = useMemo(
    () =>
      codexSpeedLines(
        optionSnapshot.find((descriptor) => descriptor.id === CODEX_SERVICE_TIER_OPTION_ID),
        optionState.speed,
        agent !== 'codex'
          ? undefined
          : // A settled unsupported host has no speed to wait for: only its probe's own wait shows.
            codexSpeedHost === 'unsupported'
            ? { capabilityPhase: codexSpeedHostPhase }
            : { capabilityPhase: codexSpeedHostPhase, optionsPhase, catalogPhase }
      ),
    [
      agent,
      catalogPhase,
      codexSpeedHost,
      codexSpeedHostPhase,
      optionSnapshot,
      optionState.speed,
      optionsPhase
    ]
  )
  const isSpeedSendBlocked = useCallback(
    () => structuredAgentSessionSpeedBlocked(optionStateRef.current),
    []
  )

  const setStructuredOption = useMobileStructuredAgentOptionWrite({
    agent,
    client,
    sessionId,
    optionCatalog,
    codexSpeedHost,
    mutate,
    optionStateRef,
    activeOptionRecordRef,
    pendingOptionRef,
    optionMutationGeneration,
    onAcceptedOptionRefresh,
    updateOptionState
  })

  const invokeStructuredOption = useCallback(
    async (id: string) => {
      if (!optionSnapshot.some((entry) => entry.id === id)) {
        return false
      }
      setOptionPickerRequest((current) => ({ id, sequence: (current?.sequence ?? 0) + 1 }))
      return true
    },
    [optionSnapshot]
  )

  const setOption = useCallback(
    async (id: string, value: SessionOptionValue) => {
      await setStructuredOption(id, value)
      return {
        snapshot: structuredAgentSessionOptionSnapshot(
          mobileStructuredOptionView(optionStateRef.current)
        )
      }
    },
    [setStructuredOption]
  )

  const optionSurface = useMemo<SpeedAwareSessionOptionsSurface>(
    () => ({
      getSnapshot: () => optionSnapshot,
      setOption,
      invokeAction: async () => ({ snapshot: optionSnapshot }),
      subscribe: () => () => {},
      getSpeedLines: () => speedLines
    }),
    [optionSnapshot, setOption, speedLines]
  )

  return {
    optionPickerRequest,
    conversationCommands:
      conversationSupport?.sessionId === sessionId ? conversationSupport.commands : [],
    optionSnapshot,
    optionSurface,
    pendingOptionId: optionState.pendingId,
    setStructuredOption,
    invokeStructuredOption,
    isSpeedSendBlocked
  }
}
