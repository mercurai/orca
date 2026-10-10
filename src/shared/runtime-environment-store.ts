import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { JsonStringifyByteLimitError } from './node-bounded-json-stringify'
import { readNodeFileSyncWithinLimit } from './node-bounded-file-reader'
import { parsePairingCode, type PairingOffer } from './pairing'
import { classifyRemotePairingHostname } from './remote-pairing-address'
import { writeSecureJsonFileWithinLimitAsync } from './bounded-secure-json-file'
import { hardenExistingSecureFile } from './secure-file'
import { SecureWriteSupersededError } from './secure-file-async-write'
import {
  createEnvironmentFromPairingOffer,
  getPreferredPairingOffer,
  KnownRuntimeEnvironmentSchema,
  RuntimeEnvironmentStoreSchema,
  type KnownRuntimeEnvironment,
  type RuntimeEnvironmentSource,
  type RuntimeEnvironmentStore
} from './runtime-environments'

const ENVIRONMENTS_FILE = 'orca-environments.json'
export const MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES = 1024 * 1024

export type RuntimeEnvironmentStoreErrorCode = 'invalid_argument' | 'runtime_error'

export class RuntimeEnvironmentStoreError extends Error {
  readonly code: RuntimeEnvironmentStoreErrorCode

  constructor(code: RuntimeEnvironmentStoreErrorCode, message: string) {
    super(message)
    this.name = 'RuntimeEnvironmentStoreError'
    this.code = code
  }
}

export function getEnvironmentStorePath(userDataPath: string): string {
  return join(userDataPath, ENVIRONMENTS_FILE)
}

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

export async function removeEnvironment(
  userDataPath: string,
  selector: string
): Promise<KnownRuntimeEnvironment> {
  return await mutateEnvironmentStore(userDataPath, (store) => {
    const environment = resolveEnvironmentFromStore(store, selector)
    const environments = store.environments.filter((entry) => entry.id !== environment.id)
    return { store: { version: 1, environments }, result: environment }
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
  return await mutateEnvironmentStore(userDataPath, (store) => {
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

export function resolveEnvironmentFromStore(
  store: RuntimeEnvironmentStore,
  selector: string
): KnownRuntimeEnvironment {
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

export function readEnvironmentStore(
  userDataPath: string,
  options: { requireStoreFile?: boolean } = {}
): RuntimeEnvironmentStore {
  const path = getEnvironmentStorePath(userDataPath)
  if (!options.requireStoreFile && !existsSync(path)) {
    return { version: 1, environments: [] }
  }
  try {
    hardenExistingSecureFile(path)
    const parsed = RuntimeEnvironmentStoreSchema.parse(
      JSON.parse(
        readNodeFileSyncWithinLimit(path, MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES).buffer.toString(
          'utf8'
        )
      )
    )
    return {
      version: 1,
      environments: parsed.environments
        .map((entry) => KnownRuntimeEnvironmentSchema.parse(entry))
        .sort((a, b) => a.name.localeCompare(b.name))
    }
  } catch {
    throw new RuntimeEnvironmentStoreError(
      'runtime_error',
      `Could not read Orca environments at ${path}; the file is invalid.`
    )
  }
}

function translateStoreWriteError(path: string, error: unknown): unknown {
  return error instanceof JsonStringifyByteLimitError
    ? new RuntimeEnvironmentStoreError(
        'runtime_error',
        `Could not write Orca environments at ${path}; the store exceeds its durable capacity.`
      )
    : error
}

// Bumped by every publish: a read-modify-write compares it before publishing and re-reads when stale.
let environmentWriteGeneration = 0

export function bumpEnvironmentWriteGeneration(): void {
  environmentWriteGeneration += 1
}

export function getEnvironmentWriteGeneration(): number {
  return environmentWriteGeneration
}

const MAX_MUTATION_ATTEMPTS = 5

/** Read-modify-write on the async lane; `compute` runs on a fresh snapshot per attempt and may throw. */
async function mutateEnvironmentStore<TResult>(
  userDataPath: string,
  compute: (store: RuntimeEnvironmentStore) => { store: RuntimeEnvironmentStore; result: TResult }
): Promise<TResult> {
  for (let attempt = 1; ; attempt += 1) {
    const generation = environmentWriteGeneration
    const { store, result } = compute(readEnvironmentStore(userDataPath))
    try {
      await writeEnvironmentStoreAsync(userDataPath, store, {
        // A publish landing since our read (pairing edit, usage stamp) voids the snapshot.
        shouldPublish: () => {
          if (environmentWriteGeneration !== generation) {
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

export async function writeEnvironmentStoreAsync(
  userDataPath: string,
  store: RuntimeEnvironmentStore,
  options: { shouldPublish?: () => boolean } = {}
): Promise<void> {
  const path = getEnvironmentStorePath(userDataPath)
  try {
    const parsed = RuntimeEnvironmentStoreSchema.parse(store)
    await writeSecureJsonFileWithinLimitAsync(
      path,
      parsed,
      MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES,
      options
    )
  } catch (error) {
    throw translateStoreWriteError(path, error)
  }
}
