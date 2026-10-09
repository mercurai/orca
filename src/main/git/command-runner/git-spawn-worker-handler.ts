import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { endSubprocessStdin } from '../../../shared/subprocess-stdin-write'
import { isExecFileResultObject } from './exec-file-result'
import { deliverKillVerdict, killChildWithMainVerdict } from './git-spawn-worker-kill'
import {
  STREAM_HIGH_WATER_CHUNKS,
  STREAM_LOW_WATER_CHUNKS,
  serializeSpawnError,
  type SpawnWorkerPort,
  type SpawnWorkerRequest
} from './git-spawn-worker-protocol'

// Why (#1085): this module runs on the git spawn worker thread (or, in tests, on
// a loopback in the same thread). Everything here is CreateProcess work that must
// stay off the main loop: execFile/spawn, the capture deadline, taskkill. It must
// stay electron-free, so the own-Chromium tree-kill guard is main's verdict, not a
// local call.

type Entry = {
  id: number
  kind: 'capture' | 'stream'
  child: ChildProcess | null
  terminating: boolean
  resultPosted: boolean
  timer: NodeJS.Timeout | null
  unacked: number
  paused: boolean
}

function copyBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.byteLength)
  copy.set(value)
  return copy
}

export function createGitSpawnWorkerHandler(port: SpawnWorkerPort): {
  handle: (request: SpawnWorkerRequest) => void
  killAll: () => void
} {
  const active = new Map<number, Entry>()

  function newEntry(id: number, kind: Entry['kind']): Entry {
    const entry: Entry = {
      id,
      kind,
      child: null,
      terminating: false,
      resultPosted: false,
      timer: null,
      unacked: 0,
      paused: false
    }
    active.set(id, entry)
    return entry
  }

  function clearTimer(entry: Entry): void {
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
  }

  function postOutput(value: string | Buffer): {
    value: string | Uint8Array
    transfer: ArrayBuffer[]
  } {
    if (typeof value === 'string') {
      return { value, transfer: [] }
    }
    const copy = copyBytes(value)
    return { value: copy, transfer: [copy.buffer] }
  }

  function postResult(
    entry: Entry,
    error: Error | null,
    stdout: string | Buffer,
    stderr: string | Buffer
  ): void {
    entry.resultPosted = true
    clearTimer(entry)
    const out = postOutput(stdout)
    const err = postOutput(stderr)
    port.postMessage(
      {
        type: 'result',
        id: entry.id,
        error: error ? serializeSpawnError(error) : null,
        stdout: out.value,
        stderr: err.value,
        terminating: entry.terminating
      },
      [...out.transfer, ...err.transfer]
    )
  }

  function wireLifecycle(entry: Entry, child: ChildProcess): void {
    child.once('error', (error) => {
      const hasPid = Boolean(child.pid)
      port.postMessage({
        type: 'errored',
        id: entry.id,
        error: serializeSpawnError(error),
        hasPid,
        terminating: entry.terminating
      })
      if (!hasPid) {
        active.delete(entry.id)
      }
    })
    child.once('close', (code, signal) => {
      clearTimer(entry)
      active.delete(entry.id)
      port.postMessage({ type: 'closed', id: entry.id, code, signal })
    })
  }

  function beginKill(entry: Entry, reason: 'abort' | 'timeout'): void {
    const child = entry.child
    if (!child || entry.terminating || (entry.kind === 'capture' && entry.resultPosted)) {
      return
    }
    entry.terminating = true
    clearTimer(entry)
    void killChildWithMainVerdict(port, entry.id, child, reason)
  }

  function startCapture(request: Extract<SpawnWorkerRequest, { type: 'capture' }>): void {
    const entry = newEntry(request.id, 'capture')
    const startedAt = performance.now()
    let child: ChildProcess
    try {
      // Why: our abort and deadline paths own tree cleanup; Node's signal handler could kill wsl.exe before taskkill sees its children.
      child = execFile(
        request.command,
        request.args,
        {
          cwd: request.cwd,
          // Why: git.exe is console-subsystem and Orca's main process owns no
          // console, so every spawn without this flashes a conhost (#14543).
          windowsHide: true,
          encoding: request.encoding,
          maxBuffer: request.maxBuffer,
          env: request.env
        },
        (error, stdout, stderr) => {
          if (!error && stderr === undefined && isExecFileResultObject(stdout)) {
            postResult(entry, null, stdout.stdout, stdout.stderr)
            return
          }
          postResult(entry, error, stdout, stderr)
        }
      )
    } catch (error) {
      active.delete(entry.id)
      postResult(entry, error instanceof Error ? error : new Error(String(error)), '', '')
      port.postMessage({ type: 'closed', id: entry.id, code: null, signal: null })
      return
    }
    entry.child = child
    port.postMessage({
      type: 'spawned',
      id: entry.id,
      pid: child.pid,
      spawnMs: performance.now() - startedAt
    })
    wireLifecycle(entry, child)
    if (request.stdin !== undefined) {
      endSubprocessStdin(child.stdin, request.stdin)
    }
    // Why: Node's timeout waits forever on signal-ignoring CLIs; enforce our own deadline with bounded tree cleanup.
    if (request.timeoutMs && request.timeoutMs > 0) {
      entry.timer = setTimeout(() => beginKill(entry, 'timeout'), request.timeoutMs)
    }
  }

  function forwardChunk(entry: Entry, channel: 'stdout' | 'stderr', chunk: Buffer): void {
    const data = copyBytes(chunk)
    port.postMessage({ type: 'chunk', id: entry.id, channel, data }, [data.buffer])
    entry.unacked += 1
    if (!entry.paused && entry.unacked >= STREAM_HIGH_WATER_CHUNKS) {
      entry.paused = true
      entry.child?.stdout?.pause()
      entry.child?.stderr?.pause()
    }
  }

  function startStream(request: Extract<SpawnWorkerRequest, { type: 'stream' }>): void {
    const entry = newEntry(request.id, 'stream')
    const startedAt = performance.now()
    let child: ChildProcess
    try {
      child = spawn(request.command, request.args, {
        cwd: request.cwd,
        env: request.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (error) {
      active.delete(entry.id)
      port.postMessage({
        type: 'errored',
        id: entry.id,
        error: serializeSpawnError(error),
        hasPid: false,
        terminating: false
      })
      return
    }
    entry.child = child
    port.postMessage({
      type: 'spawned',
      id: entry.id,
      pid: child.pid,
      spawnMs: performance.now() - startedAt
    })
    child.stdout?.on('data', (chunk: Buffer) => forwardChunk(entry, 'stdout', chunk))
    child.stderr?.on('data', (chunk: Buffer) => forwardChunk(entry, 'stderr', chunk))
    wireLifecycle(entry, child)
  }

  function acknowledge(entry: Entry, chunks: number): void {
    entry.unacked = Math.max(0, entry.unacked - chunks)
    if (entry.paused && entry.unacked <= STREAM_LOW_WATER_CHUNKS) {
      entry.paused = false
      entry.child?.stdout?.resume()
      entry.child?.stderr?.resume()
    }
  }

  function handle(request: SpawnWorkerRequest): void {
    if (request.type === 'capture') {
      startCapture(request)
      return
    }
    if (request.type === 'stream') {
      startStream(request)
      return
    }
    const entry = active.get(request.id)
    if (!entry) {
      return
    }
    if (request.type === 'terminate') {
      beginKill(entry, 'abort')
    } else if (request.type === 'verdict') {
      deliverKillVerdict(request.id, request.admit)
    } else {
      acknowledge(entry, request.chunks)
    }
  }

  function killAll(): void {
    for (const entry of active.values()) {
      try {
        entry.child?.kill()
      } catch {
        // Already exited; nothing to reap.
      }
    }
    active.clear()
  }

  return { handle, killAll }
}
