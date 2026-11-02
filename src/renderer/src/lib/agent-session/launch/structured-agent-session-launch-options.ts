import {
  createLegacyPrerequisites,
  type LegacyPrerequisites
} from '../../structured-agent-session-launch-prerequisites'
import {
  CodexSpeedSelectionError,
  prepareCodexSpeedWireOptions
} from '@/runtime/codex-speed-selection'
import { useSyncExternalStore } from 'react'
import { acceptedStructuredSessionSelectionOutcome } from '../../../../../shared/structured-agent-session-options-write-owner'
import { structuredSessionSelectionController } from '../../structured-agent-session-selection-controller'
import type {
  SelectionOperation,
  SelectionOutcome
} from '../../../../../shared/structured-agent-session-selection-operations'
import {
  structuredAgentSessionOptionPicks,
  type StructuredAgentSessionOptionState
} from '../../../../../shared/agent-session/options/structured-agent-session-options'
import type {
  AgentSessionMutationResult,
  AgentSessionOptionResult
} from '../../../../../shared/agent-session/agent-session-wire'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionPayloadFingerprint
} from '../../../../../shared/agent-session/lifecycle/structured-agent-session-mutation'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../shared/non-secure-context-uuid'
import {
  StructuredAgentSessionLaunchCancelledError,
  type StructuredAgentLaunchReceipt
} from './structured-agent-session-launch-recovery'
import {
  getStructuredLaunchStateBySessionId,
  notifyStructuredLaunchListeners,
  registerStructuredLaunchHeldOptionsReader,
  subscribeStructuredAgentLaunchStatus,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'
import {
  agentSessionRefusalFailure,
  agentSessionThrownFailure,
  type AgentSessionWriteFailure
} from '../../../../../shared/agent-session/failures/agent-session-write-failure'
import {
  isCodexLaunchSpeedKey,
  isStructuredLaunchSpeedBlocked,
  isSupersededBySpeedPick,
  noteStructuredLaunchSpeedReplacement,
  otherCodexLaunchSpeedKey,
  retainedStructuredLaunchSpeed,
  retainStructuredLaunchSpeed,
  waitForStructuredLaunchSpeedChange
} from '../../structured-agent-session-launch-blocked-speed'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { StructuredAgentSessionLaunchIntent } from '../../launch-structured-agent-session'

/** The options a launch starts with, replaced whole so readers can compare by identity. */
export type StructuredLaunchSelection = {
  /** The immutable create seed, until a queried host answer replaces it. */
  seed?: Readonly<Record<string, string>>
  /** Immutable action input, separate from later picker operations. */
  explicit?: Readonly<Record<string, string>>
  /** A paired server has not yet said what create seeds, so nothing can be picked against it. */
  seedPending?: true
}

export function initialStructuredLaunchSelection(
  intent: StructuredAgentSessionLaunchIntent
): StructuredLaunchSelection {
  return {
    seed: intent.seedOptions,
    ...(intent.explicitLaunchOptions ? { explicit: intent.explicitLaunchOptions } : {}),
    ...(intent.target.kind !== 'local' && !intent.seedOptions && !intent.createPrepared
      ? { seedPending: true }
      : {})
  }
}

export type StructuredLaunchOptionOutcome = SelectionOutcome

const launchControllers = new WeakMap<
  StructuredLaunchState,
  ReturnType<typeof structuredSessionSelectionController>
>()
export const structuredLaunchSelectionController = (state: StructuredLaunchState) => {
  let controller = launchControllers.get(state)
  if (!controller) {
    controller = structuredSessionSelectionController(
      state.intent.target,
      state.intent.sessionId,
      state.intent.agent
    )
    launchControllers.set(state, controller)
    // Durable launch records follow the held picks as the host answers them.
    let recorded = JSON.stringify(structuredLaunchHeldOptions(state))
    controller.subscribe(() => {
      const held = JSON.stringify(structuredLaunchHeldOptions(state))
      if (held !== recorded) {
        recorded = held
        notifyStructuredLaunchListeners()
      }
    })
  }
  return controller
}
const selectionController = structuredLaunchSelectionController
const receipts = new WeakMap<StructuredLaunchState, StructuredAgentLaunchReceipt>()
/** Create and the attached view read the same finite operation overlay. */
export function structuredLaunchOptionOverlay(
  state: StructuredLaunchState
): Record<string, string> {
  const controller = selectionController(state)
  const overlay = controller.overlay()
  // One speed intent: an older speed operation still settles on its reply but no longer shows,
  // is created with, or restores over the newest pick or the refused speed retained as intent.
  for (const key of Object.keys(overlay)) {
    // Only a speed key can be outranked, so other picks never read their operation's identity.
    const operation = isCodexLaunchSpeedKey(state, key) ? controller.current(key) : undefined
    if (operation && isSupersededBySpeedPick(state, controller, key, operation.identity)) {
      delete overlay[key]
    }
  }
  const refused = retainedStructuredLaunchSpeed(state)
  if (refused && !isSupersededBySpeedPick(state, controller, refused.key, refused.identity)) {
    overlay[refused.key] = refused.value
  }
  return overlay
}

/** Hold picks only before publication; published/missing launches use the normal session option path. */
export function holdStructuredAgentSessionLaunchOption(
  sessionId: string,
  id: string,
  encoded: string,
  /** The picker's list, under which a model pick keeps only the held values the model offers. */
  picker?: StructuredAgentSessionOptionState
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
  const model = picker
    ? (structuredAgentSessionOptionPicks(picker, { [id]: encoded })[0]?.modelId ?? null)
    : (state.selection.seed?.model ?? null)
  const controller = selectionController(state)
  const operation = controller.issue(id, encoded, model)
  supersedeOtherCodexSpeedKey(state, controller, id)
  // A refused speed is tried again under a newly picked model; a newly picked speed replaces it.
  const again = noteStructuredLaunchSpeedReplacement(state, id)
  if (again) {
    void selectionController(state).issue(again.key, again.value, model)
  }
  notifyStructuredLaunchListeners()
  const receipt = receipts.get(state)
  if (receipt) {
    void applyStructuredLaunchHeldOptions(state, receipt, false)
  }
  return operation.result
}

/** A newer pick of either Codex speed key retires an unsent older pick of the other, so the
 *  older one cannot be sent or restored over the newer. */
function supersedeOtherCodexSpeedKey(
  state: StructuredLaunchState,
  controller: ReturnType<typeof structuredSessionSelectionController>,
  key: string
): void {
  const other = otherCodexLaunchSpeedKey(state, key)
  const older = other ? controller.current(other) : undefined
  if (older && !older.outcome && !older.transmitted) {
    controller.settle(older, { kind: 'superseded' })
  }
}

/** Picks not yet answered by the host, and a refused speed awaiting a replacement; a reload
 *  restores exactly these. */
export function structuredLaunchHeldOptions(state: StructuredLaunchState): Record<string, string> {
  // Only a controller a pick already created: reading must not acquire one for every launch.
  const controller = launchControllers.get(state)
  if (!controller) {
    return {}
  }
  // A refused speed is kept as intent unless a newer pick already exists, which can be in memory
  // before the retained value is cleared; older pending speed picks never ride beside the winner.
  const refused = retainedStructuredLaunchSpeed(state)
  return {
    ...(refused && !isSupersededBySpeedPick(state, controller, refused.key, refused.identity)
      ? { [refused.key]: refused.value }
      : {}),
    ...Object.fromEntries(
      controller.pending().flatMap((operation) => {
        // Read the key once; only a speed operation needs its identity compared.
        const { key } = operation
        return isCodexLaunchSpeedKey(state, key) &&
          isSupersededBySpeedPick(state, controller, key, operation.identity)
          ? []
          : [[key, operation.value] as const]
      })
    )
  }
}

registerStructuredLaunchHeldOptionsReader(structuredLaunchHeldOptions)

export function getStructuredAgentSessionLaunchHeldOptions(
  sessionId: string
): Record<string, string> {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  return state ? structuredLaunchHeldOptions(state) : {}
}

/** A refused held speed pick is kept as intent; one answered after a newer pick is not. */
async function sendLaunchSelectionOption(
  controller: ReturnType<typeof structuredSessionSelectionController>,
  target: RuntimeClientTarget,
  sessionId: string,
  fence: number,
  operation: { key: string; value: string },
  options: { expectedEnvironmentPairingRevision?: number }
): Promise<StructuredLaunchOptionOutcome> {
  const { key, value } = operation
  const before = controller.current(key)
  const outcome = await setStructuredSessionSelectionOption(
    target,
    sessionId,
    fence,
    key,
    value,
    options,
    () => controller.isCurrent() && !getStructuredLaunchStateBySessionId(sessionId)?.cancelled
  )
  const state = getStructuredLaunchStateBySessionId(sessionId)
  if (
    state &&
    before &&
    outcome.kind === 'refused' &&
    launchControllers.get(state) === controller &&
    isCodexLaunchSpeedKey(state, key) &&
    controller.current(key) === before &&
    !isSupersededBySpeedPick(state, controller, key, before.identity)
  ) {
    retainStructuredLaunchSpeed(state, {
      key,
      value,
      failure: outcome.failure,
      identity: before.identity
    })
  }
  return outcome
}

/** A reloaded launch takes its persisted picks back as operations, model first. Records written
 *  now hold one speed key; an older record holding both keeps the existing tier-over-fast winner. */
export function restoreStructuredLaunchHeldOptions(
  state: StructuredLaunchState,
  held: Readonly<Record<string, string>>
): void {
  const model = held.model ?? state.selection.seed?.model ?? null
  const controller = selectionController(state)
  const rank = (id: string): number => (id === 'model' ? 0 : id === 'fastMode' ? 1 : 2)
  for (const [id, encoded] of Object.entries(held).sort(([a], [b]) => rank(a) - rank(b))) {
    void controller.issue(id, encoded, id === 'model' ? encoded : model)
    supersedeOtherCodexSpeedKey(state, controller, id)
  }
}

export async function setStructuredSessionSelectionOption(
  target: RuntimeClientTarget,
  sessionId: string,
  fence: number,
  key: string,
  value: string,
  options: { expectedEnvironmentPairingRevision?: number } = {},
  /** False once the owner retired or the launch was cancelled while capabilities were prepared. */
  isCurrent: () => boolean = () => true
): Promise<StructuredLaunchOptionOutcome> {
  try {
    // A speed pick is negotiated against this host right before it is sent; nothing is sent when
    // the host cannot be proved to apply exactly that speed.
    const prepared = await prepareCodexSpeedWireOptions({
      target,
      sessionId,
      options: { [key]: value }
    })
    if (!isCurrent()) {
      return { kind: 'superseded' }
    }
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
      // The conversation owner's continued pairing revision outranks the one captured for speed.
      { ...prepared.authority, ...options }
    )
    if (!result.ok) {
      return { kind: 'refused', failure: agentSessionRefusalFailure(result.refusal) }
    }
    if (wireKey === key) {
      return acceptedStructuredSessionSelectionOutcome(fields, result.value.options)
    }
    // A legacy host answers in its own key; the chat keeps the speed that was picked.
    const { [wireKey]: _legacyKey, ...rest } = result.value.options ?? { [key]: value }
    return { kind: 'accepted', options: { ...rest, [key]: value } }
  } catch (error) {
    const failure = agentSessionThrownFailure(
      error,
      error instanceof RuntimeRpcCallError ? error.code : undefined
    )
    // Speed negotiation fails before anything is sent, so it is a refusal, never an unknown write.
    return failure.kind === 'unconfirmed' && !(error instanceof CodexSpeedSelectionError)
      ? { kind: 'unknown', failure }
      : { kind: 'refused', failure }
  }
}

