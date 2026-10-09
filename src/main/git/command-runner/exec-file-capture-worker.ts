import { fileURLToPath } from 'node:url'
import { createAbortError } from './abort-error'
import type { ExecFileCaptureOptions } from './exec-file-capture'
import { DEFAULT_GIT_MAX_BUFFER } from './git-exec-options'
import { getGitSpawnWorkerClient } from './git-spawn-worker-access'
import type { CaptureOutcome } from './git-spawn-worker-client'

type CaptureOutput = { stdout: string | Buffer; stderr: string | Buffer }

function emptyOutput(options: ExecFileCaptureOptions): string | Buffer {
  return options.encoding === 'buffer' ? Buffer.alloc(0) : ''
}

function settleCapture(
  outcome: CaptureOutcome,
  command: string,
  options: ExecFileCaptureOptions
): CaptureOutput {
  let error: Error
  let stdout: string | Buffer = emptyOutput(options)
  let stderr: string | Buffer = emptyOutput(options)
  if (outcome.kind === 'killed') {
    error =
      outcome.reason === 'timeout'
        ? (options.createTimeoutError?.() ?? new Error(`${command} timed out.`))
        : createAbortError()
  } else if (outcome.kind === 'failed') {
    error = outcome.error
  } else if (outcome.error) {
    error = outcome.error
    stdout = outcome.stdout
    stderr = outcome.stderr
  } else {
    return { stdout: outcome.stdout, stderr: outcome.stderr }
  }
  const enriched: Error & { stdout?: string | Buffer; stderr?: string | Buffer } = error
  enriched.stdout ??= stdout
  enriched.stderr ??= stderr
  throw enriched
}

/**
 * Run execFileCapture's spawn, deadline and tree kill on the git spawn worker thread.
 * Returns null when no worker is usable, so the caller spawns in-process instead.
 */
export function execFileCaptureOnWorker(
  command: string,
  args: string[],
  options: ExecFileCaptureOptions
): Promise<CaptureOutput> | null {
  const client = getGitSpawnWorkerClient()
  if (!client) {
    return null
  }
  const cwd = options.cwd instanceof URL ? fileURLToPath(options.cwd) : options.cwd
  const handle = client.capture(
    {
      command,
      args,
      ...(cwd === undefined ? {} : { cwd }),
      ...(options.env ? { env: options.env } : {}),
      encoding: options.encoding,
      maxBuffer: options.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER,
      ...(options.timeout && options.timeout > 0 ? { timeoutMs: options.timeout } : {}),
      ...(options.stdin === undefined ? {} : { stdin: options.stdin })
    },
    () => options.onChildTerminated?.()
  )
  if (!handle) {
    return null
  }
  const { signal } = options
  const onAbort = (): void => handle.terminate()
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) {
    onAbort()
  }
  return handle.outcome.then((outcome) => {
    signal?.removeEventListener('abort', onAbort)
    return settleCapture(outcome, command, options)
  })
}
