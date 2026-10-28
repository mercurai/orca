import type { WorkerDispatchRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'
import { transitionLifecycleWithDb } from '../lifecycle-transition'
import { recordFailedStartDispatchIdentity } from '../worker-terminal/failed-start-dispatch-identity'
import {
  assertWorkerEffectWritePreservesStructuredCreateRefusal,
  isStructuredCreateRefusalEffect,
  readStructuredCreateRefusal,
  STRUCTURED_CREATE_REFUSAL_KIND
} from '../../worker-create-outcome'

function parseEffects(value: string): unknown[] | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export function markWorkerDispatchReady(
  this: OrchestrationDb,
  dispatchId: string,
  effects?: unknown[]
): WorkerDispatchRow {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const dispatch = this.getDispatchContextById(dispatchId)
    const worker = this.getWorkerDispatch(dispatchId)
    if (!dispatch || dispatch.status !== 'pending' || worker?.state !== 'starting') {
      throw new OrchestrationError('dispatch_inactive', `Dispatch ${dispatchId} is not starting.`)
    }
    if (effects && !this.getFederatedDispatch(dispatchId)) {
      assertWorkerEffectWritePreservesStructuredCreateRefusal(
        parseEffects(worker.effects) ?? [],
        effects
      )
    }
    transitionLifecycleWithDb(this.db, {
      entity: 'dispatch',
      id: dispatchId,
      from: 'pending',
      to: 'dispatched'
    })
    transitionLifecycleWithDb(this.db, {
      entity: 'worker',
      id: dispatchId,
      from: 'starting',
      to: 'ready',
      projection: {
        stage: 'input_accepted',
        effects: effects ? JSON.stringify(effects) : worker.effects
      }
    })
    this.db.exec('COMMIT')
    return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function failWorkerStart(
  this: OrchestrationDb,
  dispatchId: string,
  stage: string,
  reason: string,
  createError?: unknown
): WorkerDispatchRow {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const dispatch = this.getDispatchContextById(dispatchId)
    const worker = this.getWorkerDispatch(dispatchId)
    if (!dispatch || !worker || worker.state !== 'starting') {
      throw new OrchestrationError('dispatch_inactive', `Dispatch ${dispatchId} is not starting.`)
    }
    const createRefusal = readStructuredCreateRefusal(createError)
    const currentEffects = parseEffects(worker.effects)
    const effects = createRefusal
      ? validateAndAppendStructuredCreateRefusal(this, dispatch, worker, currentEffects, createRefusal)
      : undefined
    const now = new Date().toISOString()
    transitionLifecycleWithDb(this.db, {
      entity: 'dispatch',
      id: dispatchId,
      from: dispatch.status,
      to: 'failed',
      projection: {
        last_failure: reason,
        completed_at: now,
        capability_revoked_at: dispatch.capability_revoked_at ?? now
      }
    })
    transitionLifecycleWithDb(this.db, {
      entity: 'worker',
      id: dispatchId,
      from: 'starting',
      to: 'failed',
      projection: {
        stage,
        last_error: reason,
        updated_at: now,
        ...(effects ? { effects: JSON.stringify(effects) } : {})
      }
    })
    const hasActiveDispatch = Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM dispatch_contexts
           WHERE task_id = ? AND status IN ('pending', 'dispatched') LIMIT 1`
        )
        .get(dispatch.task_id)
    )
    const task = this.getTask(dispatch.task_id)
    if (!hasActiveDispatch && task && task.status !== 'completed') {
      transitionLifecycleWithDb(this.db, {
        entity: 'task',
        id: dispatch.task_id,
        from: task.status,
        to: 'failed',
        projection: { completed_at: now }
      })
    }
    this.closeQuestionsForDispatch(dispatchId)
    recordFailedStartDispatchIdentity(this, this.getWorkerDispatch(dispatchId) as WorkerDispatchRow)
    this.db.exec('COMMIT')
    return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

function validateAndAppendStructuredCreateRefusal(
  db: OrchestrationDb,
  dispatch: { id: string; run_id: string; task_id: string; status: string },
  worker: { dispatch_id: string; runtime_epoch: string | null; state: string; start_options: string },
  currentEffects: unknown[] | undefined,
  refusal: ReturnType<typeof readStructuredCreateRefusal>
): unknown[] {
  if (
    !refusal ||
    !currentEffects ||
    dispatch.id !== refusal.dispatchId ||
    dispatch.status !== 'pending' ||
    worker.dispatch_id !== refusal.dispatchId ||
    worker.state !== 'starting' ||
    worker.runtime_epoch !== refusal.runtimeEpoch ||
    dispatch.run_id !== refusal.runId ||
    dispatch.task_id !== refusal.taskId ||
    db.getFederatedDispatch(refusal.dispatchId)
  ) {
    throw new Error('structured_create_refusal is not bound to the current local worker attempt')
  }
  let startOptions: unknown
  try {
    startOptions = JSON.parse(worker.start_options)
  } catch {
    throw new Error('structured_create_refusal requires valid worker start options')
  }
  if (
    !startOptions ||
    typeof startOptions !== 'object' ||
    Array.isArray(startOptions) ||
    !('agent' in startOptions) ||
    startOptions.agent !== 'pi' ||
    !isStructuredCreateRefusalEffect(refusal)
  ) {
    throw new Error('structured_create_refusal is only valid for a local Pi worker')
  }
  if (currentEffects.some(
    (effect) =>
      typeof effect === 'object' &&
      effect !== null &&
      !Array.isArray(effect) &&
      'kind' in effect &&
      effect.kind === STRUCTURED_CREATE_REFUSAL_KIND
  )) {
    throw new Error('structured_create_refusal proof already exists')
  }
  return [...currentEffects, refusal]
}

export function markWorkerStartUnknown(
  this: OrchestrationDb,
  dispatchId: string,
  stage: string,
  reason: string,
  effects?: unknown[]
): WorkerDispatchRow {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const dispatch = this.getDispatchContextById(dispatchId)
    const worker = this.getWorkerDispatch(dispatchId)
    if (!dispatch || !worker || worker.state !== 'starting') {
      throw new OrchestrationError('dispatch_inactive', `Dispatch ${dispatchId} is not starting.`)
    }
    transitionLifecycleWithDb(this.db, {
      entity: 'worker',
      id: dispatchId,
      from: 'starting',
      to: 'start_unknown',
      projection: {
        stage,
        last_error: reason,
        updated_at: new Date().toISOString(),
        ...(effects ? { effects: JSON.stringify(effects) } : {})
      }
    })
    transitionLifecycleWithDb(this.db, {
      entity: 'dispatch',
      id: dispatchId,
      from: dispatch.status,
      to: dispatch.status
    })
    transitionLifecycleWithDb(this.db, {
      entity: 'task',
      id: dispatch.task_id,
      from: 'dispatched',
      to: 'blocked'
    })
    // Authority survives uncertainty, so its outstanding questions must remain answerable.
    this.db.exec('COMMIT')
    return this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function getWorkerDispatch(
  this: OrchestrationDb,
  dispatchId: string
): WorkerDispatchRow | undefined {
  return this.db
    .prepare('SELECT * FROM worker_dispatches WHERE dispatch_id = ?')
    .get(dispatchId) as WorkerDispatchRow | undefined
}

export type WorkerDispatchOutcomeMethods = {
  markWorkerDispatchReady: typeof markWorkerDispatchReady
  failWorkerStart: typeof failWorkerStart
  markWorkerStartUnknown: typeof markWorkerStartUnknown
  getWorkerDispatch: typeof getWorkerDispatch
}

export function attachWorkerDispatchOutcome(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    markWorkerDispatchReady,
    failWorkerStart,
    markWorkerStartUnknown,
    getWorkerDispatch
  })
}
