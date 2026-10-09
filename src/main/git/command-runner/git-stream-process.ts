import { spawn, type ChildProcess } from 'node:child_process'
import { recordSubprocessSpawn } from '../../diagnostics/main-thread-churn-probe'
import { getGitSpawnWorkerClient } from './git-spawn-worker-access'
import { gitSpawn } from './git-spawn'
import { resolveGitSpawnTarget } from './git-spawn-target'
import { untranslatedGitOutputEnv } from './git-process-env'
import { killSpawnedCommandTree } from './spawned-command-tree-kill'
import type { ResolvedCommand } from './wsl-command-resolution'

export type StreamListeners = {
  onStdout: (chunk: Buffer) => void
  onStderr: (chunk: Buffer) => void
  onError: (error: Error) => void
  onClose: (code: number | null) => void
  /** The child closed, or failed before it started: its admission grant may be released. */
  onTerminated: () => void
}

export type StreamedProcess = {
  readonly pid: number | undefined
  killTree: () => Promise<void>
  /** Stops output, error and close callbacks; termination is still reported. */
  detach: () => void
}

type StreamSpawnOptions = { cwd: string; env: NodeJS.ProcessEnv; wslDistro?: string }

function streamInProcess(
  command: ResolvedCommand,
  args: string[],
  options: StreamSpawnOptions
): ChildProcess {
  const stdio: ['ignore', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe']
  if (command.wslMode !== 'direct-git') {
    return gitSpawn(args, { ...options, stdio, windowsHide: true })
  }
  const spawnStartedAt = performance.now()
  const child = spawn(command.binary, command.args, {
    cwd: command.cwd,
    env: untranslatedGitOutputEnv(options.env),
    stdio,
    windowsHide: true
  })
  recordSubprocessSpawn(command.binary, command.args, performance.now() - spawnStartedAt)
  return child
}

function wrapChild(child: ChildProcess, listeners: StreamListeners): StreamedProcess {
  let live = true
  child.once('close', listeners.onTerminated)
  child.once('error', () => {
    if (!child.pid) {
      listeners.onTerminated()
    }
  })
  child.stdout?.on('data', (chunk: Buffer) => {
    if (live) {
      listeners.onStdout(chunk)
    }
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    if (live) {
      listeners.onStderr(chunk)
    }
  })
  // Why permanent: an `error` with no listener is an uncaught exception, and a failed spawn can report after cleanup.
  child.on('error', (error) => {
    if (live) {
      listeners.onError(error)
    }
  })
  child.on('close', (code) => {
    if (live) {
      listeners.onClose(code)
    }
  })
  return {
    get pid() {
      return child.pid
    },
    killTree: () => killSpawnedCommandTree(child),
    detach: () => {
      live = false
    }
  }
}

function streamOnWorker(
  command: ResolvedCommand,
  args: string[],
  options: StreamSpawnOptions,
  listeners: StreamListeners
): StreamedProcess | null {
  const client = getGitSpawnWorkerClient()
  if (!client) {
    return null
  }
  const target =
    command.wslMode === 'direct-git'
      ? {
          binary: command.binary,
          args: command.args,
          cwd: command.cwd,
          env: untranslatedGitOutputEnv(options.env)
        }
      : resolveGitSpawnTarget(args, options)
  let live = true
  const handle = client.stream(
    { command: target.binary, args: target.args, cwd: target.cwd, env: target.env },
    {
      onChunk: (channel, data) => {
        if (!live) {
          return
        }
        if (channel === 'stdout') {
          listeners.onStdout(data)
        } else {
          listeners.onStderr(data)
        }
      },
      onError: (error, hasPid) => {
        if (live) {
          listeners.onError(error)
        }
        if (!hasPid) {
          listeners.onTerminated()
        }
      },
      onClose: (code) => {
        if (live) {
          listeners.onClose(code)
        }
        listeners.onTerminated()
      }
    }
  )
  if (!handle) {
    return null
  }
  return {
    get pid() {
      return handle.pid
    },
    killTree: () => {
      handle.terminate()
      return Promise.resolve()
    },
    detach: () => {
      live = false
    }
  }
}

/**
 * Start a git child whose stdout and stderr stream to `listeners`. The spawn runs on
 * the git spawn worker thread when one is usable, else in this process (#1085).
 */
export function startStreamedGitProcess(
  command: ResolvedCommand,
  args: string[],
  options: StreamSpawnOptions,
  listeners: StreamListeners
): StreamedProcess {
  let terminated = false
  const guarded: StreamListeners = {
    ...listeners,
    onTerminated: () => {
      if (!terminated) {
        terminated = true
        listeners.onTerminated()
      }
    }
  }
  return (
    streamOnWorker(command, args, options, guarded) ??
    wrapChild(streamInProcess(command, args, options), guarded)
  )
}
