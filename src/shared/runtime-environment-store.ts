import { randomUUID } from 'node:crypto'
import { parsePairingCode, type PairingOffer } from './pairing'
import { classifyRemotePairingHostname } from './remote-pairing-address'
import {
  createEnvironmentFromPairingOffer,
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment,
  type PersistedRuntimeEnvironment,
  type RuntimeEnvironmentSource,
  type RuntimeEnvironmentStore
} from './runtime-environments'
import {
  readEnvironmentStore,
  readPersistedEnvironmentStore,
  RuntimeEnvironmentStoreError,
  runEnvironmentStoreMutation,
  writeEnvironmentStoreAsync
} from './runtime-environment-store-file'
import { writeRuntimeEnvironmentSidecarEntry } from './runtime-environment-sidecar'

export {
  getEnvironmentStorePath,
  MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES,
  RuntimeEnvironmentStoreError,
  type RuntimeEnvironmentStoreErrorCode
} from './runtime-environment-store-file'

export function listEnvironments(
  userDataPath: string,
  options: { requireStoreFile?: boolean } = {}
): KnownRuntimeEnvironment[] {
  return readEnvironmentStore(userDataPath, options).environments
}

export async function addEnvironmentFromPairingCode(
  userDataPath: string,
  args: {
    name: string
    pairingCode: string
    now?: number
    source?: RuntimeEnvironmentSource
    connectionDependency?: 'ssh-tunnel'
  }
): Promise<KnownRuntimeEnvironment> {
  const offer = parsePairingCode(args.pairingCode)
  if (!offer) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'Invalid pairing code. Expected an orca://pair?... URL or bare pairing payload.'
    )
  }
  // Why validated before the lane: a bad code fails fast without queueing behind other writes.
  return await runEnvironmentStoreMutation(userDataPath, async () => {
    const store = readPersistedEnvironmentStore(userDataPath)
    const now = args.now ?? Date.now()
    const existing = store.environments.find((entry) => entry.name === args.name)
    if (existing) {
      throw new RuntimeEnvironmentStoreError(
        'invalid_argument',
        `A server named "${args.name}" already exists.`
      )
    }
    const environment = createEnvironmentFromPairingOffer({
      id: randomUUID(),
      name: args.name,
      now,
      offer,
      runtimeId: null,
      ...(args.source ? { source: args.source } : {}),
      ...getPairingConnectionDependency(args.connectionDependency, offer)
    })
    const next = {
      version: 1 as const,
      environments: [
        ...store.environments.filter((entry) => entry.id !== environment.id),
        environment
      ].sort((a, b) => a.name.localeCompare(b.name))
    }
    await writeEnvironmentStoreAsync(userDataPath, next)
    return environment
  })
}

export async function removeEnvironment(
  userDataPath: string,
  selector: string
): Promise<KnownRuntimeEnvironment> {
  return await runEnvironmentStoreMutation(userDataPath, async () => {
    const environment = resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), selector)
    assertNoIndependentSshAccess(environment)
    const store = readPersistedEnvironmentStore(userDataPath)
    const persisted = resolveEnvironmentFromStore(store, environment.id)
    const remaining = store.environments.filter((entry) => entry.id !== environment.id)
    await writeEnvironmentStoreAsync(userDataPath, { version: 1, environments: remaining })
    // A leftover entry would read as stale anyway; dropping it keeps the sidecar from growing.
    await writeRuntimeEnvironmentSidecarEntry(userDataPath, remaining, persisted, null)
    return environment
  })
}

export async function updateEnvironmentFromPairingCode(
  userDataPath: string,
  selector: string,
  args: { pairingCode: string; now?: number }
): Promise<KnownRuntimeEnvironment> {
  const offer = parsePairingCode(args.pairingCode)
  if (!offer) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'Invalid pairing code. Expected an orca://pair?... URL or bare pairing payload.'
    )
  }
  return await runEnvironmentStoreMutation(userDataPath, async () => {
    assertNoIndependentSshAccess(
      resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), selector)
    )
    const store = readPersistedEnvironmentStore(userDataPath)
    const existing = resolveEnvironmentFromStore(store, selector)
    const now = args.now ?? Date.now()
    const previousPairingRevision = existing.pairingRevision ?? existing.createdAt
    const environment = createEnvironmentFromPairingOffer({
      id: existing.id,
      name: existing.name,
      now: existing.createdAt,
      offer,
      runtimeId: existing.runtimeId,
      ...(existing.source ? { source: existing.source } : {}),
      ...getPairingConnectionDependency(existing.connectionDependency, offer)
    })
    const next = {
      ...environment,
      createdAt: existing.createdAt,
      updatedAt: now,
      pairingRevision: Math.max(now, previousPairingRevision + 1),
      lastUsedAt: existing.lastUsedAt
    }
    await writeEnvironmentStoreAsync(userDataPath, {
      version: 1,
      environments: store.environments
        .map((entry) => (entry.id === existing.id ? next : entry))
        .sort((a, b) => a.name.localeCompare(b.name))
    })
    return next
  })
}

