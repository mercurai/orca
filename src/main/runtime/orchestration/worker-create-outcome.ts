import { isDefinitiveAgentSessionCreateRefusal } from '../../../shared/agent-session-definitive-refusal'
import { parseAgentSessionOperationTimestamp } from '../../../shared/agent-session-host-authority'
import { isAgentSessionId } from '../../../shared/agent-session-record'
import {
  isAgentSessionRefusalError,
  type AgentSessionRefusalError
} from '../../../shared/agent-session-wire-refusals'
import { isGeneratedId } from './db/generated-id'

export const STRUCTURED_CREATE_REFUSAL_KIND = 'structured_create_refusal'
export const STRUCTURED_CREATE_REFUSAL_SCHEMA = 'orca.worker-create-refusal.v1'
export const STRUCTURED_CREATE_REFUSAL_CODE = 'structured_agent_session_unsupported'

const STRUCTURED_CREATE_REFUSAL_KEYS = [
  'kind',
  'schema',
  'runId',
  'taskId',
  'dispatchId',
  'runtimeEpoch',
  'sessionId',
  'clientOperationId',
  'refusalCode'
] as const

export type StructuredCreateRefusalAttempt = {
  runId: string
  taskId: string
  dispatchId: string
  runtimeEpoch: string
  sessionId: string
  clientOperationId: string
}

export type StructuredCreateRefusalEffect = StructuredCreateRefusalAttempt & {
  kind: typeof STRUCTURED_CREATE_REFUSAL_KIND
  schema: typeof STRUCTURED_CREATE_REFUSAL_SCHEMA
  refusalCode: typeof STRUCTURED_CREATE_REFUSAL_CODE
}

type StartingDispatchIdentity = {
  id: string
  run_id: string
  task_id: string
  status: string
}

type StartingWorkerIdentity = {
  dispatch_id: string
  runtime_epoch: string | null
  state: string
  start_options: string
}

type WorkerCreateAttemptDb = {
  getDispatchContextById: (dispatchId: string) => StartingDispatchIdentity | undefined
  getWorkerDispatch: (dispatchId: string) => StartingWorkerIdentity | undefined
  getFederatedDispatch: (dispatchId: string) => unknown
}

const refusalEffectsByError = new WeakMap<AgentSessionRefusalError, StructuredCreateRefusalEffect>()

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isAttempt(value: unknown): value is StructuredCreateRefusalAttempt {
  if (!isRecord(value)) {
    return false
  }
  return (
    typeof value.runId === 'string' &&
    isGeneratedId(value.runId, 'run') &&
    typeof value.taskId === 'string' &&
    isGeneratedId(value.taskId, 'task') &&
    typeof value.dispatchId === 'string' &&
    isGeneratedId(value.dispatchId, 'ctx') &&
    hasText(value.runtimeEpoch) &&
    isAgentSessionId(value.sessionId) &&
    typeof value.clientOperationId === 'string' &&
    parseAgentSessionOperationTimestamp(value.clientOperationId) !== null
  )
}

