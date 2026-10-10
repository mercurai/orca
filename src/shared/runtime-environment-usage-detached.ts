import { getEnvironmentStorePath, writeEnvironmentStoreAsync } from './runtime-environment-store'
import { planEnvironmentUsedUpdate } from './runtime-environment-usage'

// Why: the environment store is rewritten (two icacls spawns on Windows) at most once per minute per
// environment, but the write is now async, so responses arriving while it is in flight would each
// plan and queue another identical rewrite.
const inFlightUsageWrites = new Set<string>()

/**
 * `markEnvironmentUsed` for main-process request paths: resolves the environment synchronously (so
 * an unknown one throws exactly as before) and persists `lastUsedAt` without blocking the IPC thread.
 */
export function markEnvironmentUsedDetached(
  userDataPath: string,
  selector: string,
  args: { runtimeId?: string | null; pairedDeviceId?: string } = {}
): void {
  const next = planEnvironmentUsedUpdate(userDataPath, selector, args)
  if (!next) {
    return
  }
  const key = `${getEnvironmentStorePath(userDataPath)}|${selector}`
  if (inFlightUsageWrites.has(key)) {
    return
  }
  inFlightUsageWrites.add(key)
  void writeEnvironmentStoreAsync(userDataPath, next)
    .catch((error: unknown) => {
      console.warn(
        `Could not persist last-used time for runtime environment ${selector}:`,
        error instanceof Error ? error.message : error
      )
    })
    .finally(() => {
      inFlightUsageWrites.delete(key)
    })
}
