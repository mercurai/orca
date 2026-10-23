import type { ProcessSpec, ProcessResult } from './process-spec'

/**
 * Runs a capture on the spawn worker thread. Null means the spec cannot cross the thread or no
 * worker is usable, so the caller spawns here. `inProcess` re-runs the same capture locally for a
 * request the worker never started.
 *
 * Why a seam: runProcess also runs in the terminal daemon, the relay and the CLI, none of which
 * have the spawn worker. Electron main registers the route once at startup; everywhere else
 * nothing is registered and every capture spawns in-process.
 */
export type RunProcessRoute = (
  spec: ProcessSpec,
  outputCapture: 'head' | 'tail',
  inProcess: () => Promise<ProcessResult>
) => Promise<ProcessResult> | null

let runProcessRoute: RunProcessRoute | null = null

export function setRunProcessRoute(next: RunProcessRoute | null): void {
  runProcessRoute = next
}

export function routeRunProcess(
  spec: ProcessSpec,
  outputCapture: 'head' | 'tail',
  inProcess: () => Promise<ProcessResult>
): Promise<ProcessResult> {
  return runProcessRoute?.(spec, outputCapture, inProcess) ?? inProcess()
}