function getPairingConnectionDependency(
  dependency: 'ssh-tunnel' | undefined,
  offer: PairingOffer
): { connectionDependency?: 'ssh-tunnel' } {
  if (!dependency) {
    return {}
  }
  try {
    const endpoint = new URL(offer.endpoint)
    return classifyRemotePairingHostname(endpoint.hostname) === 'loopback'
      ? { connectionDependency: dependency }
      : {}
  } catch {
    return {}
  }
}

export function resolveEnvironment(
  userDataPath: string,
  selector: string
): KnownRuntimeEnvironment {
  return resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), selector)
}

export function resolveEnvironmentPairingOffer(
  userDataPath: string,
  selector: string
): PairingOffer {
  return getPreferredPairingOffer(resolveEnvironment(userDataPath, selector))
}

// Why: markEnvironmentUsed runs on every runtime round-trip; persisting lastUsedAt each
// time forces a secure-file rewrite (ACL hardening), which blocks the main thread on
// Windows. lastUsedAt only needs coarse freshness, so skip writes within this window.
const LAST_USED_PERSIST_INTERVAL_MS = 60_000

/** What `markEnvironmentUsed` would write, or null while `lastUsedAt` is fresh. Reads synchronously,
 *  so an unknown environment (or an identity change under SSH access) throws as it always did. */
export function planEnvironmentUsedUpdate(
  userDataPath: string,
  selector: string,
  args: {
    runtimeId?: string | null
    /** Recorded only with `pairingDeviceToken`, and only while that token is still the saved one. */
    pairedDeviceId?: string
    /** The token the reply was authenticated with; identity from any other pairing is ignored. */
    pairingDeviceToken?: string
    now?: number
  } = {}
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

export type EnvironmentUsageArgs = NonNullable<Parameters<typeof planEnvironmentUsedUpdate>[2]>

export async function markEnvironmentUsed(
  userDataPath: string,
  selector: string,
  args: EnvironmentUsageArgs = {}
): Promise<void> {
  await runEnvironmentStoreMutation(userDataPath, async () => {
    const plan = planEnvironmentUsedUpdate(userDataPath, selector, args)
    if (plan) {
      await writeEnvironmentStoreAsync(userDataPath, plan.store)
    }
  })
}

function preferredDeviceToken(environment: PersistedRuntimeEnvironment): string | undefined {
  return (
    environment.endpoints.find((entry) => entry.id === environment.preferredEndpointId) ??
    environment.endpoints[0]
  )?.deviceToken
}

export function resolveEnvironmentFromStore<T extends PersistedRuntimeEnvironment>(
  store: { environments: T[] },
  selector: string
): T {
  const byId = store.environments.find((entry) => entry.id === selector)
  if (byId) {
    return byId
  }
  const matches = store.environments.filter((entry) => entry.name === selector)
  if (matches.length === 1) {
    return matches[0]!
  }
  if (matches.length > 1) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      `Environment name "${selector}" is ambiguous; use the environment id.`
    )
  }
  throw new RuntimeEnvironmentStoreError('invalid_argument', `Unknown environment: ${selector}`)
}

function assertNoIndependentSshAccess(environment: KnownRuntimeEnvironment): void {
  if (environment.orcadDeployment) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'This server is managed by Orca over SSH; its pairing cannot be replaced or removed here. To decommission it, run `orca environment stop --environment <name> --yes` or use Settings > Managed servers; for a host that is gone, run `orca environment forget --environment <name> --yes`.'
    )
  }
  if (environment.sshAccess || environment.pendingSshAccessOperation) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      "Unlink this server's SSH access before replacing its pairing or removing it."
    )
  }
}
