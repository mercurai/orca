import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { StateConflictError } from './release-state.mjs'

const copy = (value) => structuredClone(value)

function checkLease(state, owner) {
  if (!state.lease || state.lease.owner !== owner) throw new StateConflictError('the coordinator does not own the active lease')
}

function checkVersion(state, expectedVersion) {
  if (state.version !== expectedVersion) {
    throw new StateConflictError(`state version ${state.version} does not match expected ${expectedVersion}`)
  }
}

export function buildDispatchPlan(state, { owner, objective, taskTitle } = {}) {
  checkLease(state, owner)
  if (typeof objective !== 'string' || objective.length === 0) throw new TypeError('objective is required')
  if (typeof taskTitle !== 'string' || taskTitle.length === 0) throw new TypeError('taskTitle is required')
  return {
    generation: state.generation,
    runArgs: ['orchestration', 'run-create', '--objective', objective, '--json'],
    taskArgs: ['orchestration', 'task-create', '--run', '<runId>', '--task-title', taskTitle, '--json'],
    workerArgs: [
      'orchestration',
      'worker-start',
      '--task',
      '<taskId>',
      '--worktree',
      'new-child',
      '--name',
      taskTitle,
      '--agent',
      'codex',
      '--setup',
      'run',
      '--json'
    ]
  }
}

function resultObject(value, label) {
  const result = typeof value === 'string' ? JSON.parse(value) : value
  if (!result || typeof result !== 'object') throw new Error(`${label} returned no JSON object`)
  return result
}

export async function executeDispatch({ state, expectedVersion, owner, objective, taskTitle, run, persist } = {}) {
  checkVersion(state, expectedVersion)
  const plan = buildDispatchPlan(state, { owner, objective, taskTitle })
  if (typeof run !== 'function') throw new TypeError('run callback is required')
  if (persist !== undefined && typeof persist !== 'function') throw new TypeError('persist must be a callback')

  const existing = state.dispatch?.generation === state.generation && state.dispatch?.owner === owner
    ? state.dispatch
    : null
  if (existing?.dispatchId) {
    return { state: copy(state), dispatch: copy(existing), resumed: true }
  }

  const createdRun = existing?.runId
    ? { runId: existing.runId }
    : resultObject(await run(plan.runArgs), 'run-create')
  if (typeof createdRun.runId !== 'string' || createdRun.runId.length === 0) throw new Error('run-create returned no runId')
  let next = {
    ...copy(state),
    version: state.version + 1,
    dispatch: { generation: state.generation, owner, runId: createdRun.runId },
    evidence: { ...copy(state.evidence), dispatch: { generation: state.generation, owner, runId: createdRun.runId } }
  }
  if (!existing?.runId && persist) await persist(next)
  const createdTask = existing?.taskId
    ? { taskId: existing.taskId }
    : resultObject(await run(plan.taskArgs.map((value) => (value === '<runId>' ? createdRun.runId : value))), 'task-create')
  if (typeof createdTask.taskId !== 'string' || createdTask.taskId.length === 0) throw new Error('task-create returned no taskId')
  next = {
    ...next,
    version: next.version + 1,
    dispatch: { ...next.dispatch, taskId: createdTask.taskId },
    evidence: { ...copy(next.evidence), dispatch: { ...next.dispatch, taskId: createdTask.taskId } }
  }
  if (!existing?.taskId && persist) await persist(next)
  const startedWorker = resultObject(
    await run(plan.workerArgs.map((value) => (value === '<taskId>' ? createdTask.taskId : value))),
    'worker-start'
  )
  if (typeof startedWorker.dispatchId !== 'string' || startedWorker.dispatchId.length === 0) {
    throw new Error('worker-start returned no dispatchId')
  }

  const dispatch = { ...next.dispatch, dispatchId: startedWorker.dispatchId }
  next = {
    ...next,
    version: next.version + 1,
    dispatch,
    evidence: { ...copy(next.evidence), dispatch }
  }
  if (persist) await persist(next)
  return {
    state: next,
    dispatch
  }
}

export function executionVerdict({ connected, process } = {}) {
  if (process === 'exited') return 'exited'
  if (connected && process === 'known') return 'live'
  return 'unverifiable'
}

function flags(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue
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
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`orca exited ${code}: ${stderr.trim()}`))
        return
      }
      resolve(stdout.trim())
    })
  })
}

if (process.argv[1] && process.argv[1].endsWith('release-agent-dispatch.mjs')) {
  const values = flags(process.argv.slice(2))
  const statePath = values.get('state')
  const owner = values.get('owner')
  const objective = values.get('objective')
  const taskTitle = values.get('task-title')
  const expectedVersion = Number(values.get('expected-version'))
  if (!statePath || !owner || !objective || !taskTitle || !Number.isInteger(expectedVersion)) {
    console.error(
      'usage: node release-agent-dispatch.mjs --state <path> --owner <id> --expected-version <n> --objective <text> --task-title <text>'
    )
    process.exitCode = 2
  } else {
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    const persist = async (next) => {
      const tempPath = `${statePath}.next`
      writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`)
      renameSync(tempPath, statePath)
    }
    executeDispatch({ state, expectedVersion, owner, objective, taskTitle, run: runOrca, persist })
      .then(({ state: next }) => {
        console.log(JSON.stringify(next))
      })
      .catch((error) => {
        console.error(error.message)
        process.exitCode = error instanceof StateConflictError ? 3 : 1
      })
  }
}
