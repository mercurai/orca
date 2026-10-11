import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { JsonStringifyByteLimitError } from './node-bounded-json-stringify'
import { readNodeFileSyncWithinLimit } from './node-bounded-file-reader'
import { writeSecureJsonFileWithinLimitAsync } from './bounded-secure-json-file'
import { serializePathWrite } from './path-write-serializer'
import { hardenExistingSecureFile } from './secure-file'
import {
  featureEntryFromRuntime,
  featureIdentity,
  readEphemeralVmRuntimeFeatureStore,
  restoreRuntimeFeatureList,
  runtimeFeaturesEqual,
  writeEphemeralVmRuntimeFeatureStore,
  type EphemeralVmRuntimeFeatureStoreSnapshot
} from './ephemeral-vm-runtime-feature-store'
import {
  applyEphemeralVmRuntimeStatusUpdate,
  type EphemeralVmRuntimeStatusUpdate
} from './ephemeral-vm-runtime-status-update'
import {
  mergeRuntimeFeatures,
  projectRuntimeForRollback,
  runtimeFeatureListsEqual
} from './ephemeral-vm-runtime-rollback-projection'
import {
  EphemeralVmRuntimeRecordSchema,
  EphemeralVmRuntimeStoreSchema,
  RollbackEphemeralVmRuntimeStoreSchema,
  type EphemeralVmRuntimeRecord,
  type EphemeralVmRuntimeStore
} from './ephemeral-vm-runtimes'

const EPHEMERAL_VM_RUNTIMES_FILE = 'orca-ephemeral-vm-runtimes.json'
export const MAX_EPHEMERAL_VM_RUNTIME_STORE_FILE_BYTES = 1024 * 1024

export type EphemeralVmRuntimeStoreErrorCode = 'invalid_argument' | 'runtime_error'

export class EphemeralVmRuntimeStoreError extends Error {
  readonly code: EphemeralVmRuntimeStoreErrorCode

  constructor(code: EphemeralVmRuntimeStoreErrorCode, message: string) {
    super(message)
    this.name = 'EphemeralVmRuntimeStoreError'
    this.code = code
  }
}

export function getEphemeralVmRuntimeStorePath(userDataPath: string): string {
  return join(userDataPath, EPHEMERAL_VM_RUNTIMES_FILE)
}

export function listEphemeralVmRuntimes(userDataPath: string): EphemeralVmRuntimeRecord[] {
  return readEphemeralVmRuntimeStore(userDataPath).store.runtimes
}

/** Why: the lane only serializes the file write, so the read-modify-write spans one queue key. */
function serializeStoreMutation<T>(userDataPath: string, run: () => Promise<T>): Promise<T> {
  const key = `${getEphemeralVmRuntimeStorePath(userDataPath)}#read-modify-write`
  return serializePathWrite(key, run)
}

export async function upsertEphemeralVmRuntime(
  userDataPath: string,
  record: EphemeralVmRuntimeRecord
): Promise<EphemeralVmRuntimeRecord> {
  const parsed = EphemeralVmRuntimeRecordSchema.parse(record)
  return serializeStoreMutation(userDataPath, async () => {
    const loaded = readEphemeralVmRuntimeStore(userDataPath)
    const previous = loaded.store.runtimes.find((entry) => entry.id === parsed.id)
    if (
      previous &&
      featureIdentity(previous) === featureIdentity(parsed) &&
      !runtimeFeaturesEqual(previous, parsed)
    ) {
      throw new EphemeralVmRuntimeStoreError(
        'invalid_argument',
        `Cannot change compatibility features for ephemeral VM runtime: ${parsed.id}`
      )
    }
    await writeEphemeralVmRuntimeStore(
      userDataPath,
      {
        version: 1,
        runtimes: [
          ...loaded.store.runtimes.filter((entry) => entry.id !== parsed.id),
          parsed
        ].sort(compareRuntimeRecords)
      },
      loaded.features
    )
    return parsed
  })
}

export async function upsertEphemeralVmRuntimeRollbackRecovery(
  userDataPath: string,
  record: EphemeralVmRuntimeRecord
): Promise<void> {
  const parsed = EphemeralVmRuntimeRecordSchema.parse(record)
  await serializeStoreMutation(userDataPath, async () => {
    const loaded = readEphemeralVmRuntimeStore(userDataPath)
    const path = getEphemeralVmRuntimeStorePath(userDataPath)
    try {
      await writeSecureJsonFileWithinLimitAsync(
        path,
        RollbackEphemeralVmRuntimeStoreSchema.parse({
          version: 1,
          runtimes: [...loaded.store.runtimes.filter((entry) => entry.id !== parsed.id), parsed]
            .sort(compareRuntimeRecords)
            .map(projectRuntimeForRollback)
        }),
        MAX_EPHEMERAL_VM_RUNTIME_STORE_FILE_BYTES,
        { durable: true }
      )
    } catch (error) {
      if (error instanceof JsonStringifyByteLimitError) {
        throw new EphemeralVmRuntimeStoreError(
          'runtime_error',
          `Could not write Orca ephemeral VM runtimes at ${path}; the store exceeds its durable capacity.`
        )
      }
      throw error
    }
  })
}

