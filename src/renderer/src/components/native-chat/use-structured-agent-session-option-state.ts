import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSessionConversationCommand } from '../../../../shared/agent-session-conversation-command'
import type { AgentSessionOptionsResult } from '../../../../shared/agent-session-wire'
import type { AgentSessionRewindSupport } from '../../../../shared/agent-session-rewind'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { AgentSessionOptionCatalog } from '../../../../shared/agent-session-option-catalog'
import { structuredAgentSessionSeedCatalog } from '../../../../shared/structured-agent-session-seed-catalog'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  type StructuredAgentSessionOptionState
} from '../../../../shared/structured-agent-session-options'
import type { CodexSpeedHostSupport } from '../../../../shared/codex-service-tier-presentation'
import type { SessionOptionProbePhase } from '../../../../shared/codex-speed-facts-presentation'
import { structuredAgentSessionSpeedBlocked } from '../../../../shared/structured-agent-session-option-acknowledgement'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { useStructuredAgentSessionHostCodexSpeedProbe } from '@/runtime/structured-agent-session-host-capability'
import { readHostModelCatalogSnapshot } from '@/runtime/host-model-catalog-snapshots'
import { holdStructuredAgentSessionSpeedSends } from './structured-agent-session-pending-sends'
import { useHostModelCatalogUpgrade } from './use-host-model-catalog-upgrade'
import {
  createCoalescedPollRunner,
  type CoalescedPollRunner
} from '../right-sidebar/coalesced-poll-runner'

/** The first frame: the host's saved list when the renderer already holds it, else the seed,
 *  which shows the quiet placeholder until the host answers. */
function firstFrameOptionState(
  agent: AgentType,
  target: RuntimeClientTarget,
  launch: {
    newLaunch: boolean
    worktree?: string
    seedsModel: boolean
    codexSpeedHost?: CodexSpeedHostSupport
  }
): StructuredAgentSessionOptionState {
  const seed = structuredAgentSessionSeedCatalog(agent)
  const seeded = createStructuredAgentSessionOptionState(agent, seed)
  const snapshot = readHostModelCatalogSnapshot(target, agent, launch)
  return snapshot ? applyStructuredAgentSessionModelCatalog(seeded, seed, snapshot, launch) : seeded
}

