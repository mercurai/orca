import { existsSync } from 'node:fs'
import { SHARE_ENV, Worker } from 'node:worker_threads'
import type { WorkerThreadFactory } from '../../lazy-worker-thread-host'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../worker-thread-entry-path'
import { setRunProcessRoute } from '../../../shared/child-process/run-process-worker-route'
import { GitSpawnWorkerClient } from './git-spawn-worker-client'
import { runProcessOnWorker } from './git-spawn-worker-client-runprocess'

// Why (#1085): ORCA_GIT_SPAWN_WORKER=0 (or ORCA_SPAWN_WORKER=0, since #1091 also carries
// runProcess) is the kill switch that puts every spawn back on the main thread; unset or any other value uses the worker whenever the
// built entry can be started, and falls back to in-process spawning otherwise.

const WORKER_ENTRY_FILENAME = 'git-spawn-worker-entry.js'

function defaultWorkerFactory(): Worker {
  const workerPath = resolveWorkerThreadEntryPath(
    currentWorkerEntryLayout(__dirname),
    WORKER_ENTRY_FILENAME
  )
  // Why: a missing built entry must throw here so the client falls back to in-process
  // spawning instead of waiting on a worker that can never answer.
  if (!existsSync(workerPath)) {
    throw new Error(`Git spawn worker entry not found: ${workerPath}`)
  }
  // Why: SHARE_ENV keeps the worker's process.env live, matching what an in-process spawn sees.
  return new Worker(workerPath, { env: SHARE_ENV })
}

let sharedClient: GitSpawnWorkerClient | null = null
let workerFactory: WorkerThreadFactory = defaultWorkerFactory
let workerLog: ((message: string) => void) | undefined

/** The process-wide client, or null when the caller must spawn in-process. */
export function getGitSpawnWorkerClient(): GitSpawnWorkerClient | null {
  if (process.env.ORCA_GIT_SPAWN_WORKER === '0' || process.env.ORCA_SPAWN_WORKER === '0') {
    return null
  }
  sharedClient ??= new GitSpawnWorkerClient({ workerFactory, log: workerLog })
  return sharedClient.isAvailable ? sharedClient : null
}

/** Swap the worker transport (tests); null restores the built worker entry. */
export function setGitSpawnWorkerFactoryForTests(
  next: WorkerThreadFactory | null,
  log?: (message: string) => void
): void {
  sharedClient?.dispose()
  sharedClient = null
  workerFactory = next ?? defaultWorkerFactory
  workerLog = log
}

/** Main only: sends runProcess captures to the spawn worker (#1091). */
export function installRunProcessWorkerRoute(): void {
  setRunProcessRoute((spec, capture, inProcess) => {
    const client = getGitSpawnWorkerClient()
    return client ? runProcessOnWorker(client.runs, spec, capture, inProcess) : null
  })
}