export async function updateEphemeralVmRuntimeStatus(
  userDataPath: string,
  id: string,
  args: EphemeralVmRuntimeStatusUpdate
): Promise<EphemeralVmRuntimeRecord> {
  return serializeStoreMutation(userDataPath, async () => {
    const loaded = readEphemeralVmRuntimeStore(userDataPath)
    const existing = loaded.store.runtimes.find((entry) => entry.id === id)
    if (!existing) {
      throw new EphemeralVmRuntimeStoreError(
        'invalid_argument',
        `Unknown ephemeral VM runtime: ${id}`
      )
    }
    const next = applyEphemeralVmRuntimeStatusUpdate(existing, args)
    await writeEphemeralVmRuntimeStore(
      userDataPath,
      {
        version: 1,
        runtimes: loaded.store.runtimes
          .map((entry) => (entry.id === id ? next : entry))
          .sort(compareRuntimeRecords)
      },
      loaded.features
    )
    return next
  })
}

export async function removeEphemeralVmRuntime(
  userDataPath: string,
  id: string
): Promise<EphemeralVmRuntimeRecord> {
  return serializeStoreMutation(userDataPath, async () => {
    const loaded = readEphemeralVmRuntimeStore(userDataPath)
    const existing = loaded.store.runtimes.find((entry) => entry.id === id)
    if (!existing) {
      throw new EphemeralVmRuntimeStoreError(
        'invalid_argument',
        `Unknown ephemeral VM runtime: ${id}`
      )
    }
    await writeEphemeralVmRuntimeStore(
      userDataPath,
      {
        version: 1,
        runtimes: loaded.store.runtimes.filter((entry) => entry.id !== id)
      },
      loaded.features
    )
    return existing
  })
}

type LoadedEphemeralVmRuntimeStore = {
  store: EphemeralVmRuntimeStore
  features: EphemeralVmRuntimeFeatureStoreSnapshot
}

function readEphemeralVmRuntimeStore(userDataPath: string): LoadedEphemeralVmRuntimeStore {
  const path = getEphemeralVmRuntimeStorePath(userDataPath)
  if (!existsSync(path)) {
    return {
      store: { version: 1, runtimes: [] },
      features: readEphemeralVmRuntimeFeatureStore(userDataPath)
    }
  }
  try {
    hardenExistingSecureFile(path)
    const persisted = JSON.parse(
      readNodeFileSyncWithinLimit(path, MAX_EPHEMERAL_VM_RUNTIME_STORE_FILE_BYTES).buffer.toString(
        'utf8'
      )
    )
    const parsed = EphemeralVmRuntimeStoreSchema.parse(persisted)
    const features = readEphemeralVmRuntimeFeatureStore(userDataPath)
    const store: EphemeralVmRuntimeStore = {
      version: 1,
      runtimes: restoreRuntimeFeatureList(parsed.runtimes, features.features).sort(
        compareRuntimeRecords
      )
    }
    return { store, features }
  } catch {
    throw new EphemeralVmRuntimeStoreError(
      'runtime_error',
      `Could not read Orca ephemeral VM runtimes at ${path}; the file is invalid.`
    )
  }
}

async function writeEphemeralVmRuntimeStore(
  userDataPath: string,
  store: EphemeralVmRuntimeStore,
  features: EphemeralVmRuntimeFeatureStoreSnapshot
): Promise<void> {
  const path = getEphemeralVmRuntimeStorePath(userDataPath)
  try {
    const parsed = EphemeralVmRuntimeStoreSchema.parse(store)
    const requiredFeatures = mergeRuntimeFeatures(
      [],
      parsed.runtimes.flatMap((entry) => {
        const feature = featureEntryFromRuntime(entry)
        return feature ? [feature] : []
      })
    )
    const preparedFeatures = mergeRuntimeFeatures(features.features, requiredFeatures)
    await writeSecureJsonFileWithinLimitAsync(
      path,
      RollbackEphemeralVmRuntimeStoreSchema.parse({
        version: 1,
        runtimes: parsed.runtimes.map(projectRuntimeForRollback)
      }),
      MAX_EPHEMERAL_VM_RUNTIME_STORE_FILE_BYTES,
      { durable: preparedFeatures.length > 0 || features.features.length > 0 }
    )
    if (!features.writable && requiredFeatures.length > 0) {
      throw new EphemeralVmRuntimeStoreError(
        'runtime_error',
        'Could not preserve ephemeral VM runtime compatibility metadata.'
      )
    }
    if (features.writable && !runtimeFeatureListsEqual(features.features, preparedFeatures)) {
      await writeEphemeralVmRuntimeFeatureStore(userDataPath, features, preparedFeatures)
    }
    if (features.writable && !runtimeFeatureListsEqual(preparedFeatures, requiredFeatures)) {
      try {
        await writeEphemeralVmRuntimeFeatureStore(userDataPath, features, requiredFeatures)
      } catch {
        // Stale feature records do not match any persisted runtime identity.
      }
    }
  } catch (error) {
    if (error instanceof JsonStringifyByteLimitError) {
      throw new EphemeralVmRuntimeStoreError(
        'runtime_error',
        `Could not write Orca ephemeral VM runtimes at ${path}; the store exceeds its durable capacity.`
      )
    }
    throw error
  }
}

function compareRuntimeRecords(a: EphemeralVmRuntimeRecord, b: EphemeralVmRuntimeRecord): number {
  return b.createdAt - a.createdAt || a.id.localeCompare(b.id)
}
