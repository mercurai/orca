import { SecureWriteSupersededError } from './secure-file-async-write'
import { captureEnvironmentStoreVersion, withRuntimeEnvironmentMutation } from './runtime-environment-store-mutation'
/**
 * The runtime environment behind a WSL host (C7): a plain paired environment whose pairing points
 * at the desktop end of the `wsl.exe` stdio bridge, plus its record in the WSL deployment store.
 */
import { parsePairingCode, type PairingOffer } from './pairing'
import {
  createEnvironmentFromPairingOffer,
  getPreferredLoopbackRuntimePort,
  getPreferredPairingOffer,
  PersistedRuntimeEnvironmentSchema,
  type KnownRuntimeEnvironment
} from './runtime-environments'
import {
  readEnvironmentStore,
  readPersistedEnvironmentStore,
  RuntimeEnvironmentStoreError,
  writeEnvironmentStoreAsync
} from './runtime-environment-store-file'
import { resolveEnvironmentFromStore } from './runtime-environment-store'
import { findCollidingEnvironmentName } from './runtime-environment-name-collision'
import {
  readWslHostDeployments,
  getWslHostDeploymentStorePath,
  WslHostDeploymentStoreInvalidError,
  writeWslHostDeploymentWithinMutation,
  type WslHostDeploymentRecord
} from './wsl-host-deployment-store'

type WslHostPorts = Pick<WslHostDeploymentRecord, 'localPort' | 'remotePort'>

function parseBridgedPairing(pairingCode: string): PairingOffer {
  const offer = parsePairingCode(pairingCode)
  if (!offer) {
    throw new RuntimeEnvironmentStoreError('invalid_argument', 'Invalid WSL host pairing code.')
  }
  return offer
}

function assertPairingUsesBridge(environment: KnownRuntimeEnvironment, localPort: number): void {
  if (getPreferredLoopbackRuntimePort(environment) !== localPort) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'The WSL host pairing does not point at its bridge.'
    )
  }
}

export function findWslHostDeployment(
  userDataPath: string,
  environmentId: string
): WslHostDeploymentRecord | null {
  return (
    readWslHostDeployments(userDataPath).deployments.find(
      (record) => record.environmentId === environmentId
    ) ?? null
  )
}

/** Registers a WSL host. Record first: a crash between the writes leaves an ownerless record. */
export function addWslHostEnvironment(
  ...args: Parameters<typeof addWslHostEnvironmentWithinMutation>
): ReturnType<typeof addWslHostEnvironmentWithinMutation> {
  return withRuntimeEnvironmentMutation(args[0], () => addWslHostEnvironmentWithinMutation(...args))
}

async function addWslHostEnvironmentWithinMutation(
  userDataPath: string,
  args: {
    id: string
    name: string
    pairingCode: string
    record: Omit<WslHostDeploymentRecord, 'environmentId' | 'createdAt'>
    now?: number
    shouldPublish?: () => boolean
  }
): Promise<KnownRuntimeEnvironment> {
  const snapshotIsCurrent = captureEnvironmentStoreVersion(userDataPath)
  const canPublish = (): boolean => snapshotIsCurrent() && args.shouldPublish?.() !== false
  if (!canPublish()) {
    throw new SecureWriteSupersededError('WSL environment mutation')
  }
  const offer = parseBridgedPairing(args.pairingCode)
  const known = readEnvironmentStore(userDataPath).environments
  if (known.some((entry) => entry.id === args.id)) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      `A server with id "${args.id}" already exists.`
    )
  }
  const namesake = findCollidingEnvironmentName(known, args.name)
  if (namesake) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      `A server named "${namesake.name}" already exists.`
    )
  }
  const now = args.now ?? Date.now()
  // No connectionDependency: the overlay treats SSH-dependent environments as conflicting.
  const environment = createEnvironmentFromPairingOffer({
    id: args.id,
    name: args.name,
    now,
    offer,
    runtimeId: null
  })
  assertPairingUsesBridge(environment, args.record.localPort)
  await writeWslHostDeploymentWithinMutation(userDataPath, args.id, {
    ...args.record,
    environmentId: args.id,
    createdAt: now
  }, canPublish)
  const persisted = PersistedRuntimeEnvironmentSchema.parse(environment)
  await writeEnvironmentStoreAsync(userDataPath, {
    version: 1,
    environments: [...readPersistedEnvironmentStore(userDataPath).environments, persisted].sort(
      (a, b) => a.name.localeCompare(b.name)
    )
  }, { shouldPublish: canPublish })
  return resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), args.id)
}

/**
 * Saves an explicit re-pair or moved bridge. Server restarts retain the paired client grant.
 * Returns whether the pairing changed, so callers retire stale transports.
 */
