import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { JsonStringifyByteLimitError } from './node-bounded-json-stringify'
import { readNodeFileSyncWithinLimit } from './node-bounded-file-reader'
import { parsePairingCode, type PairingOffer } from './pairing'
import { classifyRemotePairingHostname } from './remote-pairing-address'
import {
  writeSecureJsonFileWithinLimit,
  writeSecureJsonFileWithinLimitAsync
} from './bounded-secure-json-file'
import { hardenExistingSecureFile } from './secure-file'
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

export function addEnvironmentFromPairingCode(
  userDataPath: string,
  args: {
    name: string
    pairingCode: string
    now?: number
    source?: RuntimeEnvironmentSource
    connectionDependency?: 'ssh-tunnel'
  }
): KnownRuntimeEnvironment {
  const offer = parsePairingCode(args.pairingCode)
  if (!offer) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'Invalid pairing code. Expected an orca://pair?... URL or bare pairing payload.'
    )
  }
  const store = readEnvironmentStore(userDataPath)
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
  writeEnvironmentStore(userDataPath, next)
  return environment
}

export function removeEnvironment(userDataPath: string, selector: string): KnownRuntimeEnvironment {
  const store = readEnvironmentStore(userDataPath)
  const environment = resolveEnvironmentFromStore(store, selector)
  writeEnvironmentStore(userDataPath, {
    version: 1,
    environments: store.environments.filter((entry) => entry.id !== environment.id)
  })
  return environment
}

export function updateEnvironmentFromPairingCode(
  userDataPath: string,
  selector: string,
  args: { pairingCode: string; now?: number }
): KnownRuntimeEnvironment {
  const offer = parsePairingCode(args.pairingCode)
  if (!offer) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'Invalid pairing code. Expected an orca://pair?... URL or bare pairing payload.'
    )
  }
  const store = readEnvironmentStore(userDataPath)
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
  writeEnvironmentStore(userDataPath, {
    version: 1,
    environments: store.environments
      .map((entry) => (entry.id === existing.id ? next : entry))
      .sort((a, b) => a.name.localeCompare(b.name))
  })
  return next
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

export function writeEnvironmentStore(userDataPath: string, store: RuntimeEnvironmentStore): void {
  const path = getEnvironmentStorePath(userDataPath)
  try {
    const parsed = RuntimeEnvironmentStoreSchema.parse(store)
    writeSecureJsonFileWithinLimit(path, parsed, MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES)
  } catch (error) {
    throw translateStoreWriteError(path, error)
  }
}

export async function writeEnvironmentStoreAsync(
  userDataPath: string,
  store: RuntimeEnvironmentStore
): Promise<void> {
  const path = getEnvironmentStorePath(userDataPath)
  try {
    const parsed = RuntimeEnvironmentStoreSchema.parse(store)
    await writeSecureJsonFileWithinLimitAsync(
      path,
      parsed,
      MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES
    )
  } catch (error) {
    throw translateStoreWriteError(path, error)
  }
}
