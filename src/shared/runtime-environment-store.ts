import { randomUUID } from 'node:crypto'
import { parsePairingCode, type PairingOffer } from './pairing'
import { classifyRemotePairingHostname } from './remote-pairing-address'
import { isProfileRuntimePublicKey } from './runtime-e2ee-keypair-file'
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
  writeEnvironmentStoreAsync
} from './runtime-environment-store-file'
import { writeRuntimeEnvironmentSidecarEntryWithinMutation } from './runtime-environment-sidecar'
import { SecureWriteSupersededError } from './secure-file-async-write'
import {
  captureEnvironmentStoreVersion,
  withRuntimeEnvironmentMutation
} from './runtime-environment-store-mutation'
export {
  bumpEnvironmentWriteGeneration,
  captureEnvironmentStoreVersion,
  getEnvironmentWriteGeneration
} from './runtime-environment-store-mutation'
export { writeEnvironmentStoreAsync } from './runtime-environment-store-file'

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
  const offer = parseRemotePairingCode(userDataPath, args.pairingCode)
  const id = randomUUID()
  return await mutateEnvironmentStore(userDataPath, (store) => {
    const existing = store.environments.find((entry) => entry.name === args.name)
    if (existing) {
      throw new RuntimeEnvironmentStoreError(
        'invalid_argument',
        `A server named "${args.name}" already exists.`
      )
    }
    const environment = createEnvironmentFromPairingOffer({
      id,
      name: args.name,
      now: args.now ?? Date.now(),
      offer,
      runtimeId: null,
      ...(args.source ? { source: args.source } : {}),
      ...getPairingConnectionDependency(args.connectionDependency, offer)
    })
    const environments = [
      ...store.environments.filter((entry) => entry.id !== environment.id),
      environment
    ].sort((a, b) => a.name.localeCompare(b.name))
    return { store: { version: 1, environments }, result: environment }
  })
}

function parseRemotePairingCode(userDataPath: string, pairingCode: string): PairingOffer {
  const offer = parsePairingCode(pairingCode)
  if (!offer) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'Invalid pairing code. Expected an orca://pair?... URL or bare pairing payload.'
    )
  }
  // Why the key, not the address: a loopback or LAN address proves nothing either way.
  if (isProfileRuntimePublicKey(userDataPath, offer.publicKeyB64)) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'This pairing code is for this Orca itself. Generate the code on the other computer instead.'
    )
  }
  return offer
}

export async function removeEnvironment(
  userDataPath: string,
  selector: string
): Promise<KnownRuntimeEnvironment> {
  return withRuntimeEnvironmentMutation(userDataPath, async () => {
    const removal = await mutateEnvironmentStoreWithinMutation(userDataPath, (store) => {
      const environment = resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), selector)
      assertNoIndependentSshAccess(environment)
      const persisted = resolveEnvironmentFromStore(store, environment.id)
      const remaining = store.environments.filter((entry) => entry.id !== environment.id)
      return {
        store: { version: 1, environments: remaining },
        result: { environment, persisted, remaining }
      }
    })
    // A leftover entry would read as stale anyway; dropping it keeps the sidecar from growing.
    await writeRuntimeEnvironmentSidecarEntryWithinMutation(userDataPath, removal.remaining, removal.persisted, null)
    return removal.environment
  })
}

export async function updateEnvironmentFromPairingCode(
  userDataPath: string,
  selector: string,
  args: { pairingCode: string; now?: number; runtimeId?: string }
): Promise<KnownRuntimeEnvironment> {
  const offer = parseRemotePairingCode(userDataPath, args.pairingCode)
  return await mutateEnvironmentStore(userDataPath, (store) => {
    assertNoIndependentSshAccess(
      resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), selector)
    )
    const existing = resolveEnvironmentFromStore(store, selector)
    const now = args.now ?? Date.now()
    const previousPairingRevision = existing.pairingRevision ?? existing.createdAt
    const environment = createEnvironmentFromPairingOffer({
      id: existing.id,
      name: existing.name,
      now: existing.createdAt,
      offer,
      runtimeId: args.runtimeId ?? existing.runtimeId,
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
    const environments = store.environments
      .map((entry) => (entry.id === existing.id ? next : entry))
      .sort((a, b) => a.name.localeCompare(b.name))
    return { store: { version: 1, environments }, result: next }
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
  if (environment.pendingSshAccessOperation) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      "This server's SSH access change didn't finish. Retry or cancel it under Settings > Remote Orca Servers > SSH access for paired servers before replacing its pairing or removing it."
    )
  }
  if (environment.sshAccess) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      "Unlink this server's SSH access under Settings > Remote Orca Servers > SSH access for paired servers before replacing its pairing or removing it."
    )
  }
}

// Bumped by every publish: a read-modify-write compares it before publishing and re-reads when stale.
const MAX_MUTATION_ATTEMPTS = 5

function mutateEnvironmentStore<TResult>(
  userDataPath: string,
  compute: (store: RuntimeEnvironmentStore) => { store: RuntimeEnvironmentStore; result: TResult }
): Promise<TResult> {
  return withRuntimeEnvironmentMutation(userDataPath, () =>
    mutateEnvironmentStoreWithinMutation(userDataPath, compute))
}

/** Read-modify-write on the async lane; `compute` runs on a fresh snapshot per attempt and may throw. */
async function mutateEnvironmentStoreWithinMutation<TResult>(
  userDataPath: string,
  compute: (store: RuntimeEnvironmentStore) => { store: RuntimeEnvironmentStore; result: TResult }
): Promise<TResult> {
  for (let attempt = 1; ; attempt += 1) {
    const isCurrent = captureEnvironmentStoreVersion(userDataPath)
    const { store, result } = compute(readPersistedEnvironmentStore(userDataPath))
    try {
      await writeEnvironmentStoreAsync(userDataPath, store, {
        shouldPublish: () => {
          if (!isCurrent()) {
            return false
          }
          return true
        }
      })
      return result
    } catch (error) {
      if (!(error instanceof SecureWriteSupersededError) || attempt >= MAX_MUTATION_ATTEMPTS) {
        throw error
      }
    }
  }
}
