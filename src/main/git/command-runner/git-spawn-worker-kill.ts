import type { ChildProcess } from 'node:child_process'
import {
  setProcessTreeKillGate,
  type ProcessTreeKill
} from '../../../shared/child-process/process-tree-kill-gate'
import { killSpawnedCommandTree } from './spawned-command-tree-kill'
import {
  KILL_VERDICT_WAIT_MS,
  type SpawnWorkerPort,
  type SpawnWorkerResponse
} from './git-spawn-worker-protocol'

// Why (#1085): taskkill is itself a CreateProcess, so the tree kill runs on the
// worker thread. The own-Chromium guard needs Electron state, so main decides
// whether the pid-addressed walk may run and the worker only carries out the answer.

const treeKillVerdicts = new Map<number, boolean>()
const verdictWaiters = new Map<number, (admit: boolean) => void>()

/**
 * Worker-side tree-kill gate. A git kill walks a pid only when main said so. A runProcess kill
 * reaches here only for a root its own handle still reports alive, so it is admitted, and
 * `onRunKill` tells main to put it on the record.
 */
export function installSpawnWorkerTreeKillGate(onRunKill?: (kill: ProcessTreeKill) => void): void {
  setProcessTreeKillGate((kill) => {
    if (kill.site === 'run-process-tree') {
      onRunKill?.(kill)
      return true
    }
    return treeKillVerdicts.get(kill.pid) === true
  })
}

export function deliverKillVerdict(id: number, admit: boolean): void {
  verdictWaiters.get(id)?.(admit)
}

function hasExited(child: ChildProcess): boolean {
  return (child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null
}

function requestVerdict(port: SpawnWorkerPort, id: number, child: ChildProcess): Promise<boolean> {
  // Only the Windows pid-addressed walk consults the guard, and only for a live root.
  if (process.platform !== 'win32' || !child.pid || hasExited(child)) {
    return Promise.resolve(false)
  }
  const message: SpawnWorkerResponse = { type: 'kill-check', id, pid: child.pid }
  return new Promise<boolean>((resolve) => {
    // No answer means a stalled main loop; refuse the walk and still kill the root handle.
    const timer = setTimeout(() => settle(false), KILL_VERDICT_WAIT_MS)
    function settle(admit: boolean): void {
      clearTimeout(timer)
      verdictWaiters.delete(id)
      resolve(admit)
    }
    verdictWaiters.set(id, settle)
    port.postMessage(message)
  })
}

/** End the child and its tree, reporting `killed` whether or not the kill succeeded. */
export async function killChildWithMainVerdict(
  port: SpawnWorkerPort,
  id: number,
  child: ChildProcess,
  reason: 'abort' | 'timeout'
): Promise<void> {
  const pid = child.pid
  try {
    const admit = await requestVerdict(port, id, child)
    if (admit && pid) {
      treeKillVerdicts.set(pid, true)
    }
    await killSpawnedCommandTree(child)
  } catch {
    // A failed kill must still report, or main would wait out its own deadline.
  } finally {
    if (pid) {
      treeKillVerdicts.delete(pid)
    }
    port.postMessage({ type: 'killed', id, reason })
  }
}

/**
 * Worker shutdown: start the tree kill for a live child without awaiting it. The spawn of
 * taskkill happens synchronously inside, and git children are ours, so the walk is admitted.
 */
export function killTreeAtShutdown(child: ChildProcess | null): void {
  if (!child || hasExited(child)) {
    return
  }
  if (child.pid) {
    treeKillVerdicts.set(child.pid, true)
  }
  void killSpawnedCommandTree(child)
}
