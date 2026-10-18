import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { writeSecureJsonFileWithinLimitAsync } from './bounded-secure-json-file'
import { JsonStringifyByteLimitError } from './node-bounded-json-stringify'
import { parsePairingCode, type PairingOffer } from './pairing'
import { classifyRemotePairingHostname } from './remote-pairing-address'
import { isProfileRuntimePublicKey } from './runtime-e2ee-keypair-file'
import {
  createEnvironmentFromPairingOffer,
  getPreferredPairingOffer,
  RuntimeEnvironmentStoreSchema,
  type KnownRuntimeEnvironment,
  type PersistedRuntimeEnvironment,
  type RuntimeEnvironmentSource,
  type RuntimeEnvironmentStore
} from './runtime-environments'
import {
  readEnvironmentStore,
  readPersistedEnvironmentStore,
  RuntimeEnvironmentStoreError
} from './runtime-environment-store-file'
import {
  getEnvironmentStorePath,
  MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES,
  readEnvironmentStoreRecords
} from './runtime-environment-store-records'
import { writeRuntimeEnvironmentSidecarEntry } from './runtime-environment-sidecar'
import { SecureWriteSupersededError } from './secure-file-async-write'

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
  const removal = await mutateEnvironmentStore(userDataPath, (store) => {
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
  writeRuntimeEnvironmentSidecarEntry(userDataPath, removal.remaining, removal.persisted, null)
  return removal.environment
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
let environmentWriteGeneration = 0

export function bumpEnvironmentWriteGeneration(): void {
  environmentWriteGeneration += 1
}

export function getEnvironmentWriteGeneration(): number {
  return environmentWriteGeneration
}

/** `size:mtime` of the store file, so a publish by another lane or process voids a stale snapshot. */
function environmentStoreFileSignature(userDataPath: string): string {
  try {
    const stats = statSync(getEnvironmentStorePath(userDataPath))
    return `${stats.size}:${stats.mtimeMs}`
  } catch {
    return 'absent'
  }
}

/**
 * Call BEFORE reading the store. The returned check is true only while no async publish landed
 * (generation) and no other writer touched the file (signature) since — upstream's synchronous
 * writers do not bump the generation, so the file itself is the witness for them.
 */
export function captureEnvironmentStoreVersion(userDataPath: string): () => boolean {
  const generation = environmentWriteGeneration
  const signature = environmentStoreFileSignature(userDataPath)
  return () =>
    environmentWriteGeneration === generation &&
    environmentStoreFileSignature(userDataPath) === signature
}

const MAX_MUTATION_ATTEMPTS = 5

/** Read-modify-write on the async lane; `compute` runs on a fresh snapshot per attempt and may throw. */
async function mutateEnvironmentStore<TResult>(
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
          environmentWriteGeneration += 1
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

/**
 * Writes only persisted fields; sidecar state is written by the sidecar module. Records on disk
 * this build cannot read are appended verbatim, in their original order.
 */
export async function writeEnvironmentStoreAsync(
  userDataPath: string,
  store: RuntimeEnvironmentStore,
  options: { shouldPublish?: () => boolean } = {}
): Promise<void> {
  const path = getEnvironmentStorePath(userDataPath)
  const environments = RuntimeEnvironmentStoreSchema.parse(store).environments
  const onDisk = readEnvironmentStoreRecords(userDataPath)
  const readableIds = new Set(onDisk.environments.map((environment) => environment.id))
  const unreadableIds = new Set(onDisk.unreadable.map((record) => record.id))
  // A new readable record must not shadow one a newer build owns under the same id.
  if (environments.some(({ id }) => unreadableIds.has(id) && !readableIds.has(id))) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'A server with this id already exists in a format that needs a newer version of Orca.'
    )
  }
  try {
    await writeSecureJsonFileWithinLimitAsync(
      path,
      {
        version: 1,
        environments: [...environments, ...onDisk.unreadable.map((record) => record.raw)]
      },
      MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES,
      options
    )
  } catch (error) {
    if (error instanceof JsonStringifyByteLimitError) {
      throw new RuntimeEnvironmentStoreError(
        'runtime_error',
        `Could not write Orca environments at ${path}; the store exceeds its durable capacity.`
      )
    }
    throw error
  }
}
