import { recordSubprocessSpawn } from '../../diagnostics/main-thread-churn-probe'
import { LazyWorkerThreadHost, type WorkerThreadFactory } from '../../lazy-worker-thread-host'
import { admitSelfInitiatedTreeKill } from '../../own-chromium-tree-kill-guard'
import {
  reviveSpawnError,
  type SpawnWorkerRequest,
  type SpawnWorkerResponse
} from './git-spawn-worker-protocol'

// Why (#1085): main-thread half of the git spawn worker. It multiplexes every
// capture and stream request onto one worker thread keyed by request id, and keeps
// the decisions that need Electron state (the own-Chromium tree-kill guard) here.
// Admission, command resolution, abort wiring and error typing stay with callers.

export const IDLE_TEARDOWN_MS = 5 * 60_000
export const MAX_CONSECUTIVE_DEATHS = 3
/** `code` on the error a caller sees when the worker died with its child running. */
export const SPAWN_WORKER_EXIT_CODE = 'EGITSPAWNWORKER'

type CaptureRequest = Extract<SpawnWorkerRequest, { type: 'capture' }>
type StreamRequest = Extract<SpawnWorkerRequest, { type: 'stream' }>
export type CaptureSpec = Omit<CaptureRequest, 'type' | 'id'>
export type StreamSpec = Omit<StreamRequest, 'type' | 'id'>

export type CaptureOutcome =
  | { kind: 'result'; error: Error | null; stdout: string | Buffer; stderr: string | Buffer }
  | { kind: 'killed'; reason: 'abort' | 'timeout' }
  /** `spawned` false means the child never started, so the caller may retry in-process. */
  | { kind: 'failed'; error: Error; spawned: boolean }

export type CaptureHandle = {
  outcome: Promise<CaptureOutcome>
  /** Ask the worker to end the child; the outcome settles as `killed`. */
  terminate: () => void
}

export type StreamEvents = {
  onChunk: (channel: 'stdout' | 'stderr', data: Buffer) => void
  onError: (error: Error, hasPid: boolean) => void
  onClose: (code: number | null, signal: string | null) => void
}

export type StreamHandle = {
  readonly pid: number | undefined
  /** Fire and forget: the worker ends the child's tree and the stream closes. */
  terminate: () => void
}

type Entry = {
  id: number
  command: string
  args: string[]
  pid: number | undefined
  unackedChunks: number
  ackScheduled: boolean
  /** The child is gone (`close`, or an `error` before it ever started). */
  closed: boolean
  /** A capture's outcome has been delivered; a `killed` after `close` still needs the entry. */
  settled: boolean
  /** The worker reported the spawn, so a child may be running. */
  spawned: boolean
  capture?: {
    settle: (outcome: CaptureOutcome) => void
    onTerminated: () => void
    onSpawned?: (spawnMs: number) => void
  }
  stream?: StreamEvents
}

function toBuffer(value: string | Uint8Array): string | Buffer {
  return typeof value === 'string'
    ? value
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
}

export class GitSpawnWorkerClient {
  private readonly host: LazyWorkerThreadHost<SpawnWorkerResponse>
  private readonly active = new Map<number, Entry>()
  private nextId = 0
  private consecutiveDeaths = 0
  private unavailable = false
  private readonly log: (message: string) => void

  constructor(options: { workerFactory: WorkerThreadFactory; log?: (message: string) => void }) {
    this.log = options.log ?? ((message) => console.warn(message))
    this.host = new LazyWorkerThreadHost<SpawnWorkerResponse>({
      factory: options.workerFactory,
      idleTeardownMs: IDLE_TEARDOWN_MS,
      onMessage: (message) => this.handleMessage(message),
      onError: (error) => this.handleWorkerDeath(error),
      onExit: (code) =>
        this.handleWorkerDeath(new Error(`Git spawn worker exited with code ${code}`)),
      isIdle: () => this.active.size === 0,
      // Why: git is required for the app to work, so a missing worker means
      // in-process spawning (the pre-#1085 behaviour), never a failed command.
      onUnavailable: (error) => {
        this.unavailable = true
        this.log(`[git-spawn-worker] unavailable, spawning in-process. ${String(error)}`)
      }
    })
  }

  get isAvailable(): boolean {
    return !this.unavailable
  }

  dispose(): void {
    this.reapChildren()
    this.host.destroy()
    this.fail(new Error('Git spawn worker disposed'))
  }

  /** Null means the caller must spawn in-process instead. */
  capture(
    spec: CaptureSpec,
    onTerminated: () => void,
    onSpawned?: (spawnMs: number) => void
  ): CaptureHandle | null {
    let settle: (outcome: CaptureOutcome) => void = () => {}
    const outcome = new Promise<CaptureOutcome>((resolve) => {
      settle = resolve
    })
    const entry = this.register(spec.command, spec.args)
    entry.capture = { settle, onTerminated, onSpawned }
    if (!this.send({ type: 'capture', id: entry.id, ...spec }, entry)) {
      return null
    }
    return { outcome, terminate: () => this.post({ type: 'terminate', id: entry.id }) }
  }

  /** Null means the caller must spawn in-process instead. */
  stream(spec: StreamSpec, events: StreamEvents): StreamHandle | null {
    const entry = this.register(spec.command, spec.args)
    entry.stream = events
    if (!this.send({ type: 'stream', id: entry.id, ...spec }, entry)) {
      return null
    }
    return {
      get pid() {
        return entry.pid
      },
      terminate: () => this.post({ type: 'terminate', id: entry.id })
    }
  }

