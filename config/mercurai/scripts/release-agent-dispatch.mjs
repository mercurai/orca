import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

import { StateConflictError } from './release-state.mjs'

const copy = (value) => structuredClone(value)
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,123}$/
const WORKTREES = new Set(['current', 'new-child', 'new-top-level'])

/**
 * A dispatch whose effect is unknown: the mutation may or may not have taken effect. The caller must
 * reconcile (request-show / worker-show) instead of launching a second worker.
 */
export class DispatchUnknownError extends Error {
  constructor(message, { code, stdout, stderr } = {}) {
    super(message)
    this.name = 'DispatchUnknownError'
    this.code = code
    this.stdout = stdout
    this.stderr = stderr
  }
}

function checkLease(state, owner) {
  if (!state.lease || state.lease.owner !== owner) {
    throw new StateConflictError('the coordinator does not own the active lease')
  }
}

function checkVersion(state, expectedVersion) {
  if (!Number.isInteger(expectedVersion) || expectedVersion !== state.version) {
    throw new StateConflictError(
      `state version ${state.version} does not match expected ${expectedVersion}`
    )
  }
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} is required`)
  }
}

/** The task text the worker will run. It must be concrete: a placeholder would be dispatched verbatim. */
export function checkTaskSpec(taskSpec) {
  requireText(taskSpec, 'taskSpec')
  if (/<[A-Za-z][A-Za-z0-9 _-]*>/.test(taskSpec)) {
    throw new TypeError('taskSpec must not contain <placeholder> values')
  }
  if (taskSpec.includes('\0')) {
    throw new TypeError('taskSpec must not contain NUL bytes')
  }
}

export function requestIdFor(slotId, stage) {
  const base = slotId ?? 'generation'
  const id = `${base}:${stage}`
  if (!REQUEST_ID.test(id)) {
    throw new TypeError(`request id ${id} is not a valid orchestration request id`)
  }
  return id
}

/**
 * Structured argv for the three orchestration mutations. Each carries its own persisted retry id, so a
 * retry after an unknown result replays that mutation instead of creating a second run, task or worker.
 */
export function buildDispatchPlan(
  state,
  { owner, objective, taskSpec, taskTitle, slotId, worktree = 'new-child', agent = 'codex' } = {}
) {
  checkLease(state, owner)
  requireText(objective, 'objective')
  requireText(taskTitle, 'taskTitle')
  checkTaskSpec(taskSpec)
  if (!WORKTREES.has(worktree)) {
    throw new TypeError(`worktree must be one of ${[...WORKTREES].join(', ')}`)
  }
  requireText(agent, 'agent')
  return {
    generation: state.generation,
    slotId: slotId ?? `generation:${state.generation}`,
    runArgs: [
      'orchestration',
      'run-create',
      '--objective',
      objective,
      '--retry-request',
      requestIdFor(slotId, 'run'),
      '--json'
    ],
    taskArgs: [
      'orchestration',
      'task-create',
      '--run',
      '<runId>',
      '--spec',
      taskSpec,
      '--task-title',
      taskTitle,
      '--retry-request',
      requestIdFor(slotId, 'task'),
      '--json'
    ],
    workerArgs: [
      'orchestration',
      'worker-start',
      '--task',
      '<taskId>',
      '--run',
      '<runId>',
      '--worktree',
      worktree,
      '--name',
      taskTitle,
      '--agent',
      agent,
      '--setup',
      'run',
      '--retry-request',
      requestIdFor(slotId, 'worker'),
      '--json'
    ]
  }
}

export function taskSpecDigest(taskSpec) {
  checkTaskSpec(taskSpec)
  return createHash('sha256').update(taskSpec).digest('hex')
}

/** `run` may return the parsed envelope, the raw `result` object, or `{code, stdout, stderr}`. */
function readReceipt(value, label) {
  if (!value || typeof value !== 'object') {
    throw new TypeError(`${label} returned no result`)
  }
  if (typeof value.code === 'number') {
    const stdout = typeof value.stdout === 'string' ? value.stdout.trim() : ''
    if (stdout.length === 0) {
      return { envelope: null, code: value.code, stderr: value.stderr ?? '' }
    }
    try {
      return { envelope: JSON.parse(stdout), code: value.code, stderr: value.stderr ?? '' }
    } catch {
      return { envelope: null, code: value.code, stderr: value.stderr ?? '' }
    }
  }
  return { envelope: value, code: 0, stderr: '' }
}

function resultOf(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    return null
  }
  return envelope.result && typeof envelope.result === 'object' ? envelope.result : envelope
}

function runIdOf(envelope) {
  const result = resultOf(envelope)
  const nested = result?.run?.id ?? result?.runId
  return typeof nested === 'string' && nested.length > 0 ? nested : null
}

function taskIdOf(envelope) {
  const result = resultOf(envelope)
  const nested = result?.task?.id ?? result?.taskId
  return typeof nested === 'string' && nested.length > 0 ? nested : null
}

function dispatchOf(envelope) {
  const result = resultOf(envelope)
  const id = result?.dispatchId ?? result?.dispatch?.id
  if (typeof id !== 'string' || id.length === 0) {
    return null
  }
  return { dispatchId: id, state: typeof result.state === 'string' ? result.state : null }
}

function mergeRequestEvidence(state, request) {
  return {
    ...copy(state.evidence),
    dispatchRequest: { ...state.evidence?.dispatchRequest, ...request }
  }
}

/**
 * Durable acceptance for one bounded worker: persist intent, create run/task, start the worker, and
 * persist every returned id before the next mutation. Resuming uses the recorded ids, never a fresh
 * mutation, so a crash between any two steps cannot create a duplicate.
 */
export async function executeDispatch({
  state,
  expectedVersion,
  owner,
  objective,
  taskSpec,
  taskTitle,
  slotId,
  worktree,
  agent,
  run,
  persist
} = {}) {
  checkVersion(state, expectedVersion)
  const plan = buildDispatchPlan(state, {
    owner,
    objective,
    taskSpec,
    taskTitle,
    slotId,
    worktree,
    agent
  })
  if (typeof run !== 'function') {
    throw new TypeError('run callback is required')
  }
  if (persist !== undefined && typeof persist !== 'function') {
    throw new TypeError('persist must be a callback')
  }

  const existing =
    state.dispatch?.generation === state.generation && state.dispatch?.owner === owner
      ? state.dispatch
      : null
  if (existing?.dispatchId) {
    return { state: copy(state), dispatch: copy(existing), resumed: true, plan }
  }

  const intent = {
    slotId: plan.slotId,
    specDigest: taskSpecDigest(taskSpec),
    retryRequests: {
      run: requestIdFor(slotId, 'run'),
      task: requestIdFor(slotId, 'task'),
      worker: requestIdFor(slotId, 'worker')
    }
  }

  let runId = existing?.runId ?? null
  if (!runId) {
    const receipt = readReceipt(await run(plan.runArgs), 'run-create')
    runId = runIdOf(receipt.envelope)
    if (!runId) {
      throw new DispatchUnknownError(
        `run-create returned no run id (exit ${receipt.code})${receipt.stderr ? `: ${String(receipt.stderr).trim()}` : ''}`,
        receipt
      )
    }
  }
  let next = {
    ...copy(state),
    version: state.version + 1,
    dispatch: { generation: state.generation, owner, runId },
    evidence: mergeRequestEvidence(
      { ...copy(state), evidence: { ...copy(state.evidence), dispatch: { generation: state.generation, owner, runId } } },
      intent
    )
  }
  if (!existing?.runId && persist) {
    await persist(next)
  }

  let taskId = existing?.taskId ?? null
  if (!taskId) {
    const receipt = readReceipt(
      await run(plan.taskArgs.map((value) => (value === '<runId>' ? runId : value))),
      'task-create'
    )
    taskId = taskIdOf(receipt.envelope)
    if (!taskId) {
      throw new DispatchUnknownError(
        `task-create returned no task id (exit ${receipt.code})${receipt.stderr ? `: ${String(receipt.stderr).trim()}` : ''}`,
        receipt
      )
    }
  }
  next = {
    ...next,
    version: next.version + 1,
    dispatch: { ...next.dispatch, taskId },
    evidence: { ...copy(next.evidence), dispatch: { ...next.dispatch, taskId } }
  }
  if (!existing?.taskId && persist) {
    await persist(next)
  }

  const workerReceipt = readReceipt(
    await run(
      plan.workerArgs.map((value) => {
        if (value === '<taskId>') {
          return taskId
        }
        if (value === '<runId>') {
          return runId
        }
        return value
      })
    ),
    'worker-start'
  )
  const started = dispatchOf(workerReceipt.envelope)
  if (!started) {
    // No receipt: the mutation may have taken effect. Keep run/task so the retry replays that exact
    // request id instead of creating another worker.
    throw new DispatchUnknownError(
      `worker-start returned no dispatch receipt (exit ${workerReceipt.code})${workerReceipt.stderr ? `: ${String(workerReceipt.stderr).trim()}` : ''}`,
      workerReceipt
    )
  }

  const dispatch = { ...next.dispatch, dispatchId: started.dispatchId }
  next = {
    ...next,
    version: next.version + 1,
    dispatch,
    evidence: {
      ...copy(next.evidence),
      dispatch,
      dispatchReceipt: {
        generation: state.generation,
        dispatchId: started.dispatchId,
        state: started.state,
        // A nonzero exit with a receipt is an accepted, unsettled dispatch, not a failure.
        acceptedOnNonzeroExit: workerReceipt.code !== 0
      }
    }
  }
  if (persist) {
    await persist(next)
  }
  return {
    state: next,
    dispatch,
    receipt: started,
    plan
  }
}

export function executionVerdict({ connected, process } = {}) {
  if (process === 'exited') {
    return 'exited'
  }
  if (connected && process === 'known') {
    return 'live'
  }
  return 'unverifiable'
}

function flags(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) {
      continue
    }
    values.set(argv[index].slice(2), argv[index + 1])
    index += 1
  }
  return values
}

function runOrca(argv) {
  return new Promise((resolve, reject) => {
    const child = spawn('orca', argv, { shell: false, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', reject)
    // A nonzero exit can still carry a structured receipt (an accepted but unsettled worker), so the
    // code is returned rather than thrown.
    child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

if (process.argv[1] && process.argv[1].endsWith('release-agent-dispatch.mjs')) {
  const values = flags(process.argv.slice(2))
  const statePath = values.get('state')
  const owner = values.get('owner')
  const objective = values.get('objective')
  const taskTitle = values.get('task-title')
  const taskSpecPath = values.get('spec-file')
  const slotId = values.get('slot')
  const expectedVersion = Number(values.get('expected-version'))
  if (
    !statePath ||
    !owner ||
    !objective ||
    !taskTitle ||
    !taskSpecPath ||
    !Number.isInteger(expectedVersion)
  ) {
    console.error(
      'usage: node release-agent-dispatch.mjs --state <path> --owner <id> --expected-version <n> --objective <text> --task-title <text> --spec-file <path> [--slot <id>]'
    )
    process.exitCode = 2
  } else {
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    const taskSpec = readFileSync(taskSpecPath, 'utf8')
    const persist = async (next) => {
      const tempPath = `${statePath}.next`
      writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`)
      renameSync(tempPath, statePath)
    }
    executeDispatch({
      state,
      expectedVersion,
      owner,
      objective,
      taskSpec,
      taskTitle,
      slotId,
      run: runOrca,
      persist
    })
      .then(({ state: next }) => {
        console.log(JSON.stringify(next))
      })
      .catch((error) => {
        console.error(error.message)
        process.exitCode =
          error instanceof StateConflictError ? 3 : error instanceof DispatchUnknownError ? 4 : 1
      })
  }
}
