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
import { saveStagedStructuredLaunchPromptsInComposer } from './structured-agent-session-launch-prompt'

/** The two spellings of one requested speed: the canonical tier and the legacy Fast boolean. */
const SPEED_OPTION_IDS: readonly string[] = ['serviceTier', 'fastMode']

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
 * has published, is gone or has taken its last look: the pick then goes through the session like
 * any other.
 */
export function holdStructuredAgentSessionLaunchOption(
  sessionId: string,
  id: string,
  encoded: string
): Promise<StructuredLaunchOptionOutcome> | null {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  if (!state || state.cancelled || state.picksClosed || state.callers.outcome === 'published') {
    return null
  }
  const replies = repliesFor(state)
  const { held } = state.selection
  // A model pick drops picks held under the model it replaces, but not the speed: that is the
  // person's own intent, in either spelling, and outlives the model it was picked under. A speed
  // pick is the newest word on the one requested speed, so it replaces the other spelling too.
  const replaced = SPEED_OPTION_IDS.includes(id)
    ? SPEED_OPTION_IDS
    : id === 'model'
      ? Object.keys(held).filter((key) => !SPEED_OPTION_IDS.includes(key))
      : [id]
  for (const key of replaced) {
    replies.get(key)?.({ kind: 'superseded' })
    replies.delete(key)
  }
  state.selection = {
    ...state.selection,
    held: {
      ...Object.fromEntries(Object.entries(held).filter(([key]) => !replaced.includes(key))),
      [id]: encoded
    }
  }
  // A launch parked on its speed tries again with whatever was just picked.
  state.releaseSpeedBlock?.()
  notifyStructuredLaunchListeners()
  return new Promise((resolve) => replies.set(id, resolve))
}

/** The launch ended before these picks could apply: their pickers hear that, and none stays open. */
function supersedeHeldOptions(state: StructuredLaunchState): void {
  const replies = optionReplies.get(state)
  for (const reply of replies?.values() ?? []) {
    reply({ kind: 'superseded' })
  }
  replies?.clear()
}

