import {
  bumpEnvironmentWriteGeneration,
  getEnvironmentWriteGeneration,
  readEnvironmentStore,
  resolveEnvironmentFromStore,
  writeEnvironmentStoreAsync
} from './runtime-environment-store'
import type { RuntimeEnvironmentStore } from './runtime-environments'
import { SecureWriteSupersededError } from './secure-file-async-write'

// Why: markEnvironmentUsed runs on every runtime round-trip; lastUsedAt only needs coarse freshness.
const LAST_USED_PERSIST_INTERVAL_MS = 60_000

export async function markEnvironmentUsed(
  userDataPath: string,
  selector: string,
  args: { runtimeId?: string | null; pairedDeviceId?: string; now?: number } = {}
): Promise<void> {
  // Same generation guard as the detached stamp, so a mutation published meanwhile is never overwritten.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const generation = getEnvironmentWriteGeneration()
    const plan = planEnvironmentUsedUpdate(userDataPath, selector, args)
    if (!plan) {
      return
    }
    try {
      await writeEnvironmentStoreAsync(userDataPath, plan.store, {
        shouldPublish: () => {
          if (getEnvironmentWriteGeneration() !== generation) {
            return false
          }
          bumpEnvironmentWriteGeneration()
          return true
        }
      })
      return
    } catch (error) {
      if (!(error instanceof SecureWriteSupersededError)) {
        throw error
      }
    }
  }
}

// What `markEnvironmentUsed` would write, or null while `lastUsedAt` is fresh; throws for an unknown environment.
export function planEnvironmentUsedUpdate(
  userDataPath: string,
  selector: string,
  args: { runtimeId?: string | null; pairedDeviceId?: string; now?: number } = {}
): { store: RuntimeEnvironmentStore; environmentId: string } | null {
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
  return { store: { version: 1, environments: next }, environmentId: environment.id }
}