export function refreshWslHostPairing(
  ...args: Parameters<typeof refreshWslHostPairingWithinMutation>
): ReturnType<typeof refreshWslHostPairingWithinMutation> {
  return withRuntimeEnvironmentMutation(args[0], () => refreshWslHostPairingWithinMutation(...args))
}

async function refreshWslHostPairingWithinMutation(
  userDataPath: string,
  environmentId: string,
  args: { pairingCode: string; shouldPublish?: () => boolean } & WslHostPorts,
  now = Date.now()
): Promise<{ environment: KnownRuntimeEnvironment; pairingChanged: boolean }> {
  const snapshotIsCurrent = captureEnvironmentStoreVersion(userDataPath)
  const canPublish = (): boolean => snapshotIsCurrent() && args.shouldPublish?.() !== false
  if (!canPublish()) {
    throw new SecureWriteSupersededError('WSL environment mutation')
  }
  const offer = parseBridgedPairing(args.pairingCode)
  const record = findWslHostDeployment(userDataPath, environmentId)
  if (!record) {
    throw new RuntimeEnvironmentStoreError('invalid_argument', 'This server is not a WSL host.')
  }
  const store = readPersistedEnvironmentStore(userDataPath)
  const existing = resolveEnvironmentFromStore(store, environmentId)
  const changedPorts = record.localPort !== args.localPort || record.remotePort !== args.remotePort
  const nextRecord = { ...record, localPort: args.localPort, remotePort: args.remotePort }
  const current = resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), environmentId)
  const pairingChanged = !samePairing(getPreferredPairingOffer(current), offer)
  const next = PersistedRuntimeEnvironmentSchema.parse({
    ...createEnvironmentFromPairingOffer({
      id: existing.id,
      name: existing.name,
      now: existing.createdAt,
      offer,
      runtimeId: existing.runtimeId
    }),
    updatedAt: now,
    pairingRevision: Math.max(now, (existing.pairingRevision ?? existing.createdAt) + 1),
    lastUsedAt: existing.lastUsedAt
  })
  assertPairingUsesBridge(next, args.localPort)
  try {
    if (changedPorts) {
      await writeWslHostDeploymentWithinMutation(userDataPath, environmentId, nextRecord, canPublish)
    }
    if (!pairingChanged) {
      return { environment: resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), environmentId), pairingChanged: false }
    }
    await writeEnvironmentStoreAsync(userDataPath, {
      version: 1,
      environments: store.environments.map((candidate) => candidate.id === existing.id ? next : candidate)
    }, { shouldPublish: canPublish })
  } catch (error) {
    const currentRecord = findWslHostDeployment(userDataPath, environmentId)
    const currentEnvironment = readPersistedEnvironmentStore(userDataPath).environments
      .find((candidate) => candidate.id === environmentId)
    // Restore only this transaction's first publication; a newer owner always wins.
    if (changedPorts && JSON.stringify(currentRecord) === JSON.stringify(nextRecord) &&
        JSON.stringify(currentEnvironment) === JSON.stringify(existing)) {
      try {
        await writeWslHostDeploymentWithinMutation(userDataPath, environmentId, record)
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'WSL pairing refresh and deployment rollback failed')
      }
    }
    throw error
  }
  return {
    environment: resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), environmentId),
    pairingChanged: true
  }
}

/** Environment first: a crash between the writes leaves an ownerless record, never a bare server. */
export function removeWslHostEnvironment(
  ...args: Parameters<typeof removeWslHostEnvironmentWithinMutation>
): ReturnType<typeof removeWslHostEnvironmentWithinMutation> {
  return withRuntimeEnvironmentMutation(args[0], () => removeWslHostEnvironmentWithinMutation(...args))
}

async function removeWslHostEnvironmentWithinMutation(
  userDataPath: string, environmentId: string, expectedCreatedAt?: number
): Promise<void> {
  if (expectedCreatedAt !== undefined &&
      findWslHostDeployment(userDataPath, environmentId)?.createdAt !== expectedCreatedAt) {
    return
  }
  if (readWslHostDeployments(userDataPath).unreadableEnvironmentIds.has(environmentId)) {
    throw new WslHostDeploymentStoreInvalidError(getWslHostDeploymentStorePath(userDataPath), environmentId)
  }
  const store = readPersistedEnvironmentStore(userDataPath)
  if (store.environments.some((entry) => entry.id === environmentId)) {
    await writeEnvironmentStoreAsync(userDataPath, {
      version: 1,
      environments: store.environments.filter((entry) => entry.id !== environmentId)
    })
  }
  await writeWslHostDeploymentWithinMutation(userDataPath, environmentId, null)
}

function samePairing(left: PairingOffer, right: PairingOffer): boolean {
  return (
    left.endpoint === right.endpoint &&
    left.deviceToken === right.deviceToken &&
    left.publicKeyB64 === right.publicKeyB64 &&
    left.pairedDeviceId === right.pairedDeviceId
  )
}