const prerequisites = new WeakMap<StructuredLaunchState, LegacyPrerequisites>()

/** One action decision per create attempt; picker settlement still belongs to its controller. */
export async function applyStructuredLaunchExplicitOptions(
  state: StructuredLaunchState,
  receipt: StructuredAgentLaunchReceipt
): Promise<StructuredAgentLaunchReceipt> {
  let phase = prerequisites.get(state)
  if (!phase || phase.intent !== state.intent) {
    const controller = selectionController(state)
    const intent = state.intent
    phase = createLegacyPrerequisites(
      state,
      controller,
      (key, value) =>
        controller.request((options) =>
          sendLaunchSelectionOption(
            controller,
            intent.target,
            receipt.sessionId,
            receipt.fence,
            { key, value },
            options
          )
        ),
      () => {
        void applyStructuredLaunchHeldOptions(state, receipt, false)
      }
    )
    prerequisites.set(state, phase)
    receipts.set(state, receipt)
    phase.advance?.()
  }
  let failure = await phase.decision
  // A refused held speed pauses the launch and its prompt until the user picks a replacement, even
  // when no explicit action required it; an unrelated required failure is returned as it is.
  while (
    retainedStructuredLaunchSpeed(state) &&
    (failure === undefined || retainedStructuredLaunchSpeed(state)?.failure === failure)
  ) {
    const owner = selectionController(state)
    await waitForStructuredLaunchSpeedChange(state, owner)
    if (state.cancelled) {
      throw new StructuredAgentSessionLaunchCancelledError()
    }
    // A retired owner cannot send the picked speed: fail before the opening send, keeping the draft.
    if (!owner.isCurrent()) {
      throw new Error('Conversation selection owner retired.')
    }
    await applyStructuredLaunchHeldOptions(state, receipt)
    failure = retainedStructuredLaunchSpeed(state)?.failure
  }
  return failure ? { ...receipt, configurationFailure: failure } : receipt
}

