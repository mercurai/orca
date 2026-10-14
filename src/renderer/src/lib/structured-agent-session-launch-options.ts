import { useSyncExternalStore } from 'react'
import type {
  AgentSessionMutationResult,
  AgentSessionOptionResult
} from '../../../shared/agent-session-wire'
import { STRUCTURED_LAUNCH_SEED_OPTION_IDS } from '../../../shared/native-chat-session-option-defaults'
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
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import type { StructuredLaunchSpeedBlock } from './structured-agent-session-launch-errors'
import { codexSeedSpeedTier, readCodexSpeedBlock } from './structured-agent-session-launch-failure'

/** The options a launch starts with, replaced whole so readers can compare by identity. */
export type StructuredLaunchSelection = {
  /** What the host runs as far as the launch knows: the create seed, then each accepted pick. */
  seed?: Readonly<Record<string, string>>
  /** Encoded picks made before publish; the launch applies them before it publishes. */
  held: Readonly<Record<string, string>>
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
  encoded: string
): Promise<StructuredLaunchOptionOutcome> | null {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  if (!state || state.cancelled || state.callers.outcome === 'published') {
    return null
  }
  const replies = repliesFor(state)
  const { serviceTier, ...droppable } = state.selection.held
  // A model pick drops picks held under the model it replaces, but not the speed: that is the
  // person's own intent and outlives the model it was picked under.
  for (const key of id === 'model' ? Object.keys(droppable) : [id]) {
    replies.get(key)?.({ kind: 'superseded' })
    replies.delete(key)
  }
  state.selection = {
    ...state.selection,
    held:
      id === 'model'
        ? { model: encoded, ...(serviceTier === undefined ? {} : { serviceTier }) }
        : { ...state.selection.held, [id]: encoded }
  }
  // A launch parked on its speed tries again with whatever was just picked.
  state.releaseSpeedBlock?.()
  notifyStructuredLaunchListeners()
  return new Promise((resolve) => replies.set(id, resolve))
}

async function setLaunchOption(
  target: RuntimeClientTarget,
  sessionId: string,
  fence: number,
  key: string,
  value: string
): Promise<StructuredLaunchOptionOutcome> {
  const fields = { key, value }
  try {
    const result = await callStructuredAgentSession<
      AgentSessionMutationResult<AgentSessionOptionResult>
    >(target, 'agentSession.setOption', {
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
    })
    return result.ok
      ? { kind: 'accepted', options: result.value.options ?? { [key]: value } }
      : { kind: 'refused', failure: agentSessionRefusalFailure(result.refusal) }
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

function replyToHeldOption(
  state: StructuredLaunchState,
  id: string,
  outcome: StructuredLaunchOptionOutcome
): void {
  const replies = repliesFor(state)
  replies.get(id)?.(outcome)
  replies.delete(id)
}

function settleHeldOption(
  state: StructuredLaunchState,
  id: string,
  encoded: string,
  outcome: StructuredLaunchOptionOutcome
): void {
  const {
    held: { [id]: current, ...rest },
    seed
  } = state.selection
  // A pick made while this one was in flight superseded it and stays held for the next pass.
  const settled = current === encoded
  state.selection = {
    seed: outcome.kind === 'accepted' ? { ...seed, ...outcome.options } : seed,
    held: settled ? rest : state.selection.held
  }
  if (settled) {
    replyToHeldOption(state, id, outcome)
  }
  notifyStructuredLaunchListeners()
}

/** A speed write that did not land: the pick stays exactly as chosen. */
function speedWriteBlock(
  encoded: string,
  outcome: StructuredLaunchOptionOutcome
): StructuredLaunchSpeedBlock | undefined {
  return outcome.kind === 'refused'
    ? {
        tierId: encoded,
        reason: outcome.failure.kind === 'refused' ? 'refused' : 'unconfirmed',
        failure: outcome.failure
      }
    : undefined
}

/** Holds the pass, with the chat and its fence kept, until a pick or a recheck wakes it. */
async function parkOnSpeedBlock(
  state: StructuredLaunchState,
  block: StructuredLaunchSpeedBlock
): Promise<void> {
  state.speedBlock = block
  notifyStructuredLaunchListeners()
  await new Promise<void>((resolve) => {
    state.releaseSpeedBlock = resolve
  })
  delete state.releaseSpeedBlock
  delete state.speedBlock
  notifyStructuredLaunchListeners()
}

/**
 * Tries a launch parked on its chosen speed again, as a refreshed catalog or an updated host may
 * now allow it. False when the launch is not parked.
 */
export function recheckStructuredAgentSessionLaunchSpeed(sessionId: string): boolean {
  const release = getStructuredLaunchStateBySessionId(sessionId)?.releaseSpeedBlock
  release?.()
  return release !== undefined
}

/**
 * Applies the picks held during launch against the create receipt's fence, model first so an
 * effort lands under the model it was picked against, until none is left. A refused pick is
 * reported to its picker and never keeps the launch from publishing, except the speed: a speed
 * the host did not take, or a host that no longer affirms the one the chat runs, parks the launch
 * with its chat, fence and staged text kept, until a pick or a recheck wakes it.
 */
export async function applyStructuredLaunchHeldOptions(
  state: StructuredLaunchState,
  receipt: StructuredAgentLaunchReceipt
): Promise<StructuredAgentLaunchReceipt> {
  // Stored before any held speed is applied, so a block keeps the chat it blocks.
  state.receipt = receipt
  if (state.selection.held.serviceTier !== undefined) {
    notifyStructuredLaunchListeners()
  }
  for (;;) {
    if (state.cancelled) {
      throw new StructuredAgentSessionLaunchCancelledError()
    }
    const { held } = state.selection
    const id = STRUCTURED_LAUNCH_SEED_OPTION_IDS.find((key) => held[key] !== undefined)
    const encoded = id ? held[id] : undefined
    if (!id || encoded === undefined) {
      // The last look before publication: a speed the chat runs still needs a host that affirms it.
      const tierId = codexSeedSpeedTier(state.intent.agent, state.selection.seed)
      const unpublishable =
        tierId === undefined ? undefined : await readCodexSpeedBlock(state.intent.target, tierId)
      if (!unpublishable) {
        return receipt
      }
      await parkOnSpeedBlock(state, unpublishable)
      continue
    }
    const outcome = await setLaunchOption(
      state.intent.target,
      state.intent.sessionId,
      receipt.fence,
      id,
      encoded
    )
    const speedBlock = id === 'serviceTier' ? speedWriteBlock(encoded, outcome) : undefined
    // A speed picked again while this one was in flight is the one to send next, not to block on.
    if (speedBlock && state.selection.held.serviceTier === encoded) {
      replyToHeldOption(state, id, outcome)
      await parkOnSpeedBlock(state, speedBlock)
      continue
    }
    settleHeldOption(state, id, encoded, outcome)
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
