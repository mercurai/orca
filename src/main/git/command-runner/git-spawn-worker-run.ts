import type { ChildProcess } from 'node:child_process'
import { runProcessInProcess } from '../../../shared/child-process/run-process'
import type { ProcessTerminationBarrier } from '../../../shared/child-process/process-spec'
import { createWslProcessGroupTermination } from '../wsl-process-group-termination'
import { killTreeAtShutdown } from './git-spawn-worker-kill'
import {
  serializeSpawnError,
  type SpawnWorkerPort,
  type SpawnWorkerRequest,
  type WireProcessSpec
} from './git-spawn-worker-protocol'

// Why (#1091): libuv runs CreateProcess on the calling thread, so this runs the real runProcess
// body here, off the route: deadline, output caps, barrier and tree kill behave as in-process.
// Only the callbacks main owns (signal, onChildTerminated) are rebuilt as messages.

type RunRequest = Extract<SpawnWorkerRequest, { type: 'run' }>

function rebuildBarrier(
  barrier: WireProcessSpec['terminationBarrier']
): boolean | ProcessTerminationBarrier | undefined {
  return typeof barrier === 'object'
    ? createWslProcessGroupTermination(barrier.distro, barrier.marker)
    : barrier
}

export function createRunProcessHost(port: SpawnWorkerPort): {
  start: (request: RunRequest) => void
  /** True when `id` is a run, which has now been told to stop. */
  abort: (id: number) => boolean
  killAll: () => void
} {
  const aborts = new Map<number, AbortController>()
  const children = new Map<number, ChildProcess>()

  function start(request: RunRequest): void {
    const { id, spec, capture } = request
    const controller = new AbortController()
    aborts.set(id, controller)
    runProcessInProcess(
      {
        ...spec,
        terminationBarrier: rebuildBarrier(spec.terminationBarrier),
        signal: controller.signal,
        onSpawn: (child) => {
          children.set(id, child)
          port.postMessage({ type: 'run-spawned', id, pid: child.pid })
        },
        onChildTerminated: () => port.postMessage({ type: 'run-terminated', id })
      },
      capture
    )
      .then(
        (result) => ({ result, error: null }),
        (error: unknown) => ({ result: null, error: serializeSpawnError(error) })
      )
      .then((outcome) => {
        aborts.delete(id)
        children.delete(id)
        port.postMessage({ type: 'run-result', id, ...outcome })
      })
  }

  return {
    start,
    abort: (id) => {
      const controller = aborts.get(id)
      controller?.abort()
      return controller !== undefined
    },
    // Why: runs when the worker thread exits, so it cannot await; reap each tree synchronously.
    killAll: () => {
      for (const child of children.values()) {
        killTreeAtShutdown(child)
      }
      children.clear()
    }
  }
}
