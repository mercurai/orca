import {
  getEnvironmentStorePath,
  markEnvironmentUsed,
  planEnvironmentUsedUpdate,
  type EnvironmentUsageArgs
} from './runtime-environment-store'

// Why: the store is rewritten (two icacls spawns on Windows) at most once per minute per environment,
// but the write is async, so responses landing mid-write fold into one pending stamp.
const writing = new Map<string, { pending: EnvironmentUsageArgs | null }>()

function carriesIdentity(args: EnvironmentUsageArgs): boolean {
  return args.runtimeId != null || args.pairedDeviceId != null
}

// Why whole-args replacement: a paired device id is only valid with the token its reply carried,
// so an id from one reply must never be recorded beside the token of another.
function foldUsageArgs(
  into: EnvironmentUsageArgs | null,
  next: EnvironmentUsageArgs
): EnvironmentUsageArgs {
  return into && !carriesIdentity(next) ? into : next
}

/**
 * `markEnvironmentUsed` for main-process request paths: resolves the environment synchronously (so
 * an unknown one throws exactly as before) and persists `lastUsedAt` without blocking the IPC thread.
 */
export function markEnvironmentUsedDetached(
  userDataPath: string,
  selector: string,
  args: EnvironmentUsageArgs = {}
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
  const state: { pending: EnvironmentUsageArgs | null } = { pending: null }
  writing.set(key, state)
  void (async () => {
    let next: EnvironmentUsageArgs | null = args
    while (next) {
      try {
        // Re-plans inside the store's mutation lane, so a pairing edit meanwhile is never overwritten.
        await markEnvironmentUsed(userDataPath, selector, next)
      } catch (error) {
        console.warn(`Could not persist last-used time for runtime environment ${selector}:`, error)
      }
      next = state.pending
      state.pending = null
    }
    writing.delete(key)
  })()
}
