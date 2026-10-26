import { createHash } from 'node:crypto'
import {
  PiWorkerAdmissionConfigSchema,
  type PiWorkerAdmissionConfig
} from '../../../../../shared/pi-worker-admission'
import {
  runBoundToCoordinator,
  runCoordinatorKey,
  type OrchestrationCoordinatorKey
} from '../../orchestration-caller-identity'
import { OrchestrationError } from '../../orchestration-error'
import type { DecisionGateRow, TaskRow } from '../../types'
import type { OrchestrationDb } from '../orchestration-db'

// Existing worker rows are the reservations. Abandonment and an unproven failure do not establish
// exit; only exact accepted settlement or a confirmed process stop releases a slot.
const ACTIVE_PI_WORKERS_SQL = `
  SELECT COUNT(*) AS count FROM worker_dispatches worker
  JOIN dispatch_contexts dispatch ON dispatch.id = worker.dispatch_id
  WHERE dispatch.run_id = ? AND json_extract(worker.start_options, '$.agent') = 'pi'
    AND NOT (
      (worker.state IN ('succeeded', 'failed') AND worker.stage = 'settled') OR
      (worker.state = 'failed' AND worker.stage = 'process_exited') OR
      (worker.state = 'stopped' AND worker.stage = 'process_stopped')
    )`

type StoredAdmission = {
  consumer_generation: number
  config_json: string
  config_sha256: string
}

function invalid(message: string): never {
  throw new OrchestrationError('pi_admission_invalid', message)
}

function parseConfig(value: unknown): PiWorkerAdmissionConfig {
  const parsed = PiWorkerAdmissionConfigSchema.safeParse(value)
  if (!parsed.success) invalid('Invalid Pi admission configuration fields or priced budget.')
  return parsed.data
}

function configDigest(runId: string, consumerGeneration: number, config: PiWorkerAdmissionConfig): string {
  return createHash('sha256').update(JSON.stringify({ runId, consumerGeneration, config })).digest('hex')
}

function activeReservations(db: OrchestrationDb, runId: string): number {
  const row = db.db.prepare(ACTIVE_PI_WORKERS_SQL).get(runId) as { count: number }
  return row.count
}

function requireAcceptedGate(db: OrchestrationDb, runId: string, gateId: string, label: string) {
  const gate = db.db.prepare(`
    SELECT id, run_id, task_id, status, resolution FROM decision_gates WHERE id = ?
  `).get(gateId) as Pick<DecisionGateRow, 'id' | 'run_id' | 'task_id' | 'status' | 'resolution'> | undefined
  if (!gate || gate.run_id !== runId || gate.status !== 'resolved' || gate.resolution !== 'approved') {
    invalid(`${label} gate must be approved and resolved in this Run.`)
  }
  return gate
}

function validateTaskLinks(db: OrchestrationDb, runId: string, config: PiWorkerAdmissionConfig) {
  for (const entry of config.tasks) {
    const task = db.getTask(entry.taskId)
    const review = db.getTask(entry.reviewTaskId)
    if (!task || task.run_id !== runId || !review || review.run_id !== runId ||
      review.id === task.id || !JSON.parse(review.deps).includes(task.id)) {
      invalid('Pi admission requires a same-Run implementation and linked independent review task.')
    }
    if (entry.deadlineUnixMs <= Date.now()) invalid('Pi admission task deadline has expired.')
  }
}

function validateQualification(db: OrchestrationDb, runId: string, config: PiWorkerAdmissionConfig) {
  requireAcceptedGate(db, runId, config.ciGateId, 'CI')
  if (config.maxWorkers !== 4) return
  if (!config.pilotGateId) invalid('Four-worker qualification requires accepted pilot evidence.')
  const gate = requireAcceptedGate(db, runId, config.pilotGateId, 'Pilot qualification')
  const pilotTask = db.getTask(gate.task_id)
  const pilotReviews: unknown = pilotTask ? JSON.parse(pilotTask.deps) : []
  const acceptedPilots = config.tasks.filter((entry) => {
    if (!Array.isArray(pilotReviews) || !pilotReviews.includes(entry.reviewTaskId)) return false
    const task = db.getTask(entry.taskId)
    const review = db.getTask(entry.reviewTaskId)
    const dispatch = db.getDispatchContext(entry.taskId)
    const worker = dispatch && db.getWorkerDispatch(dispatch.id)
    return task?.status === 'completed' && review?.status === 'completed' &&
      worker?.state === 'succeeded' && worker.stage === 'settled'
  })
  if (acceptedPilots.length < 2) invalid('Pilot qualification requires two accepted Pi implementations and reviews.')
}