const createHeld = new WeakMap<StructuredLaunchState, readonly SelectionOperation[]>()

/** The picks a create payload is previewed from, before speed authorization is awaited: the unsent
 *  ones, and those a refused create already carried, which a retry's new capture takes again. */
export function previewStructuredLaunchCreatePicks(
  state: StructuredLaunchState
): readonly SelectionOperation[] {
  const controller = selectionController(state)
  const carried = createHeld.get(state) ?? []
  return controller
    .pending()
    .filter(
      (operation) =>
        !operation.transmitted ||
        (carried.includes(operation) &&
          !isSupersededBySpeedPick(state, controller, operation.key, operation.identity))
    )
}

/** Freeze identities, so a later equal-valued choice is a distinct operation. A pick made after the
 *  preview is not in the payload: it stays unsent for the normal option path, never marked created. */
export function holdStructuredLaunchCreatePicks(
  state: StructuredLaunchState,
  previewed?: readonly SelectionOperation[]
): void {
  const controller = selectionController(state)
  const frozen = controller.freeze(createHeld.get(state))
  const kept = previewed ? frozen.filter((operation) => previewed.includes(operation)) : frozen
  for (const operation of frozen) {
    if (kept.includes(operation)) {
      continue
    }
    // An older speed pick the newer one outranks is retired, never left unsent for the flush.
    if (isSupersededBySpeedPick(state, controller, operation.key, operation.identity)) {
      controller.settle(operation, { kind: 'superseded' })
    } else {
      operation.transmitted = false
    }
  }
  createHeld.set(state, kept)
}