/** The picker's option state for one session: seeded, reset at each fence, re-read each turn. */
export function useStructuredAgentSessionOptionState(args: {
  agent: AgentType
  optionCatalog: AgentSessionOptionCatalog | null
  identity: string
  fence: number | null
  sessionId: string
  target: RuntimeClientTarget
  /** Whether this is a new chat, where it runs and whether it names its model: what the
   *  host's saved list is read for. */
  newLaunch: boolean
  worktree?: string
  seedsModel: boolean
  /** The pane is on screen: a catalog read can start a listing process. */
  isVisible: boolean
  providerVisible: boolean
  providerStarting: boolean
  providerRunning?: boolean
  readsBeforeStart: boolean
  turnId: string | null
  unloadedTurnRevisions: number | undefined
}) {
  const {
    agent,
    fence,
    identity,
    newLaunch,
    optionCatalog,
    seedsModel,
    providerStarting,
    providerVisible,
    readsBeforeStart,
    sessionId,
    target,
    turnId,
    worktree
  } = args
  // What shapes the speed control in every list, so each applies it and re-reads when it changes.
  // Another agent has no speed control, so its reads never wait on this answer.
  const speedProbe = useStructuredAgentSessionHostCodexSpeedProbe(target)
  const codexSpeedHost = agent === 'codex' ? speedProbe.state : 'unsupported'
  const [conversationSupport, setConversationSupport] = useState<{
    sessionId: string
    commands: readonly AgentSessionConversationCommand[]
    threadGoal: AgentSessionOptionsResult['threadGoal']
    contextUsage: AgentSessionOptionsResult['contextUsage']
    rewind: AgentSessionRewindSupport
    /** The fence the read answered for; rewind support is only that runtime's. */
    fence: number | null
  } | null>(null)
  // A revision the loaded window dropped can move the host's whole-journal context facts.
  const contextRefresh = conversationSupport?.contextUsage ? (args.unloadedTurnRevisions ?? 0) : 0
  // The first frame is the final one when the renderer holds the host's list; otherwise the quiet
  // placeholder stands until the host answers, never a built-in label the host may replace.
  const [optionState, setOptionState] = useState(() =>
    firstFrameOptionState(agent, target, {
      newLaunch,
      seedsModel,
      codexSpeedHost,
      ...(worktree ? { worktree } : {})
    })
  )
  // Read only when a fence or session resets the state, so a new target alone resets nothing.
  const firstFrameLaunch = useRef({ target, newLaunch, worktree, seedsModel, codexSpeedHost })
  useEffect(() => {
    firstFrameLaunch.current = { target, newLaunch, worktree, seedsModel, codexSpeedHost }
  }, [codexSpeedHost, newLaunch, seedsModel, target, worktree])
  const optionStateRef = useRef(optionState)
  const activeOptionRecordRef = useRef(optionState.record)
  const pendingOptionRef = useRef<string | null>(null)
  const optionMutationGeneration = useRef(0)
  // The chat's sends stay out while a speed the host has not accepted is requested, refused or
  // unanswered, or the host's own facts name a requested tier it cannot send. Taken and released
  // where the state changes, so a send in the same tick as a pick already finds it.
  const speedHoldRef = useRef<(() => void) | null>(null)
  const syncSpeedHold = useCallback(
    (state: StructuredAgentSessionOptionState) => {
      const blocked = structuredAgentSessionSpeedBlocked(state)
      if (blocked && speedHoldRef.current === null) {
        speedHoldRef.current = holdStructuredAgentSessionSpeedSends(sessionId)
      } else if (!blocked && speedHoldRef.current !== null) {
        speedHoldRef.current()
        speedHoldRef.current = null
      }
    },
    [sessionId]
  )
  useEffect(
    () => () => {
      speedHoldRef.current?.()
      speedHoldRef.current = null
    },
    []
  )
  const updateOptionState = useCallback(
    (update: (current: StructuredAgentSessionOptionState) => StructuredAgentSessionOptionState) => {
      const next = update(optionStateRef.current)
      optionStateRef.current = next
      syncSpeedHold(next)
      setOptionState(next)
    },
    [syncSpeedHold]
  )
  const optionIdentityRef = useRef(identity)
  useEffect(() => {
    const previous = optionStateRef.current
    const sameSession = optionIdentityRef.current === identity
    optionIdentityRef.current = identity
    const launch = firstFrameLaunch.current
    const seeded = firstFrameOptionState(agent, launch.target, {
      newLaunch: launch.newLaunch,
      seedsModel: launch.seedsModel,
      codexSpeedHost: launch.codexSpeedHost,
      ...(launch.worktree ? { worktree: launch.worktree } : {})
    })
    // A host answer is the account's, not the fence's: keep it rather than blank the default.
    // So is a speed the person asked for and what the host said of it; another host or session
    // never inherits either.
    const keepsHostCatalog =
      sameSession && (previous.catalogSource === 'host' || previous.catalogSource === 'builtin')
    const next: StructuredAgentSessionOptionState = {
      ...(keepsHostCatalog
        ? { ...seeded, catalog: previous.catalog, catalogSource: previous.catalogSource }
        : seeded),
      ...(sameSession && previous.requested ? { requested: previous.requested } : {}),
      ...(sameSession && previous.speed ? { speed: previous.speed } : {})
    }
    optionMutationGeneration.current += 1
    pendingOptionRef.current = null
    optionStateRef.current = next
    activeOptionRecordRef.current = next.record
    syncSpeedHold(next)
    setOptionState(next)
    // `syncSpeedHold` changes only with the session id, which is part of `identity`.
  }, [agent, fence, identity, syncSpeedHold])

  const optionsReadRef = useRef<CoalescedPollRunner | null>(null)
  // Presentation only, never in the record: what the read answered for, so another session, fence
  // or speed answer starts unanswered. The last answer stays in the state while a read runs.
  const readIdentity = `${identity}\u0000${fence}\u0000${codexSpeedHost}`
  const [optionsRead, setOptionsRead] = useState<{
    identity: string
    phase: SessionOptionProbePhase
  } | null>(null)
  const readsOptions =
    providerVisible && !(providerStarting && !readsBeforeStart) && optionCatalog !== null
  // Refresh options each turn to confirm which model the provider actually selected, and once
  // the provider starts: only then has the host read what it will run.
  useEffect(() => {
    if (!readsOptions || !optionCatalog) {
      return
    }
    let stale = false
    // Each actual read is pending while out, then settled or failed; a queued follow-up read marks
    // pending again in the same tick, so the phase never shows settled between the two.
    const markRead = (phase: SessionOptionProbePhase): void =>
      setOptionsRead({ identity: readIdentity, phase })
    const runner = createCoalescedPollRunner(async () => {
      const readGeneration = optionMutationGeneration.current
      markRead('pending')
      let result: AgentSessionOptionsResult
      try {
        result = await callStructuredAgentSession<AgentSessionOptionsResult>(
          target,
          'agentSession.options',
          { sessionId }
        )
      } catch (error) {
        if (!stale) {
          markRead('failed')
        }
        throw error
      }
      if (stale) {
        return
      }
      // A write that superseded this read keeps its values out, but the read itself completed.
      markRead('settled')
      if (optionMutationGeneration.current === readGeneration) {
        setConversationSupport({
          sessionId,
          commands: result.conversationCommands ?? [],
          threadGoal: result.threadGoal,
          contextUsage: result.contextUsage,
          // A host that predates rewind does not name it.
          rewind: result.rewind ?? { supported: false, reason: 'unsupported' },
          fence
        })
        updateOptionState((current) =>
          current.record === activeOptionRecordRef.current
            ? applyStructuredAgentSessionOptions(current, optionCatalog, result, codexSpeedHost)
            : current
        )
      }
    })
    optionsReadRef.current = runner
    runner.run()
    return () => {
      stale = true
      runner.dispose()
    }
  }, [
    codexSpeedHost,
    fence,
    optionCatalog,
    // The provider starting reads again, as it did before the guard was shared with the phase.
    providerStarting,
    readIdentity,
    readsBeforeStart,
    readsOptions,
    sessionId,
    target,
    turnId,
    updateOptionState
  ])

  // Reads share the session's host queue with sends and interrupts, so a burst of
  // missed revisions keeps one read in flight and at most one behind it.
  const refreshOptions = useCallback(() => optionsReadRef.current?.run(), [])
  const seenContextRefresh = useRef(contextRefresh)
  useEffect(() => {
    if (contextRefresh !== seenContextRefresh.current) {
      seenContextRefresh.current = contextRefresh
      refreshOptions()
    }
  }, [contextRefresh, refreshOptions])

  const { unavailable, catalogPhase } = useHostModelCatalogUpgrade({
    agent,
    sessionId,
    target,
    optionCatalog,
    enabled: args.isVisible,
    // A resumed conversation may keep its own model, so only a new one runs the listed default.
    newLaunch,
    ...(worktree ? { worktree } : {}),
    fence,
    turnId,
    reportedUnpickedModel: newLaunch && !seedsModel && optionState.catalogSource === 'live',
    ...(args.providerRunning ? { providerRunning: true } : {}),
    codexSpeedHost,
    activeOptionRecordRef,
    updateOptionState
  })

  // Only Codex has a speed control to caption; the phases never enter the ref'd record.
  const optionsPhase = !readsOptions
    ? undefined
    : optionsRead?.identity === readIdentity
      ? optionsRead.phase
      : 'pending'
  const capabilityPhase = speedProbe.phase
  const phasedOptionState = useMemo(
    () =>
      agent === 'codex'
        ? { ...optionState, capabilityPhase, optionsPhase, catalogPhase }
        : optionState,
    [agent, capabilityPhase, catalogPhase, optionState, optionsPhase]
  )

  return {
    conversationSupport,
    codexSpeedHost,
    unavailable,
    optionState: phasedOptionState,
    optionStateRef,
    activeOptionRecordRef,
    pendingOptionRef,
    optionMutationGeneration,
    updateOptionState,
    /** A write's follow-up read: the same runner, so one read phase and one coalescing owner. */
    refreshOptions
  }
}