function throwIfLaunchCancelled(state: StructuredLaunchState): void {
  if (state.cancelled) {
    supersedeHeldOptions(state)
    throw new StructuredAgentSessionLaunchCancelledError()
  }
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

/** What the host runs after it took `id`: the accepted options over the seed, with the other
 *  spelling of a speed gone unless the host still reports it. */
function acceptedSeed(
  seed: StructuredLaunchSelection['seed'],
  id: string,
  options: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  const { serviceTier, fastMode, ...rest } = { ...seed, ...options }
  return {
    ...rest,
    ...(serviceTier !== undefined && !(id === 'fastMode' && options.serviceTier === undefined)
      ? { serviceTier }
      : {}),
    ...(fastMode !== undefined && !(id === 'serviceTier' && options.fastMode === undefined)
      ? { fastMode }
      : {})
  }
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
    seed: outcome.kind === 'accepted' ? acceptedSeed(seed, id, outcome.options) : seed,
    held: settled ? rest : state.selection.held
  }
  // The block names the speed asked for: only an accepted replacement ends it.
  if (settled && outcome.kind === 'accepted' && SPEED_OPTION_IDS.includes(id)) {
    delete state.speedBlock
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

/**
 * Holds the pass, with the chat and its fence kept, until a pick or a recheck wakes it. The block
 * stays through the wake: it names the speed asked for, and only an accepted replacement or a host
 * that affirms the speed ends it, so a reload meanwhile still finds it.
 */
async function parkOnSpeedBlock(
  state: StructuredLaunchState,
  block: StructuredLaunchSpeedBlock
): Promise<void> {
  state.speedBlock = block
  // The staged first turn is also saved in the chat's composer, which a reload gives back.
  saveStagedStructuredLaunchPromptsInComposer(state.intent.sessionId)
  notifyStructuredLaunchListeners()
  await new Promise<void>((resolve) => {
    state.releaseSpeedBlock = resolve
  })
  delete state.releaseSpeedBlock
  notifyStructuredLaunchListeners()
}

/**
 * Tries a launch on its chosen speed again, as a refreshed catalog or an updated host may now
 * allow it: wakes it when parked, and tells a pass still asking the host to ask once more. False
 * when no pass is waiting on a speed.
 */
export function recheckStructuredAgentSessionLaunchSpeed(sessionId: string): boolean {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  if (state?.releaseSpeedBlock) {
    state.releaseSpeedBlock()
    return true
  }
  const passing = state?.receipt && !state.cancelled && !state.picksClosed
  if (!state || !passing || state.callers.outcome !== 'pending') {
    return false
  }
  state.speedRecheckRequested = true
  return true
}

/**
 * Whether the host affirms `tierId` for this pass. A "no" stands for the canonical speed picked
 * while the question was in flight and parks the launch on it; a "yes" says nothing about what was
 * picked since, so that is asked again. False when the pass must look again or has parked.
 */
async function hostAffirmsSpeed(
  state: StructuredLaunchState,
  selection: StructuredLaunchSelection,
  tierId: string
): Promise<boolean> {
  delete state.speedRecheckRequested
  const stopped = await readCodexSpeedBlock(state.intent.target, tierId)
  throwIfLaunchCancelled(state)
  const moved = state.selection !== selection
  if (!stopped) {
    return !moved
  }
  const blockedTierId = moved ? state.selection.held.serviceTier : tierId
  // A recheck that arrived during the question was not answered by it: ask again, never park on it.
  if (blockedTierId !== undefined && !state.speedRecheckRequested) {
    await parkOnSpeedBlock(state, { ...stopped, tierId: blockedTierId })
  }
  return false
}

/**
 * Applies the picks held during launch against the create receipt's fence, model first so an
 * effort lands under the model it was picked against, until none is left. A refused pick is
 * reported to its picker and never keeps the launch from publishing, except the speed: a speed
 * the host did not take, or a host that no longer affirms the one the chat runs, parks the launch
 * with its chat, fence and staged text kept, until a pick or a recheck wakes it.
 *
 * Every await re-reads the selection and the cancellation, so a pick or a close that lands while
 * the host is asked or written to is applied or ended, never published past. The pass returns, and
 * stops taking picks, only from a look at which nothing was held and the host affirmed the speed.
 */
export async function applyStructuredLaunchHeldOptions(
  state: StructuredLaunchState,
  receipt: StructuredAgentLaunchReceipt
): Promise<StructuredAgentLaunchReceipt> {
  // Stored before any held speed is applied, so a block keeps the chat it blocks.
  state.receipt = receipt
  if (SPEED_OPTION_IDS.some((key) => state.selection.held[key] !== undefined)) {
    notifyStructuredLaunchListeners()
  }
  for (;;) {
    throwIfLaunchCancelled(state)
    const selection = state.selection
    const id = STRUCTURED_LAUNCH_SEED_OPTION_IDS.find((key) => selection.held[key] !== undefined)
    const encoded = id ? selection.held[id] : undefined
    // The speed the host must affirm for this pass: the canonical tier it writes or, at the last look
    // before publication, the one the chat runs. Standard is one too; the legacy Fast boolean is not.
    const tierId =
      id === undefined
        ? codexSeedSpeedTier(state.intent.agent, selection.seed)
        : id === 'serviceTier' && state.intent.agent === 'codex'
          ? encoded
          : undefined
    if (tierId !== undefined && !(await hostAffirmsSpeed(state, selection, tierId))) {
      continue
    }
    if (id === undefined || encoded === undefined) {
      delete state.speedBlock
      state.picksClosed = true
      return receipt
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
    if (speedBlock && !state.cancelled && state.selection.held.serviceTier === encoded) {
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
