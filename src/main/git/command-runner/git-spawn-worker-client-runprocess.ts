import type { ProcessResult, ProcessSpec } from '../../../shared/child-process/process-spec'
import { notifyWorkerSpawn } from '../../../shared/child-process/spawn-observer'
import { admitSelfInitiatedTreeKill } from '../../own-chromium-tree-kill-guard'
import {
  reviveSpawnError,
  type RunWorkerResponse,
  type SpawnWorkerRequest,
  type SpawnWorkerResponse,
  type WireProcessResult,
  type WireProcessSpec
} from './git-spawn-worker-protocol'

// Why (#1091): main-thread half of runProcess-on-the-worker, kept out of the client so the
// client stays under the file cap. The table below is the run counterpart of the client's
// capture and stream entries: it tracks each run by request id, hands the outcome to the
// routing function, and decides what a worker death means for a run.

export type RunOutcome =
  | { kind: 'result'; result: ProcessResult }
  | { kind: 'rejected'; error: Error }
  /** The child was never started, so the caller may run the same capture in-process. */
  | { kind: 'unspawned' }

export type RunHandle = {
  outcome: Promise<RunOutcome>
  /** Ask the worker to stop the run; the outcome still settles with the child's exit. */
  terminate: () => void
}

type RunRequest = Extract<SpawnWorkerRequest, { type: 'run' }>

type RunEntry = {
  command: string
  args: readonly string[]
  pid: number | undefined
  /** runProcess started the child (or failed trying), so retrying in-process would repeat it. */
  spawned: boolean
  terminated: boolean
  settle: (outcome: RunOutcome) => void
  onTerminated: () => void
}

type RunTransport = {
  allocateId: () => number
  send: (request: SpawnWorkerRequest) => boolean
  onBusy: () => void
  onIdle: () => void
}

export function isRunMessage(message: SpawnWorkerResponse): message is RunWorkerResponse {
  return (
    message.type === 'run-spawned' ||
    message.type === 'run-terminated' ||
    message.type === 'run-result' ||
    message.type === 'tree-kill'
  )
}

function reviveResult(wire: WireProcessResult): ProcessResult {
  const { stdoutBytes, ...rest } = wire
  if (!stdoutBytes) {
    return rest
  }
  return { ...rest, stdoutBytes: Buffer.from(stdoutBytes) }
}

export class RunProcessTable {
  private readonly entries = new Map<number, RunEntry>()

  constructor(private readonly transport: RunTransport) {}

  get size(): number {
    return this.entries.size
  }

  /** Null means no worker took the request, so the caller must spawn in-process. */
  start(
    spec: WireProcessSpec,
    capture: RunRequest['capture'],
    onTerminated: () => void
  ): RunHandle | null {
    this.transport.onBusy()
    const id = this.transport.allocateId()
    let settle: (outcome: RunOutcome) => void = () => {}
    const outcome = new Promise<RunOutcome>((resolve) => {
      settle = resolve
    })
    this.entries.set(id, {
      command: spec.program,
      args: spec.args ?? [],
      pid: undefined,
      spawned: false,
      terminated: false,
      settle,
      onTerminated
    })
    if (!this.transport.send({ type: 'run', id, spec, capture })) {
      this.entries.delete(id)
      return null
    }
    return {
      outcome,
      terminate: () => {
        this.transport.send({ type: 'terminate', id })
      }
    }
  }

  handle(message: RunWorkerResponse): void {
    if (message.type === 'tree-kill') {
      // Recorded on main's breadcrumb store; the worker already decided, so the answer is unused.
      admitSelfInitiatedTreeKill(message)
      return
    }
    const entry = this.entries.get(message.id)
    if (!entry) {
      return
    }
    if (message.type === 'run-spawned') {
      entry.spawned = true
      entry.pid = message.pid
      // Main did not block on this spawn; the count keeps per-command totals honest.
      notifyWorkerSpawn(entry.command, entry.args)
    } else if (message.type === 'run-terminated') {
      this.reportTerminated(entry)
    } else {
      this.entries.delete(message.id)
      entry.settle(settledOutcome(message))
      if (this.entries.size === 0) {
        this.transport.onIdle()
      }
    }
  }

  /** The worker is gone with these runs in flight: their children are reaped by pid. */
  failAll(error: Error, code?: string): void {
    this.reapChildren()
    for (const entry of this.entries.values()) {
      if (entry.spawned || entry.terminated) {
        this.reportTerminated(entry)
        // Why a copy per run: callers attach their own output to the error they receive.
        entry.settle({
          kind: 'rejected',
          error: Object.assign(new Error(error.message), code ? { code } : {})
        })
      } else {
        entry.settle({ kind: 'unspawned' })
      }
    }
    this.entries.clear()
  }

  // Why: a terminated or crashed worker thread never runs its exit hook, so main ends the
  // roots itself. process.kill by pid spawns nothing on this thread.
  reapChildren(): void {
    for (const entry of this.entries.values()) {
      if (entry.pid && !entry.terminated) {
        try {
          process.kill(entry.pid)
        } catch {
          // Already exited.
        }
      }
    }
  }

  private reportTerminated(entry: RunEntry): void {
    if (!entry.terminated) {
      entry.terminated = true
      entry.onTerminated()
    }
  }
}

function settledOutcome(message: Extract<RunWorkerResponse, { type: 'run-result' }>): RunOutcome {
  if (message.result) {
    return { kind: 'result', result: reviveResult(message.result) }
  }
  const error = message.error ?? { message: 'The spawn worker returned no result.', name: 'Error' }
  return { kind: 'rejected', error: reviveSpawnError(error) }
}

function toWireSpec(spec: ProcessSpec): WireProcessSpec | null {
  const {
    signal: _signal,
    onChildTerminated: _onChildTerminated,
    onSpawn,
    stdio,
    serialization,
    terminationBarrier,
    ...rest
  } = spec
  // Why null: these cannot cross the thread, so the caller keeps them in-process.
  if (onSpawn || stdio !== undefined || serialization !== undefined) {
    return null
  }
  if (typeof terminationBarrier !== 'object') {
    return terminationBarrier === undefined ? rest : { ...rest, terminationBarrier }
  }
  return terminationBarrier.worker
    ? { ...rest, terminationBarrier: terminationBarrier.worker }
    : null
}

/**
 * runProcess's capture on the worker thread: the worker owns spawn, deadline and tree kill;
 * main keeps abort propagation and error typing. Null means the caller spawns here.
 */
export function runProcessOnWorker(
  table: RunProcessTable,
  spec: ProcessSpec,
  capture: RunRequest['capture'],
  inProcess: () => Promise<ProcessResult>
): Promise<ProcessResult> | null {
  const wire = toWireSpec(spec)
  const handle = wire ? table.start(wire, capture, () => spec.onChildTerminated?.()) : null
  if (!handle) {
    return null
  }
  const { signal } = spec
  signal?.addEventListener('abort', handle.terminate, { once: true })
  if (signal?.aborted) {
    handle.terminate()
  }
  return handle.outcome.then((outcome) => {
    signal?.removeEventListener('abort', handle.terminate)
    if (outcome.kind === 'rejected') {
      throw outcome.error
    }
    if (outcome.kind === 'result') {
      return outcome.result
    }
    // Why: a worker that died before spawning never ran the command, so run it here instead.
    if (signal?.aborted) {
      spec.onChildTerminated?.()
      return { code: null, signal: null, stdout: '', stderr: '', timedOut: false }
    }
    return inProcess()
  })
}
