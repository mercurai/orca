// Main installs diagnostics here; daemon, relay, and CLI cannot depend on main code.
export type SpawnObserver = (command: string, args: readonly string[], blockMs: number) => void

let observer: SpawnObserver | null = null

export function setSpawnObserver(next: SpawnObserver | null): void {
  observer = next
}

export function notifySpawnObserver(
  command: string,
  args: readonly string[],
  blockMs: number
): void {
  observer?.(command, args, blockMs)
}

export function hasSpawnObserver(): boolean {
  return observer !== null
}

/**
 * A spawn the worker thread performed: counted so per-command spawn totals stay complete, but
 * attributed no block, because the main loop did not wait for it.
 */
export function notifyWorkerSpawn(command: string, args: readonly string[]): void {
  observer?.(command, args, 0)
}
