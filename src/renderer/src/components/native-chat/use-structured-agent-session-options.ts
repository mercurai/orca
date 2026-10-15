import { toast } from 'sonner'
import { useCallback, useMemo } from 'react'
import type { AgentSessionOptionResult } from '../../../../shared/agent-session-wire'
import type { AgentType } from '../../../../shared/agent-status-types'
import { structuredAgentSessionSeedCatalog } from '../../../../shared/structured-agent-session-seed-catalog'
import type { SpeedAwareSessionOptionsSurface } from '../../../../shared/codex-speed-facts-presentation'
import {
  canSetStructuredAgentSessionOption,
  lockedStructuredAgentSessionOptionSnapshot,
  structuredAgentSessionOptionPicks,
  structuredAgentSessionOptionSnapshot,
  type StructuredAgentSessionOptionState
} from '../../../../shared/structured-agent-session-options'
import { structuredAgentSessionOptionView } from '../../../../shared/structured-agent-session-option-view'
import {
  acknowledgeStructuredAgentSessionAction,
  acknowledgedStructuredAgentSessionOptions,
  requestStructuredAgentSessionSpeed,
  structuredAgentSessionHeldWithRequested
} from '../../../../shared/structured-agent-session-option-acknowledgement'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { structuredAgentSessionHostKey } from '@/runtime/structured-agent-session-host-capability'
import { useStructuredAgentSessionSpeedGate } from './use-structured-agent-session-speed-gate'
import { enqueueSessionOptionSettingsWrite } from './native-chat-session-option-settings-write'
import { encodeStructuredAgentSessionOptionValue } from '../../../../shared/structured-agent-session-option-codec'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionOptionState } from './use-structured-agent-session-option-state'
import { agentSessionWriteFailureText } from './agent-session-write-notice-text'
import type { StructuredAgentSessionLaunchView } from './use-native-chat-provisional-launch'
import {
  getStructuredAgentSessionLaunchSelection,
  holdStructuredAgentSessionLaunchOption,
  type StructuredLaunchOptionOutcome
} from '@/lib/structured-agent-session-launch-options'

const NO_HELD_OPTIONS: Readonly<Record<string, string>> = {}

