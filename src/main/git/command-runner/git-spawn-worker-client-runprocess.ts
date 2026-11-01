import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import { notifyWorkerSpawn } from '@orca/process-host/spawn-observer'
import { recordSelfInitiatedTreeKill } from '../../crash-reporting/self-initiated-tree-kill-log'
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
  /** Its outcome was delivered; the entry stays until the child is also reported terminated. */
  settled: boolean
  terminated: boolean
  settle: (outcome: RunOutcome) => void
  onTerminated: () => void
}

type RunTransport = {
  allocateId: () => number
  send: (request: SpawnWorkerRequest) => boolean
  /** Post to a live worker only; a stop request must never start a new one. */
  post: (request: SpawnWorkerRequest) => boolean
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
  const { stdoutBytes, stderrBytes, ...rest } = wire
  return {
    ...rest,
    ...(stdoutBytes === undefined ? {} : { stdoutBytes: Buffer.from(stdoutBytes) }),
    ...(stderrBytes === undefined ? {} : { stderrBytes: Buffer.from(stderrBytes) })
  }
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
      settled: false,
      terminated: false,
      settle,
      onTerminated
    })
    if (!this.transport.send({ type: 'run', id, spec, capture })) {
      this.entries.delete(id)
      if (this.entries.size === 0) this.transport.onIdle()
      return null
    }
    return {
      outcome,
      terminate: () => {
        this.transport.post({ type: 'terminate', id })
      }
    }
  }

  handle(message: RunWorkerResponse): void {
    if (message.type === 'tree-kill') {
      // Why record only: the worker kills a root its own handle still holds, so pid reuse cannot apply.
      recordSelfInitiatedTreeKill(message)
      return
    }
    const entry = this.entries.get(message.id)
    if (!entry) {
      return
    }
    if (message.type === 'run-spawned') {
      entry.pid = message.pid
      // Main did not block on this spawn; the count keeps per-command totals honest.
      notifyWorkerSpawn(entry.command, entry.args)
    } else if (message.type === 'run-terminated') {
      this.reportTerminated(entry)
    } else {
      entry.settled = true
      // Why: the root is gone by now, so a later reap must not kill its possibly recycled pid.
      entry.pid = undefined
      entry.settle(settledOutcome(message))
    }
    // Why both: a descendant can hold the pipes, so the child is reported gone after the result.
    if (entry.settled && entry.terminated) {
      this.entries.delete(message.id)
      if (this.entries.size === 0) {
        this.transport.onIdle()
      }
    }
  }

  /** Posted runs have unknown outcomes; only acknowledged PIDs can be reaped. */
  failAll(error: Error, code?: string): void {
    for (const entry of this.entries.values()) {
      if (entry.pid !== undefined) this.reportTerminated(entry)
      if (!entry.settled) {
        entry.settle({
          kind: 'rejected',
          error: Object.assign(
            new Error(
              `${error.message}; command outcome and child lifetime are unknown; reconciliation is required`
            ),
            code ? { code } : {}
          )
        })
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
    onStderr,
    stdio,
    serialization,
    terminationBarrier,
    ...rest
  } = spec
  // Why null: these cannot cross the thread, so the caller keeps them in-process.
  if (onSpawn || onStderr || stdio !== undefined || serialization !== undefined) {
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
  _inProcess: () => Promise<ProcessResult>
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
    return outcome.result
  })
}
