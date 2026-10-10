import {
  getEnvironmentStorePath,
  getEnvironmentWriteGeneration,
  writeEnvironmentStoreAsync
} from './runtime-environment-store'
import { planEnvironmentUsedUpdate } from './runtime-environment-usage'
import { SecureWriteSupersededError } from './secure-file-async-write'

type UsageArgs = { runtimeId?: string | null; pairedDeviceId?: string }

// Why: the store is rewritten (two icacls spawns on Windows) at most once per minute per environment,
// but the write is async, so responses landing mid-write fold into one pending stamp (latest wins).
const writing = new Map<string, { pending: UsageArgs | null }>()
// A sync mutation (pairing edit, removal) between our read and the rename voids the snapshot: re-read.
const MAX_ATTEMPTS = 2

function foldUsageArgs(into: UsageArgs | null, next: UsageArgs): UsageArgs {
  return {
    runtimeId: next.runtimeId ?? into?.runtimeId,
    pairedDeviceId: next.pairedDeviceId ?? into?.pairedDeviceId
  }
}

async function persistStamp(
  userDataPath: string,
  selector: string,
  args: UsageArgs
): Promise<void> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const generation = getEnvironmentWriteGeneration()
    const plan = planEnvironmentUsedUpdate(userDataPath, selector, args)
    if (!plan) {
      return
    }
    try {
      await writeEnvironmentStoreAsync(userDataPath, plan.store, {
        shouldPublish: () => getEnvironmentWriteGeneration() === generation
      })
      return
    } catch (error) {
      if (!(error instanceof SecureWriteSupersededError)) {
        throw error
      }
    }
  }
  // Two attempts lost to concurrent edits: dropping a lastUsedAt stamp is harmless, the next response re-stamps.
}

/**
 * `markEnvironmentUsed` for main-process request paths: resolves the environment synchronously (so
 * an unknown one throws exactly as before) and persists `lastUsedAt` without blocking the IPC thread.
 */
export function markEnvironmentUsedDetached(
  userDataPath: string,
  selector: string,
  args: UsageArgs = {}
): void {
  const plan = planEnvironmentUsedUpdate(userDataPath, selector, args)
  if (!plan) {
    return
  }
  const key = `${getEnvironmentStorePath(userDataPath)}|${plan.environmentId}`
  const inFlight = writing.get(key)
  if (inFlight) {
    inFlight.pending = foldUsageArgs(inFlight.pending, args)
    return
  }
  const state: { pending: UsageArgs | null } = { pending: null }
  writing.set(key, state)
  void (async () => {
    let next: UsageArgs | null = args
    while (next) {
      try {
        await persistStamp(userDataPath, selector, next)
      } catch (error) {
        console.warn(`Could not persist last-used time for runtime environment ${selector}:`, error)
      }
      next = state.pending
      state.pending = null
    }
    writing.delete(key)
  })()
}