export function useStructuredAgentSessionOptions(args: {
  agent: AgentType
  sessionId: string
  target: RuntimeClientTarget
  transportEnabled: boolean
  isVisible: boolean
  providerVisible: boolean
  providerStarting?: boolean
  providerRunning?: boolean
  fence: number | null
  turnId: string | null
  unloadedTurnRevisions: number | undefined
  mutate: StructuredAgentSessionMutate
  launch?: StructuredAgentSessionLaunchView
}) {
  const {
    agent,
    fence,
    launch,
    mutate,
    providerVisible,
    sessionId,
    target,
    transportEnabled,
    turnId
  } = args
  const launchSeedOptions = launch?.seedOptions
  const held = launch?.heldOptions ?? NO_HELD_OPTIONS
  // Published but not attached: the launch no longer holds picks and there is no fence to send one.
  const acceptsPicks = !transportEnabled || fence !== null
  const optionCatalog = useMemo(() => structuredAgentSessionSeedCatalog(agent), [agent])
  // A session on another execution host is another session, whatever its ids.
  const identity = `${structuredAgentSessionHostKey(target)}:${agent}:${sessionId}`
  const {
    optionState,
    optionStateRef,
    activeOptionRecordRef,
    pendingOptionRef,
    optionMutationGeneration,
    updateOptionState,
    conversationSupport,
    codexSpeedHost,
    unavailable
  } = useStructuredAgentSessionOptionState({
    agent,
    optionCatalog,
    identity,
    fence,
    sessionId,
    target,
    isVisible: args.isVisible,
    newLaunch: launch?.kind === 'new',
    ...(launch?.worktree ? { worktree: launch.worktree } : {}),
    seedsModel: launchSeedOptions?.model !== undefined,
    providerVisible,
    providerStarting: args.providerStarting ?? false,
    ...(args.providerRunning ? { providerRunning: true } : {}),
    // A new chat's host knows nothing of its model before the provider starts; a resumed one's
    // holds the model it ran, so only the former waits rather than show the host's guess.
    readsBeforeStart: launch?.kind !== 'new',
    turnId,
    unloadedTurnRevisions: args.unloadedTurnRevisions
  })

  // The person's own unanswered or refused speed shows over what the host stores; it is intent,
  // kept in the state apart from the record, so a read or a model change never erases it.
  const viewHeld = useMemo(
    () => structuredAgentSessionHeldWithRequested(held, optionState),
    [held, optionState]
  )
  const optionSnapshot = useMemo(() => {
    const snapshot = structuredAgentSessionOptionSnapshot(
      structuredAgentSessionOptionView(optionState, launchSeedOptions, viewHeld)
    )
    return acceptsPicks ? snapshot : lockedStructuredAgentSessionOptionSnapshot(snapshot)
  }, [acceptsPicks, launchSeedOptions, optionState, viewHeld])
  const { speedLines, admitPick, admitSend, refreshAfterWrite } =
    useStructuredAgentSessionSpeedGate({
      target,
      sessionId,
      optionCatalog,
      codexSpeedHost,
      optionState,
      optionSnapshot,
      updateOptionState
    })

  // What a settled pick must remember so the next launch starts where the user left off.
  const rememberOptionPicks = useCallback(
    (view: StructuredAgentSessionOptionState, committed: Readonly<Record<string, string>>) => {
      const picks = structuredAgentSessionOptionPicks(view, committed)
      if (picks.length > 0) {
        void enqueueSessionOptionSettingsWrite(target, { type: 'apply-picks', agent, picks })
      }
    },
    [agent, target]
  )
  const sendStructuredOption = useCallback(
    async (id: string, encoded: string): Promise<boolean> => {
      // Before the first await: a speed's request holds the chat's sends from this instant, and
      // only an accepted replacement ends it, so a refusal or a lost answer keeps it. The pick also
      // owns the pending slot and a new generation now, so a read begun earlier lands as stale and
      // can neither commit nor answer it while the capability probe is still out.
      updateOptionState((current) => requestStructuredAgentSessionSpeed(current, id, encoded))
      const currentState = optionStateRef.current
      const targetRecord = currentState.record
      const mutationGeneration = ++optionMutationGeneration.current
      const isCurrent = (): boolean =>
        activeOptionRecordRef.current === targetRecord &&
        optionMutationGeneration.current === mutationGeneration
      pendingOptionRef.current = id
      updateOptionState((current) => ({ ...current, pendingId: id }))
      try {
        // Every option awaits admission, so a fence that moved in that gap must not see this pick
        // written under the new fence.
        if (!(await admitSend(id, isCurrent)) || !isCurrent()) {
          return false
        }
        const result = await mutate<AgentSessionOptionResult>(
          'agentSession.setOption',
          'agentSession.setOption',
          { key: id, value: encoded }
        )
        if (result && isCurrent()) {
          // The action's own values: an older host's merged answer echoes the saved tier too.
          const committed = acknowledgedStructuredAgentSessionOptions(
            { id, value: encoded },
            result.options
          )
          updateOptionState((current) =>
            current.record === targetRecord
              ? acknowledgeStructuredAgentSessionAction(current, id, committed)
              : current
          )
          // The launch seed names the model an effort-only pick was made under.
          rememberOptionPicks(
            structuredAgentSessionOptionView(currentState, launchSeedOptions, NO_HELD_OPTIONS),
            committed
          )
          refreshAfterWrite(targetRecord, isCurrent)
        }
        return Boolean(result)
      } finally {
        if (isCurrent()) {
          pendingOptionRef.current = null
          updateOptionState((current) =>
            current.record === targetRecord && current.pendingId === id
              ? { ...current, pendingId: null }
              : current
          )
        }
      }
    },
    [
      activeOptionRecordRef,
      admitSend,
      launchSeedOptions,
      mutate,
      optionMutationGeneration,
      optionStateRef,
      pendingOptionRef,
      refreshAfterWrite,
      rememberOptionPicks,
      updateOptionState
    ]
  )
  const settleLaunchOptionPick = useCallback(
    (outcome: StructuredLaunchOptionOutcome) => {
      if (outcome.kind === 'refused') {
        toast.error(agentSessionWriteFailureText(outcome.failure, 'option'))
      } else if (outcome.kind === 'accepted') {
        rememberOptionPicks(
          structuredAgentSessionOptionView(
            optionStateRef.current,
            launchSeedOptions,
            NO_HELD_OPTIONS
          ),
          outcome.options
        )
      }
    },
    [launchSeedOptions, optionStateRef, rememberOptionPicks]
  )
  const setStructuredOption = useCallback(
    async (id: string, value: string | boolean): Promise<boolean> => {
      if (!admitPick(id)) {
        return false
      }
      const view = structuredAgentSessionOptionView(
        optionStateRef.current,
        launchSeedOptions,
        structuredAgentSessionHeldWithRequested(held, optionStateRef.current)
      )
      const encoded = encodeStructuredAgentSessionOptionValue(id, value)
      if (
        !optionCatalog ||
        encoded === null ||
        !canSetStructuredAgentSessionOption(view, id, value)
      ) {
        return false
      }
      if (!transportEnabled || fence === null) {
        // No fence yet: the launch holds it and applies it before anything else is sent.
        const applied = holdStructuredAgentSessionLaunchOption(sessionId, id, encoded)
        void applied?.then(settleLaunchOptionPick)
        return applied !== null
      }
      if (pendingOptionRef.current !== null) {
        return false
      }
      return sendStructuredOption(id, encoded)
    },
    [
      admitPick,
      fence,
      held,
      launchSeedOptions,
      optionCatalog,
      optionStateRef,
      pendingOptionRef,
      sendStructuredOption,
      sessionId,
      settleLaunchOptionPick,
      transportEnabled
    ]
  )
  const setOption = useCallback(
    async (id: string, value: string | boolean) => {
      await setStructuredOption(id, value)
      // Read, not rendered: a pick the launch just took is not in this render's props yet.
      const currentHeld = getStructuredAgentSessionLaunchSelection(sessionId)?.held
      return {
        snapshot: structuredAgentSessionOptionSnapshot(
          structuredAgentSessionOptionView(
            optionStateRef.current,
            launchSeedOptions,
            structuredAgentSessionHeldWithRequested(
              currentHeld ?? NO_HELD_OPTIONS,
              optionStateRef.current
            )
          )
        )
      }
    },
    [launchSeedOptions, optionStateRef, sessionId, setStructuredOption]
  )
  const optionSurface = useMemo<SpeedAwareSessionOptionsSurface>(
    () => ({
      getSnapshot: () => optionSnapshot,
      setOption,
      invokeAction: async () => ({ snapshot: optionSnapshot }),
      subscribe: () => () => {},
      getSpeedLines: () => speedLines
    }),
    [setOption, optionSnapshot, speedLines]
  )

  const support =
    transportEnabled && conversationSupport?.sessionId === sessionId ? conversationSupport : null
  return {
    conversationCommands: support?.commands ?? [],
    /** Absent unless this host and session can change the goal. */
    threadGoal: support?.threadGoal,
    /** Absent from a host that predates it or a session that writes no context facts. */
    contextUsage: support?.contextUsage,
    /** Undefined until this fence's options read answers. */
    rewind: support?.fence === fence ? support.rewind : undefined,
    optionSnapshot,
    optionSurface,
    setStructuredOption,
    unavailable
  }
}