  private register(command: string, args: string[]): Entry {
    this.host.clearIdleTimer()
    const entry: Entry = {
      id: ++this.nextId,
      command,
      args,
      pid: undefined,
      unackedChunks: 0,
      ackScheduled: false,
      closed: false,
      spawned: false,
      settled: false
    }
    this.active.set(entry.id, entry)
    return entry
  }

  // Why: registered before posting, because a loopback transport can answer synchronously.
  private send(request: SpawnWorkerRequest, entry: Entry): boolean {
    if (this.host.ensure() && this.post(request)) {
      return true
    }
    this.active.delete(entry.id)
    return false
  }

  private post(request: SpawnWorkerRequest): boolean {
    try {
      this.host.current?.postMessage(request)
      return this.host.current !== null
    } catch {
      return false
    }
  }

  private handleMessage(message: SpawnWorkerResponse): void {
    // Why before the lookup: the worker waits on this answer even if the entry has just closed.
    if (message.type === 'kill-check') {
      this.post({
        type: 'verdict',
        id: message.id,
        admit: admitSelfInitiatedTreeKill({
          pid: message.pid,
          site: 'git-command-tree-kill',
          scope: 'win-taskkill-tree'
        })
      })
      return
    }
    const entry = this.active.get(message.id)
    if (!entry) {
      return
    }
    switch (message.type) {
      case 'spawned':
        entry.pid = message.pid
        entry.spawned = true
        entry.capture?.onSpawned?.(message.spawnMs)
        // Main did not block on this spawn; the entry keeps per-command spawn counts honest.
        recordSubprocessSpawn(entry.command, entry.args, 0)
        break
      case 'chunk':
        this.handleChunk(entry, message.channel, message.data)
        break
      case 'result':
        if (!message.terminating) {
          this.settle(entry, {
            kind: 'result',
            error: message.error ? reviveSpawnError(message.error) : null,
            stdout: toBuffer(message.stdout),
            stderr: toBuffer(message.stderr)
          })
        }
        break
      case 'errored':
        this.handleErrored(entry, message)
        break
      case 'killed':
        this.settle(entry, { kind: 'killed', reason: message.reason })
        break
      case 'closed':
        this.consecutiveDeaths = 0
        this.markClosed(entry)
        entry.stream?.onClose(message.code, message.signal)
        break
    }
  }

  private handleErrored(
    entry: Entry,
    message: Extract<SpawnWorkerResponse, { type: 'errored' }>
  ): void {
    const error = reviveSpawnError(message.error)
    if (!message.terminating) {
      this.settle(entry, { kind: 'result', error, stdout: '', stderr: '' })
    }
    if (!message.hasPid) {
      this.markClosed(entry)
    }
    entry.stream?.onError(error, message.hasPid)
  }

  private handleChunk(entry: Entry, channel: 'stdout' | 'stderr', data: Uint8Array): void {
    entry.stream?.onChunk(channel, Buffer.from(data.buffer, data.byteOffset, data.byteLength))
    entry.unackedChunks += 1
    if (!entry.ackScheduled) {
      entry.ackScheduled = true
      queueMicrotask(() => {
        entry.ackScheduled = false
        const chunks = entry.unackedChunks
        entry.unackedChunks = 0
        if (chunks > 0 && this.active.has(entry.id)) {
          this.post({ type: 'ack', id: entry.id, chunks })
        }
      })
    }
  }

  private settle(entry: Entry, outcome: CaptureOutcome): void {
    if (entry.settled || !entry.capture) {
      return
    }
    entry.settled = true
    entry.capture.settle(outcome)
    this.release(entry)
  }

  /** The child is gone: its termination is reported exactly once. */
  private markClosed(entry: Entry): void {
    if (entry.closed) {
      return
    }
    entry.closed = true
    entry.capture?.onTerminated()
    this.release(entry)
  }

  private release(entry: Entry): void {
    if (!entry.closed || (entry.capture && !entry.settled) || !this.active.delete(entry.id)) {
      return
    }
    if (this.active.size === 0) {
      this.host.scheduleIdleTeardown()
    }
  }

  // Why: a terminated or crashed worker thread never runs its exit hook (verified on a real
  // worker), so main ends the roots itself. process.kill by pid spawns nothing on this thread.
  private reapChildren(): void {
    for (const entry of this.active.values()) {
      if (entry.pid && !entry.closed) {
        try {
          process.kill(entry.pid)
        } catch {
          // Already exited.
        }
      }
    }
  }

  private handleWorkerDeath(error: Error): void {
    this.reapChildren()
    this.host.destroy()
    this.consecutiveDeaths += 1
    if (this.consecutiveDeaths >= MAX_CONSECUTIVE_DEATHS && !this.unavailable) {
      this.unavailable = true
      this.log(`[git-spawn-worker] crashed repeatedly, spawning in-process. ${error.message}`)
    }
    this.fail(Object.assign(error, { code: SPAWN_WORKER_EXIT_CODE }))
  }

  // Every in-flight request is over: the worker and its children are gone.
  private fail(error: Error): void {
    for (const entry of this.active.values()) {
      // A request that never spawned is retried in-process, so it must not release its grant yet.
      if (entry.spawned || !entry.capture) {
        this.markClosed(entry)
      }
      this.settle(entry, { kind: 'failed', error, spawned: entry.spawned })
      this.active.delete(entry.id)
      entry.stream?.onError(error, false)
    }
  }
}
