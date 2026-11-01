import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SHARE_ENV, Worker } from 'node:worker_threads'
import { buildSync } from 'esbuild'
import type { WorkerThreadFactory } from '../../lazy-worker-thread-host'
import { setGitSpawnWorkerFactoryForTests } from './git-spawn-worker-access'
import { createGitSpawnWorkerHandler } from './git-spawn-worker-handler'
import type { SpawnWorkerRequest, SpawnWorkerResponse } from './git-spawn-worker-protocol'

export type GitSpawnMode = 'in-process' | 'worker'
export const GIT_SPAWN_MODES: readonly GitSpawnMode[] = ['in-process', 'worker']

/**
 * A worker that runs the real handler on this thread. Messages are structured-cloned
 * (so transferred buffers behave as in a real worker) but delivered synchronously,
 * which keeps vi.mock of node:child_process and fake timers effective in worker mode.
 */
class LoopbackWorker extends EventEmitter {
  private readonly handler = createGitSpawnWorkerHandler({
    postMessage: (message: SpawnWorkerResponse, transfer?: ArrayBuffer[]) => {
      this.emit('message', structuredClone(message, { transfer }))
    }
  })

  postMessage(request: SpawnWorkerRequest): void {
    this.handler.handle(structuredClone(request))
  }

  unref(): void {}

  terminate(): Promise<number> {
    this.handler.killAll()
    return Promise.resolve(0)
  }
}

export function createLoopbackWorkerFactory(): WorkerThreadFactory {
  return () => new LoopbackWorker()
}

/** Bundles the real worker entry once so a test can run it on an actual worker thread. */
export function createThreadWorkerFactory(): { factory: WorkerThreadFactory; cleanup: () => void } {
  const directory = mkdtempSync(path.join(tmpdir(), 'orca-git-spawn-worker-'))
  const outfile = path.join(directory, 'git-spawn-worker-entry.cjs')
  buildSync({
    entryPoints: [path.join(__dirname, 'git-spawn-worker-entry.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    logLevel: 'silent'
  })
  return {
    factory: () => new Worker(outfile, { env: SHARE_ENV }),
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  }
}

/** Route git spawns through the worker (loopback) or force the in-process path. */
export function useGitSpawnMode(
  mode: GitSpawnMode,
  workerFactory = createLoopbackWorkerFactory()
): void {
  setGitSpawnWorkerFactoryForTests(
    mode === 'worker'
      ? workerFactory
      : () => {
          throw new Error('in-process mode requested by the test')
        },
    () => {}
  )
}

export function restoreGitSpawnMode(): void {
  setGitSpawnWorkerFactoryForTests(null)
}
