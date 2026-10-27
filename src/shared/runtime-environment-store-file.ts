import {
  bumpEnvironmentWriteGeneration,
  captureEnvironmentStoreVersion,
  withRuntimeEnvironmentMutation
} from './runtime-environment-store-mutation'
import { randomUUID } from 'node:crypto'
import {
  JsonStringifyByteLimitError,
  stringifyJsonWithinByteLimit
} from './node-bounded-json-stringify'
import { readNodeFileWithinLimit } from './node-bounded-file-reader'
import { SecureWriteSupersededError, writeSecureFileAsync } from './secure-file-async-write'
import {
  RuntimeEnvironmentStoreSchema,
  type KnownRuntimeEnvironment,
  type RuntimeEnvironmentStore
} from './runtime-environments'
import {
  overlayRuntimeEnvironmentSidecar,
  readRuntimeEnvironmentSidecar,
  RuntimeEnvironmentSidecarInvalidError
} from './runtime-environment-sidecar'
import {
  getEnvironmentStorePath,
  MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES,
  readEnvironmentStoreRecords,
  RuntimeEnvironmentStoreError,
  type EnvironmentStoreRecordsReadOptions,
  warnUnreadableEnvironmentState
} from './runtime-environment-store-records'
import {
  overlayWslHostDeployments,
  readWslHostDeployments,
  WslHostDeploymentStoreInvalidError
} from './wsl-host-deployment-store'
import { isWslHostsInternalGateOpen } from './wsl-host-internal-gate'

export {
  getEnvironmentStorePath,
  MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES,
  RuntimeEnvironmentStoreError,
  type RuntimeEnvironmentStoreErrorCode
} from './runtime-environment-store-records'

/**
 * The orca-environments.json records this build can read. Unreadable ones (corrupt, or written by
 * a newer build) are left out here and carried through every write by writeEnvironmentStoreSnapshotAsync.
 */
export function readPersistedEnvironmentStore(
  userDataPath: string,
  options: EnvironmentStoreRecordsReadOptions = {}
): RuntimeEnvironmentStore {
  const { environments, unreadable } = readEnvironmentStoreRecords(userDataPath, options)
  if (unreadable.length > 0) {
    warnUnreadableEnvironmentState(
      `Skipping ${unreadable.length} unreadable server record(s) in ${getEnvironmentStorePath(userDataPath)} (ids: ${unreadable.map((record) => record.id ?? '<none>').join(', ')}); they may need a newer version of Orca and are kept on disk.`
    )
  }
  return {
    version: 1,
    environments: environments.sort((a, b) => a.name.localeCompare(b.name))
  }
}

/** Unreadable WSL state fails closed only when its internal gate is enabled; otherwise it cannot hide SSH/paired servers. */
function readWslHostDeploymentsForRegistry(
  userDataPath: string
): ReturnType<typeof readWslHostDeployments> {
  const gateOpen = isWslHostsInternalGateOpen(process.env)
  try {
    const read = readWslHostDeployments(userDataPath)
    return gateOpen ? read : { deployments: read.deployments, unreadableEnvironmentIds: new Set() }
  } catch (error) {
    if (!(error instanceof WslHostDeploymentStoreInvalidError) || gateOpen) {
      throw error
    }
    warnUnreadableEnvironmentState(error.message)
    return { deployments: [], unreadableEnvironmentIds: new Set() }
  }
}

export function readEnvironmentStore(
  userDataPath: string,
  options: EnvironmentStoreRecordsReadOptions = {}
): {
  version: 1
  environments: KnownRuntimeEnvironment[]
} {
  const store = readPersistedEnvironmentStore(userDataPath, options)
  let sidecar: ReturnType<typeof readRuntimeEnvironmentSidecar>
  let wslDeployments: ReturnType<typeof readWslHostDeployments>
  try {
    sidecar = readRuntimeEnvironmentSidecar(userDataPath)
    wslDeployments = readWslHostDeploymentsForRegistry(userDataPath)
  } catch (error) {
    // Fail closed like the main file: a link we cannot read may pin a host key we must not drop.
    if (
      error instanceof RuntimeEnvironmentSidecarInvalidError ||
      error instanceof WslHostDeploymentStoreInvalidError
    ) {
      throw new RuntimeEnvironmentStoreError('runtime_error', error.message)
    }
    throw error
  }
  // Hide unreadable overlays: connecting/editing without them could silently discard SSH pins or deployment ownership.
  const isHidden = (id: string): boolean => Object.hasOwn(sidecar.unreadable, id)
  const hidden = store.environments.filter((environment) => isHidden(environment.id))
  if (hidden.length > 0) {
    warnUnreadableEnvironmentState(
      `Hiding ${hidden.length} server(s) whose links cannot be read (ids: ${hidden.map((environment) => environment.id).join(', ')}); they may need a newer version of Orca.`
    )
  }
  return {
    version: 1,
    environments: overlayWslHostDeployments(
      store.environments
        .filter((environment) => !isHidden(environment.id))
        .map((environment) =>
          overlayRuntimeEnvironmentSidecar(environment, sidecar.entries[environment.id])
        ),
      wslDeployments
    )
  }
}

/**
 * Writes only persisted fields; sidecar state is written by the sidecar module. Records on disk
 * this build cannot read are appended verbatim, in their original order.
 */
export function writeEnvironmentStoreSnapshotAsync(
  userDataPath: string,
  store: RuntimeEnvironmentStore
): Promise<void> {
  return withRuntimeEnvironmentMutation(userDataPath, () =>
    writeEnvironmentStoreAsync(userDataPath, store)
  )
}

/** Publication inside a caller-owned transaction; the caller must compute from a current snapshot. */
export async function writeEnvironmentStoreAsync(
  userDataPath: string,
  store: RuntimeEnvironmentStore,
  options: { shouldPublish?: () => boolean } = {}
): Promise<void> {
  const isCurrent = captureEnvironmentStoreVersion(userDataPath)
  const path = getEnvironmentStorePath(userDataPath)
  const environments = RuntimeEnvironmentStoreSchema.parse(store).environments
  // The new registry replaces a blank file in one atomic write, so no reader sees it emptied early.
  const onDisk = readEnvironmentStoreRecords(userDataPath, { recoverBlankStore: true })
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
    const serialized = stringifyJsonWithinByteLimit(
      {
        version: 1,
        environments: [...environments, ...onDisk.unreadable.map((record) => record.raw)]
      },
      MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES
    ).serialized
    const canPublish = (): boolean => isCurrent() && options.shouldPublish?.() !== false
    if (onDisk.blankFile) {
      await backUpBlankEnvironmentStoreAsync(path, canPublish)
    }
    await writeSecureFileAsync(path, serialized, {
      durable: true,
      shouldPublish: () => {
        if (!canPublish()) {
          return false
        }
        bumpEnvironmentWriteGeneration()
        return true
      }
    })
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

async function backUpBlankEnvironmentStoreAsync(
  path: string,
  canPublish: () => boolean
): Promise<void> {
  const { buffer } = await readNodeFileWithinLimit(path, MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES)
  const contents = buffer.toString('utf8')
  if (!canPublish() || !/^[\s\0]*$/.test(contents)) {
    throw new SecureWriteSupersededError(path)
  }
  const backupPath = `${path}.corrupt-${Date.now()}-${process.pid}-${randomUUID()}`
  await writeSecureFileAsync(backupPath, contents, { durable: true, shouldPublish: canPublish })
  console.warn(`[runtime-environments] ${path} held no data; kept a copy at ${backupPath}.`)
}
