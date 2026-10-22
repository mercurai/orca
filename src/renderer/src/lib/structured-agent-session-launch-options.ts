import {
  isCodexLaunchSpeedKey,
  isStructuredLaunchSpeedBlocked,
  noteStructuredLaunchSpeedReplacement,
  waitForStructuredLaunchSpeedChange
} from './structured-agent-session-launch-blocked-speed'
import { prepareCodexSpeedWireOptions } from '@/runtime/codex-speed-selection'
import { useSyncExternalStore } from 'react'
import type {
  AgentSessionMutationResult,
  AgentSessionOptionResult
} from '../../../shared/agent-session-wire'
import { STRUCTURED_LAUNCH_OPTION_IDS } from '../../../shared/native-chat-session-option-defaults'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionPayloadFingerprint
} from '../../../shared/structured-agent-session-mutation'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  StructuredAgentSessionLaunchCancelledError,
  type StructuredAgentLaunchReceipt
} from './structured-agent-session-launch-recovery'
import {
  getStructuredLaunchStateBySessionId,
  notifyStructuredLaunchListeners,
  subscribeStructuredAgentLaunchStatus,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'
import {
  agentSessionRefusalFailure,
  agentSessionThrownFailure,
  type AgentSessionWriteFailure
} from '../../../shared/agent-session-write-failure'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { StructuredAgentSessionLaunchIntent } from './launch-structured-agent-session'
import {
  structuredAgentSessionModelOffers,
  type StructuredAgentSessionOptionState
} from '../../../shared/structured-agent-session-options'

/** The options a launch starts with, replaced whole so readers can compare by identity. */
export type StructuredLaunchSelection = {
  /** What the host runs as far as the launch knows: the create seed, then each accepted pick. */
  seed?: Readonly<Record<string, string>>
  /** Encoded picks made before publish; the launch applies them before it publishes. */
  held: Readonly<Record<string, string>>
  /** A paired server has not yet said what create seeds, so nothing can be picked against it. */
  seedPending?: true
}

export function initialStructuredLaunchSelection(
  intent: StructuredAgentSessionLaunchIntent
): StructuredLaunchSelection {
  return {
    seed: intent.seedOptions,
    held: {},
    ...(intent.target.kind !== 'local' && !intent.seedOptions ? { seedPending: true } : {})
  }
}

export type StructuredLaunchOptionOutcome =
  | { kind: 'accepted'; options: Readonly<Record<string, string>> }
  | { kind: 'refused'; failure: AgentSessionWriteFailure }
  | { kind: 'superseded' }

type OptionReply = (outcome: StructuredLaunchOptionOutcome) => void

const optionReplies = new WeakMap<StructuredLaunchState, Map<string, OptionReply>>()

function repliesFor(state: StructuredLaunchState): Map<string, OptionReply> {
  let replies = optionReplies.get(state)
  if (!replies) {
    replies = new Map()
    optionReplies.set(state, replies)
  }
  return replies
}

/**
 * Records a pick made while the launch has no fence to send it against. Null once the launch
 * has published or is gone: the pick then goes through the session like any other.
 */
export function holdStructuredAgentSessionLaunchOption(
  sessionId: string,
  id: string,
  encoded: string,
  /** The picker's list, under which a model pick keeps only the held values the model offers. */
  picker?: Pick<StructuredAgentSessionOptionState, 'catalog' | 'verifiedModelIds'>
): Promise<StructuredLaunchOptionOutcome> | null {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  if (
    !state ||
    state.cancelled ||
    (state.callers.outcome === 'published' && !isStructuredLaunchSpeedBlocked(sessionId, id))
  ) {
    return null
  }
  if (state.selection.seedPending) {
    return null
  }
  const replies = repliesFor(state)
  const held: Record<string, string> = {}
  // Each held value is the chat's own: a pick supersedes an earlier pick of the same option.
  for (const [key, value] of Object.entries(state.selection.held)) {
    const offered =
      id !== 'model' || !picker ||
       (state.intent.agent === 'codex' && (key === 'serviceTier' || key === 'fastMode')) ||
       structuredAgentSessionModelOffers(picker, encoded, key, value)
    if (key !== id && !(isCodexLaunchSpeedKey(state, id) && (key === 'serviceTier' || key === 'fastMode')) && offered) {
      held[key] = value
    } else {
      replies.get(key)?.({ kind: 'superseded' })
      replies.delete(key)
    }
  }
  state.selection = { ...state.selection, held: { ...held, [id]: encoded } }
  const pending = new Promise<StructuredLaunchOptionOutcome>((resolve) => replies.set(id, resolve))
  noteStructuredLaunchSpeedReplacement(state, id)
  notifyStructuredLaunchListeners()
  return pending
}

async function setLaunchOption(
  state: StructuredLaunchState,
  fence: number,
  key: string,
  value: string
): Promise<StructuredLaunchOptionOutcome> {
  const { target, sessionId, agent } = state.intent
  try {
    const model = state.selection.held.model ?? state.selection.seed?.model
    const prepared = await prepareCodexSpeedWireOptions({
      target,
      sessionId,
      agent,
      worktree: state.intent.params.worktree,
      options: { ...(model ? { model } : {}), [key]: value }
    })
    const wireKey =
      key === 'serviceTier' && prepared.options?.serviceTier === undefined ? 'fastMode' : key
    const fields = { key: wireKey, value: prepared.options?.[wireKey] ?? value }
    const result = await callStructuredAgentSession<
      AgentSessionMutationResult<AgentSessionOptionResult>
    >(
      target,
      'agentSession.setOption',
      {
        envelope: {
          sessionId,
          clientOperationId: createStructuredAgentSessionOperationId(createBrowserUuid),
          expectedRuntimeFence: fence,
          payloadFingerprint: structuredAgentSessionPayloadFingerprint({
            method: 'agentSession.setOption',
            sessionId,
            fields
          })
        },
        ...fields
      },
      prepared.authority
    )
    if (!result.ok) {
      return { kind: 'refused', failure: agentSessionRefusalFailure(result.refusal) }
    }
    const options = { ...result.value.options, [key]: value }
    if (wireKey !== key) {
      delete options[wireKey]
    }
    return { kind: 'accepted', options }
  } catch (error) {
    return {
      kind: 'refused',
      failure: agentSessionThrownFailure(
        error,
        error instanceof RuntimeRpcCallError ? error.code : undefined
      )
    }
  }
}

function settleHeldOption(
  state: StructuredLaunchState,
  id: string,
  encoded: string,
  outcome: StructuredLaunchOptionOutcome,
  settlement: { stillCurrent?: boolean; retainIntent?: boolean } = {}
): void {
  const {
    held: { [id]: current, ...rest },
    seed
  } = state.selection
  // A pick made while this one was in flight superseded it and stays held for the next pass.
  const settled = settlement.stillCurrent !== false && current === encoded
  state.selection = {
    seed: outcome.kind === 'accepted' ? { ...seed, ...outcome.options } : seed,
    held: settled && !settlement.retainIntent ? rest : state.selection.held
  }
  if (settled) {
    const replies = repliesFor(state)
    replies.get(id)?.(outcome)
    replies.delete(id)
  }
  notifyStructuredLaunchListeners()
  state.callers.onSettled()
}

const createHeld = new WeakMap<StructuredLaunchState, Readonly<Record<string, string>>>()

/** The held picks this create attempt carries, in whatever form it carries them. */
export function holdStructuredLaunchCreatePicks(
  state: StructuredLaunchState,
  held: Readonly<Record<string, string>>
): void {
  createHeld.set(state, held)
}

/** Selections included in the durable create are already the host's option intent; a pick the
 *  create carried in another form settles too, and a newer pick stays held. */
export function settleStructuredLaunchCreateOptions(
  state: StructuredLaunchState,
  options: Readonly<Record<string, string>>
): void {
  const carried = { ...options, ...createHeld.get(state) }
  createHeld.delete(state)
  for (const [id, encoded] of Object.entries(carried)) {
    settleHeldOption(state, id, encoded, { kind: 'accepted', options })
  }
}

/**
 * Applies the picks held during launch against the create receipt's fence, model first so an
 * effort lands under the model it was picked against, until none is left. A refused pick is
 * reported once. A refused Codex speed retains intent and blocks legacy prompt delivery until
 * an explicit replacement lands against this same receipt.
 */
export async function applyStructuredLaunchHeldOptions(
  state: StructuredLaunchState,
  receipt: StructuredAgentLaunchReceipt
): Promise<StructuredAgentLaunchReceipt> {
  for (;;) {
    if (state.cancelled) {
      throw new StructuredAgentSessionLaunchCancelledError()
    }
    const { held } = state.selection
    const id = STRUCTURED_LAUNCH_OPTION_IDS.find((key) => held[key] !== undefined)
    const encoded = id ? held[id] : undefined
    if (!id || encoded === undefined) {
      return receipt
    }
    const reply = repliesFor(state).get(id)
    const outcome = await setLaunchOption(state, receipt.fence, id, encoded)
    const stillCurrent = state.selection.held[id] === encoded && repliesFor(state).get(id) === reply
    const refusedSpeed =
      stillCurrent && isCodexLaunchSpeedKey(state, id) && outcome.kind === 'refused'
    const changed = refusedSpeed ? waitForStructuredLaunchSpeedChange(state) : null
    settleHeldOption(state, id, encoded, outcome, { stillCurrent, retainIntent: refusedSpeed })
    if (changed) {
      await changed
    }
  }
}

export function getStructuredAgentSessionLaunchSelection(
  sessionId: string
): StructuredLaunchSelection | null {
  return getStructuredLaunchStateBySessionId(sessionId)?.selection ?? null
}

/** The launch's selection while it is in the registry; null before and after. */
export function useStructuredAgentSessionLaunchSelection(
  sessionId: string
): StructuredLaunchSelection | null {
  return useSyncExternalStore(
    subscribeStructuredAgentLaunchStatus,
    () => getStructuredAgentSessionLaunchSelection(sessionId),
    () => null
  )
}
