import type { ProcessResult, ProcessSpec } from './process-spec'

// Why a seam: runProcess also runs in the terminal daemon, the relay and the CLI, none of which
// have the spawn worker or may import main. Electron main registers the route once at startup;
// everywhere else nothing is registered and every capture spawns in-process, as before.

/**
 * Runs a capture on the spawn worker thread. Null means the spec cannot cross the thread or no
 * worker is usable, so the caller spawns here. `inProcess` re-runs the same capture locally for a
 * request the worker never started.
 */
export type RunProcessRoute = (
  spec: ProcessSpec,
  outputCapture: 'head' | 'tail',
  inProcess: () => Promise<ProcessResult>
) => Promise<ProcessResult> | null

let route: RunProcessRoute | null = null

export function setRunProcessRoute(next: RunProcessRoute | null): void {
  route = next
}

export function routeRunProcess(
  spec: ProcessSpec,
  outputCapture: 'head' | 'tail',
  inProcess: () => Promise<ProcessResult>
): Promise<ProcessResult> | null {
  return route?.(spec, outputCapture, inProcess) ?? null
}
