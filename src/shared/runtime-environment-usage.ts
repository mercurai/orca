import {
  bumpEnvironmentWriteGeneration,
  captureEnvironmentStoreVersion,
  resolveEnvironmentFromStore,
  writeEnvironmentStoreAsync
} from './runtime-environment-store'
import {
  readEnvironmentStore,
  readPersistedEnvironmentStore,
  RuntimeEnvironmentStoreError
} from './runtime-environment-store-file'
import type { PersistedRuntimeEnvironment, RuntimeEnvironmentStore } from './runtime-environments'
import { SecureWriteSupersededError } from './secure-file-async-write'

// Why: markEnvironmentUsed runs on every runtime round-trip; lastUsedAt only needs coarse freshness.
const LAST_USED_PERSIST_INTERVAL_MS = 60_000

export type EnvironmentUsedArgs = {
  runtimeId?: string | null
  /** Recorded only with `pairingDeviceToken`, and only while that token is still the saved one. */
  pairedDeviceId?: string
  /** The token the reply was authenticated with; identity from any other pairing is ignored. */
  pairingDeviceToken?: string
  now?: number
}

export async function markEnvironmentUsed(
  userDataPath: string,
  selector: string,
  args: EnvironmentUsedArgs = {}
): Promise<void> {
  // Same version guard as the detached stamp, so a mutation published meanwhile is never overwritten.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const isCurrent = captureEnvironmentStoreVersion(userDataPath)
    const plan = planEnvironmentUsedUpdate(userDataPath, selector, args)
    if (!plan) {
      return
    }
    try {
      await writeEnvironmentStoreAsync(userDataPath, plan.store, {
        shouldPublish: () => {
          if (!isCurrent()) {
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
  args: EnvironmentUsedArgs = {}
): { store: RuntimeEnvironmentStore; environmentId: string } | null {
  const store = readPersistedEnvironmentStore(userDataPath)
  const environment = resolveEnvironmentFromStore(store, selector)
  const now = args.now ?? Date.now()
  // Why: a reply that raced a re-pair carries the previous device's identity; recording it beside
  // the new token makes every later identity check fail.
  const fromSavedPairing =
    args.pairingDeviceToken === undefined ||
    preferredDeviceToken(environment) === args.pairingDeviceToken
  const runtimeIdChanged =
    fromSavedPairing && args.runtimeId != null && args.runtimeId !== environment.runtimeId
  const pairedDeviceIdChanged =
    fromSavedPairing &&
    args.pairingDeviceToken !== undefined &&
    args.pairedDeviceId != null &&
    args.pairedDeviceId !== environment.pairedDeviceId
  const lastUsedIsFresh =
    environment.lastUsedAt != null &&
    now >= environment.lastUsedAt &&
    now - environment.lastUsedAt < LAST_USED_PERSIST_INTERVAL_MS
  if (!runtimeIdChanged && !pairedDeviceIdChanged && lastUsedIsFresh) {
    return null
  }
  if (runtimeIdChanged || pairedDeviceIdChanged) {
    const current = resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), environment.id)
    if (current.sshAccess || current.pendingSshAccessOperation) {
      throw new RuntimeEnvironmentStoreError(
        'invalid_argument',
        'SSH access operation cannot change the paired runtime identity.'
      )
    }
  }
  const next = store.environments.map((entry) =>
    entry.id === environment.id
      ? {
          ...entry,
          runtimeId: (runtimeIdChanged ? args.runtimeId : null) ?? entry.runtimeId,
          ...(pairedDeviceIdChanged && args.pairedDeviceId
            ? { pairedDeviceId: args.pairedDeviceId }
            : {}),
          lastUsedAt: now,
          updatedAt: now
        }
      : entry
  )
  return { store: { version: 1, environments: next }, environmentId: environment.id }
}

function preferredDeviceToken(environment: PersistedRuntimeEnvironment): string | undefined {
  return (
    environment.endpoints.find((entry) => entry.id === environment.preferredEndpointId) ??
    environment.endpoints[0]
  )?.deviceToken
}
