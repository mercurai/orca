// Why (#1085): message shapes shared by the git spawn worker thread and its
// main-thread client. libuv runs CreateProcess on the loop that calls it, so the
// spawn, the deadline timer and the tree kill live on the worker; admission,
// command resolution, the Chromium tree-kill guard and error typing stay in main.
// Kept free of Electron, node:worker_threads and node:child_process so either
// side can import it without dragging the other side's dependencies across.
import type { ExecFileOptions } from 'node:child_process'
import type { ProcessTreeKill } from '../../../shared/child-process/process-tree-kill-gate'
import type {
  ProcessResult,
  ProcessSpec,
  WorkerBarrierDescriptor
} from '../../../shared/child-process/process-spec'

/** Fields of a Node child-process error that callers read; the rest does not clone usefully. */
export type SerializedSpawnError = {
  message: string
  name: string
  code?: string | number
  errno?: number
  syscall?: string
  path?: string
  spawnargs?: string[]
  killed?: boolean
  signal?: string | null
  cmd?: string
}

/** The part of a ProcessSpec that crosses the thread; callbacks and the signal stay on main. */
export type WireProcessSpec = Omit<
  ProcessSpec,
  'signal' | 'stdio' | 'serialization' | 'terminationBarrier' | 'onChildTerminated' | 'onSpawn'
> & { terminationBarrier?: boolean | WorkerBarrierDescriptor }

/** A ProcessResult as structured clone delivers it: byte output arrives as a plain Uint8Array. */
export type WireProcessResult = Omit<ProcessResult, 'stdoutBytes'> & { stdoutBytes?: Uint8Array }

export type SpawnWorkerRequest =
  | {
      type: 'run'
      id: number
      spec: WireProcessSpec
      capture: 'head' | 'tail'
    }
  | {
      type: 'capture'
      id: number
      command: string
      args: string[]
      cwd?: string
      env?: NodeJS.ProcessEnv
      encoding?: ExecFileOptions['encoding']
      maxBuffer: number
      timeoutMs?: number
      stdin?: string
    }
  | {
      type: 'stream'
      id: number
      command: string
      args: string[]
      cwd: string
      env?: NodeJS.ProcessEnv
    }
  /** Main asks the worker to end this request's child (abort, parser stop, byte cap). */
  | { type: 'terminate'; id: number }
  /** Main's answer to `kill-check`: whether the pid-addressed tree walk may run. */
  | { type: 'verdict'; id: number; admit: boolean }
  /** Stream chunks main has consumed; releases the worker's stdout pause. */
  | { type: 'ack'; id: number; chunks: number }

export type RunWorkerResponse =
  /** runProcess started the child; `pid` is undefined when the spawn failed asynchronously. */
  | { type: 'run-spawned'; id: number; pid: number | undefined }
  /** The child exited or its tree termination was verified: spec.onChildTerminated. */
  | { type: 'run-terminated'; id: number }
  /** runProcess settled: exactly one of `result` and `error`. */
  | {
      type: 'run-result'
      id: number
      result: WireProcessResult | null
      error: SerializedSpawnError | null
    }
  /** The worker walked a process tree on its own authority; main puts it on the record. */
  | ({ type: 'tree-kill' } & ProcessTreeKill)

export type SpawnWorkerResponse =
  | RunWorkerResponse
  | { type: 'spawned'; id: number; pid: number | undefined; spawnMs: number }
  /** The Windows tree kill needs main's own-Chromium guard before it walks `pid`. */
  | { type: 'kill-check'; id: number; pid: number }
  | { type: 'chunk'; id: number; channel: 'stdout' | 'stderr'; data: Uint8Array }
  /** execFile's callback: the capture result, whether or not a kill is in flight. */
  | {
      type: 'result'
      id: number
      error: SerializedSpawnError | null
      stdout: string | Uint8Array
      stderr: string | Uint8Array
      /** A kill is in flight, so main waits for `killed` instead of settling on this. */
      terminating: boolean
    }
  /** The child's `error` event; `hasPid` false means it never started. */
  | {
      type: 'errored'
      id: number
      error: SerializedSpawnError
      hasPid: boolean
      terminating: boolean
    }
  /** The child's `close` event, which is what releases the admission grant. */
  | { type: 'closed'; id: number; code: number | null; signal: string | null }
  /** The worker finished ending the child, by terminate or by its own deadline. */
  | { type: 'killed'; id: number; reason: 'abort' | 'timeout' }

export type SpawnWorkerPort = {
  postMessage(message: SpawnWorkerResponse, transfer?: ArrayBuffer[]): void
}

/** Stream chunks the worker may have unacknowledged before it pauses the child's stdout. */
export const STREAM_HIGH_WATER_CHUNKS = 32
export const STREAM_LOW_WATER_CHUNKS = 8
/** How long a worker waits for main's tree-kill verdict before killing only the root handle. */
export const KILL_VERDICT_WAIT_MS = 2_000

export function serializeSpawnError(error: unknown): SerializedSpawnError {
  if (!(error instanceof Error)) {
    return { message: String(error), name: 'Error' }
  }
  const source: Partial<SerializedSpawnError> = error
  return {
    message: error.message,
    name: error.name,
    ...(source.code === undefined ? {} : { code: source.code }),
    ...(source.errno === undefined ? {} : { errno: source.errno }),
    ...(source.syscall === undefined ? {} : { syscall: source.syscall }),
    ...(source.path === undefined ? {} : { path: source.path }),
    ...(source.spawnargs === undefined ? {} : { spawnargs: source.spawnargs }),
    ...(source.killed === undefined ? {} : { killed: source.killed }),
    ...(source.signal === undefined ? {} : { signal: source.signal }),
    ...(source.cmd === undefined ? {} : { cmd: source.cmd })
  }
}

// Why: the class does not survive the thread hop, so a RangeError (e.g. a maxBuffer overrun)
// comes back as a plain Error carrying the original `name` and `code`; match on those, not instanceof.
export function reviveSpawnError(serialized: SerializedSpawnError): Error {
  const { message, name, ...fields } = serialized
  return Object.assign(new Error(message), { name }, fields)
}

export function toBuffer(value: string | Uint8Array): string | Buffer {
  return typeof value === 'string'
    ? value
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
}