/** Captures only the current local Pi attempt; session and operation IDs are added at create. */
export function readLocalPiCreateAttempt(
  db: WorkerCreateAttemptDb,
  dispatchId: string
): Omit<StructuredCreateRefusalAttempt, 'sessionId' | 'clientOperationId'> | undefined {
  const dispatch = db.getDispatchContextById(dispatchId)
  const worker = db.getWorkerDispatch(dispatchId)
  const runtimeEpoch = worker?.runtime_epoch
  if (
    !dispatch ||
    dispatch.id !== dispatchId ||
    dispatch.status !== 'pending' ||
    !worker ||
    worker.dispatch_id !== dispatchId ||
    worker.state !== 'starting' ||
    !hasText(runtimeEpoch) ||
    db.getFederatedDispatch(dispatchId)
  ) {
    return undefined
  }
  try {
    const startOptions: unknown = JSON.parse(worker.start_options)
    if (!isRecord(startOptions) || startOptions.agent !== 'pi') {
      return undefined
    }
  } catch {
    return undefined
  }
  return {
    runId: dispatch.run_id,
    taskId: dispatch.task_id,
    dispatchId,
    runtimeEpoch
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Only the exact v1 effect is eligible for the admission exception. */
export function isStructuredCreateRefusalEffect(
  value: unknown
): value is StructuredCreateRefusalEffect {
  if (!isRecord(value)) {
    return false
  }
  const keys = Object.keys(value).sort()
  if (
    keys.length !== STRUCTURED_CREATE_REFUSAL_KEYS.length ||
    keys.some((key, index) => key !== [...STRUCTURED_CREATE_REFUSAL_KEYS].sort()[index])
  ) {
    return false
  }
  return (
    value.kind === STRUCTURED_CREATE_REFUSAL_KIND &&
    value.schema === STRUCTURED_CREATE_REFUSAL_SCHEMA &&
    value.refusalCode === STRUCTURED_CREATE_REFUSAL_CODE &&
    isAttempt(value)
  )
}

/**
 * Attaches host-observed provenance to the actual typed refusal object. The WeakMap is the
 * transport: a caller-provided effects object cannot become trusted persistence input.
 */
export function rememberStructuredCreateRefusal(
  error: AgentSessionRefusalError,
  attempt: StructuredCreateRefusalAttempt
): void {
  if (
    !isAgentSessionRefusalError(error) ||
    error.refusal.code !== STRUCTURED_CREATE_REFUSAL_CODE ||
    !isDefinitiveAgentSessionCreateRefusal(error.refusal.code) ||
    !isAttempt(attempt)
  ) {
    return
  }
  const effect = {
    kind: STRUCTURED_CREATE_REFUSAL_KIND,
    schema: STRUCTURED_CREATE_REFUSAL_SCHEMA,
    ...attempt,
    refusalCode: STRUCTURED_CREATE_REFUSAL_CODE
  }
  if (isStructuredCreateRefusalEffect(effect)) {
    refusalEffectsByError.set(error, effect)
  }
}

/** Returns provenance only for the exact refusal error observed at the local create boundary. */
export function readStructuredCreateRefusal(
  error: unknown
): StructuredCreateRefusalEffect | undefined {
  if (!isAgentSessionRefusalError(error)) {
    return undefined
  }
  const effect = refusalEffectsByError.get(error)
  return effect && isStructuredCreateRefusalEffect(effect) ? effect : undefined
}

export function hasEligibleStructuredCreateRefusal(
  effects: unknown[],
  expected: Pick<StructuredCreateRefusalAttempt, 'runId' | 'taskId' | 'dispatchId' | 'runtimeEpoch'>
): boolean {
  const proofs = effects.filter(
    (effect) => isRecord(effect) && effect.kind === STRUCTURED_CREATE_REFUSAL_KIND
  )
  if (proofs.length !== 1 || !isStructuredCreateRefusalEffect(proofs[0])) {
    return false
  }
  const proof = proofs[0]
  if (
    proof.runId !== expected.runId ||
    proof.taskId !== expected.taskId ||
    proof.dispatchId !== expected.dispatchId ||
    proof.runtimeEpoch !== expected.runtimeEpoch
  ) {
    return false
  }
  return !effects.some((effect) => {
    if (!isRecord(effect)) {
      return false
    }
    return effect.kind === 'terminal' || effect.kind === 'session' || effect.kind === 'structured_session'
  })
}

function reservedEffects(effects: unknown[]): unknown[] {
  return effects.filter((effect) => isRecord(effect) && effect.kind === STRUCTURED_CREATE_REFUSAL_KIND)
}

/** Generic local writers may preserve an authenticated proof, but cannot mint or replace one. */
export function assertWorkerEffectWritePreservesStructuredCreateRefusal(
  currentEffects: unknown[],
  proposedEffects: unknown[]
): void {
  const currentReserved = reservedEffects(currentEffects)
  const proposedReserved = reservedEffects(proposedEffects)
  if (proposedReserved.length > 0 && currentReserved.length === 0) {
    throw new Error('structured_create_refusal is reserved for the atomic local failure writer')
  }
  if (currentReserved.length > 0 && JSON.stringify(currentEffects) !== JSON.stringify(proposedEffects)) {
    throw new Error('structured_create_refusal cannot be replaced by a generic worker writer')
  }
}

