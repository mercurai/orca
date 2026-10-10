import {
  readEnvironmentStore,
  resolveEnvironmentFromStore,
  writeEnvironmentStore
} from './runtime-environment-store'
import type { RuntimeEnvironmentStore } from './runtime-environments'

// Why: markEnvironmentUsed runs on every runtime round-trip; lastUsedAt only needs coarse freshness.
const LAST_USED_PERSIST_INTERVAL_MS = 60_000

export function markEnvironmentUsed(
  userDataPath: string,
  selector: string,
  args: { runtimeId?: string | null; pairedDeviceId?: string; now?: number } = {}
): void {
  const next = planEnvironmentUsedUpdate(userDataPath, selector, args)
  if (next) {
    writeEnvironmentStore(userDataPath, next)
  }
}

// The store `markEnvironmentUsed` would write, or null while `lastUsedAt` is fresh; throws for an unknown environment.
export function planEnvironmentUsedUpdate(
  userDataPath: string,
  selector: string,
  args: { runtimeId?: string | null; pairedDeviceId?: string; now?: number } = {}
): RuntimeEnvironmentStore | null {
  const store = readEnvironmentStore(userDataPath)
  const environment = resolveEnvironmentFromStore(store, selector)
  const now = args.now ?? Date.now()
  const runtimeIdChanged = args.runtimeId != null && args.runtimeId !== environment.runtimeId
  const pairedDeviceIdChanged =
    args.pairedDeviceId != null && args.pairedDeviceId !== environment.pairedDeviceId
  const lastUsedIsFresh =
    environment.lastUsedAt != null &&
    now >= environment.lastUsedAt &&
    now - environment.lastUsedAt < LAST_USED_PERSIST_INTERVAL_MS
  if (!runtimeIdChanged && !pairedDeviceIdChanged && lastUsedIsFresh) {
    return null
  }
  const next = store.environments.map((entry) =>
    entry.id === environment.id
      ? {
          ...entry,
          runtimeId: args.runtimeId ?? entry.runtimeId,
          ...(args.pairedDeviceId ? { pairedDeviceId: args.pairedDeviceId } : {}),
          lastUsedAt: now,
          updatedAt: now
        }
      : entry
  )
  return { version: 1, environments: next }
}