export function settleStructuredLaunchCreateOptions(
  state: StructuredLaunchState,
  options: Readonly<Record<string, string>>
): void {
  for (const operation of createHeld.get(state) ?? []) {
    selectionController(state).settle(operation, { kind: 'accepted', options })
  }
  createHeld.delete(state)
}

/** All desktop senders enroll launch prerequisites before the actual operation request. */
export function flushStructuredSessionSelectionOptions(
  target: RuntimeClientTarget,
  sessionId: string,
  fence: number,
  controller: ReturnType<typeof structuredSessionSelectionController>
): Promise<AgentSessionWriteFailure | undefined> | undefined {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  const phase =
    state && launchControllers.get(state) === controller ? prerequisites.get(state) : undefined
  if (phase?.advance && phase.intent === state?.intent) {
    phase.advance()
    return phase.decision
  }
  controller.flush((operation) =>
    controller.request((options) =>
      sendLaunchSelectionOption(controller, target, sessionId, fence, operation, options)
    )
  )
  return undefined
}

/** Enqueue the current batch before attachment; later picks use this same ordered sender. */
export async function applyStructuredLaunchHeldOptions(
  state: StructuredLaunchState,
  receipt: StructuredAgentLaunchReceipt,
  waitForDrain = true
): Promise<StructuredAgentLaunchReceipt> {
  receipts.set(state, receipt)
  const controller = selectionController(state)
  const decision = flushStructuredSessionSelectionOptions(
    state.intent.target,
    receipt.sessionId,
    receipt.fence,
    controller
  )
  if (waitForDrain) {
    if (decision) {
      const failure = await decision
      return failure ? { ...receipt, configurationFailure: failure } : receipt
    }
    await controller.drain()
  }
  return receipt
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