export function configurePiWorkerAdmission(
  this: OrchestrationDb,
  params: {
    runId: string
    consumerGeneration: number
    coordinator: OrchestrationCoordinatorKey
    config: unknown
  }
): { configSha256: string } {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const run = this.getRun(params.runId)
    if (!run || run.legacy !== 0 || run.consumer_generation !== params.consumerGeneration ||
      run.coordinator_handle !== params.coordinator.terminalHandle ||
      !runBoundToCoordinator(run, params.coordinator)) {
      throw new OrchestrationError('consumer_fenced', 'Pi admission coordinator generation is fenced.')
    }
    if (activeReservations(this, run.id) > 0) {
      invalid('Cannot replace Pi admission while an affected Dispatch is active or uncertain.')
    }
    const config = parseConfig(params.config)
    validateTaskLinks(this, run.id, config)
    validateQualification(this, run.id, config)
    config.tasks.sort((left, right) => left.taskId.localeCompare(right.taskId))
    const configJson = JSON.stringify(config)
    const configSha256 = configDigest(run.id, run.consumer_generation, config)
    this.db.prepare(`
      INSERT INTO run_pi_worker_admission (run_id, consumer_generation, config_json, config_sha256)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET consumer_generation = excluded.consumer_generation,
        config_json = excluded.config_json, config_sha256 = excluded.config_sha256
    `).run(run.id, run.consumer_generation, configJson, configSha256)
    this.db.exec('COMMIT')
    return { configSha256 }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

/** Called only inside createStartingWorkerDispatch's BEGIN IMMEDIATE, before any launch effect. */
export function bindPiWorkerAdmission(
  db: OrchestrationDb,
  task: TaskRow,
  dispatchId: string,
  startOptions: unknown
): unknown {
  if (!startOptions || typeof startOptions !== 'object' || !('agent' in startOptions) ||
    startOptions.agent !== 'pi') return startOptions
  const stored = db.db.prepare(`
    SELECT consumer_generation, config_json, config_sha256 FROM run_pi_worker_admission WHERE run_id = ?
  `).get(task.run_id) as StoredAdmission | undefined
  const run = db.getRun(task.run_id)
  if (!stored || !run || run.legacy !== 0 || stored.consumer_generation !== run.consumer_generation) {
    throw new OrchestrationError('pi_admission_required', 'Pi admission requires a current coordinator grant.')
  }
  const config = parseConfig(JSON.parse(stored.config_json))
  if (configDigest(run.id, stored.consumer_generation, config) !== stored.config_sha256) {
    invalid('Pi admission configuration digest mismatch.')
  }
  validateQualification(db, run.id, config)
  const entry = config.tasks.find((candidate) => candidate.taskId === task.id)
  if (!entry || !('piProfileSha256' in startOptions) || startOptions.piProfileSha256 !== entry.profileSha256) {
    invalid('Pi worker profile does not match the configured task profile.')
  }
  if (entry.deadlineUnixMs <= Date.now()) invalid('Pi worker deadline has expired.')
  if (!('mode' in startOptions) || !startOptions.mode || typeof startOptions.mode !== 'object' ||
    !('mode' in startOptions.mode) || startOptions.mode.mode !== 'structured') {
    invalid('Supervised Pi requires a structured surface with verifiable model, profile and tools.')
  }
  if (activeReservations(db, run.id) >= config.maxWorkers) {
    throw new OrchestrationError('pi_admission_capacity', 'Pi worker capacity is reserved by active or uncertain Dispatches.')
  }
  // Count the persisted links of past implementations, even if a replacement grant omits them.
  const backlog = db.db.prepare(`
    SELECT COUNT(DISTINCT task.id) AS count FROM tasks task
    JOIN dispatch_contexts dispatch ON dispatch.task_id = task.id
    JOIN worker_dispatches worker ON worker.dispatch_id = dispatch.id
    LEFT JOIN tasks review ON review.id = json_extract(worker.start_options, '$.piAdmission.reviewTaskId')
    WHERE task.run_id = ? AND task.status = 'completed'
      AND json_extract(worker.start_options, '$.agent') = 'pi'
      AND (review.id IS NULL OR review.run_id <> task.run_id OR review.status <> 'completed')
  `).get(run.id) as { count: number }
  if (backlog.count >= 2) {
    throw new OrchestrationError('pi_admission_review_backlog', 'Pi independent review backlog is at capacity.')
  }
  return {
    ...startOptions,
    piAdmission: {
      ...entry,
      runId: run.id,
      taskId: task.id,
      dispatchId,
      consumerGeneration: run.consumer_generation,
      coordinator: runCoordinatorKey(run),
      configSha256: stored.config_sha256,
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4.1-flash-1017'
    }
  }
}

export type PiWorkerAdmissionMethods = {
  configurePiWorkerAdmission: typeof configurePiWorkerAdmission
}

export function attachPiWorkerAdmission(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, { configurePiWorkerAdmission })
}
