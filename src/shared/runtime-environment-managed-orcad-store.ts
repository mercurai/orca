import {
  captureEnvironmentStoreVersion,
  withRuntimeEnvironmentMutation
} from './runtime-environment-store-mutation'
import { parsePairingCode, type PairingOffer } from './pairing'
import {
  createEnvironmentFromPairingOffer,
  getPreferredLoopbackRuntimePort,
  getOrcadSshDeployment,
  getPreferredPairingOffer,
  PersistedRuntimeEnvironmentSchema,
  type KnownRuntimeEnvironment,
  type OrcadSshDeploymentLink
} from './runtime-environments'
import {
  readEnvironmentStore,
  readPersistedEnvironmentStore,
  RuntimeEnvironmentStoreError,
  writeEnvironmentStoreAsync
} from './runtime-environment-store-file'
import {
  readCurrentRuntimeEnvironmentSidecarEntry,
  writeRuntimeEnvironmentSidecarEntryWithinMutation
} from './runtime-environment-sidecar'
import { resolveEnvironmentFromStore } from './runtime-environment-store'
import { findCollidingEnvironmentName } from './runtime-environment-name-collision'

/** Registers a server Orca deployed over SSH, paired through its own loopback tunnel. */
export function addManagedOrcadEnvironment(
  ...args: Parameters<typeof addManagedOrcadEnvironmentWithinMutation>
): ReturnType<typeof addManagedOrcadEnvironmentWithinMutation> {
  return withRuntimeEnvironmentMutation(args[0], () =>
    addManagedOrcadEnvironmentWithinMutation(...args)
  )
}

async function addManagedOrcadEnvironmentWithinMutation(
  userDataPath: string,
  args: {
    id: string
    name: string
    pairingCode: string
    orcadDeployment: OrcadSshDeploymentLink
    now?: number
  }
): Promise<KnownRuntimeEnvironment> {
  const isCurrent = captureEnvironmentStoreVersion(userDataPath)
  const offer = parsePairingCode(args.pairingCode)
  if (!offer) {
    throw new RuntimeEnvironmentStoreError('invalid_argument', 'Invalid managed pairing code.')
  }
  const known = readEnvironmentStore(userDataPath, { recoverBlankStore: true }).environments
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
  const environment = createEnvironmentFromPairingOffer({
    id: args.id,
    name: args.name,
    now: args.now ?? Date.now(),
    offer,
    runtimeId: null,
    connectionDependency: 'ssh-tunnel'
  })
  if (getPreferredLoopbackRuntimePort(environment) !== args.orcadDeployment.localPort) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'The managed pairing does not point at its SSH tunnel.'
    )
  }
  const persisted = PersistedRuntimeEnvironmentSchema.parse(environment)
  const environments = [
    ...readPersistedEnvironmentStore(userDataPath, { recoverBlankStore: true }).environments,
    persisted
  ].sort((a, b) => a.name.localeCompare(b.name))
  // Sidecar first: a crash between the writes leaves an ownerless entry the next write prunes,
  // never a registered server that has lost its deployment link.
  await writeRuntimeEnvironmentSidecarEntryWithinMutation(userDataPath, environments, persisted, {
    orcadDeployment: args.orcadDeployment
  })
  await writeEnvironmentStoreAsync(
    userDataPath,
    { version: 1, environments },
    { shouldPublish: isCurrent }
  )
  const registered = readEnvironmentStore(userDataPath).environments.find(
    (entry) => entry.id === args.id
  )
  if (!registered?.orcadDeployment) {
    throw new RuntimeEnvironmentStoreError(
      'runtime_error',
      'This host’s Orca server was saved without its deployment link.'
    )
  }
  return registered
}

/**
 * Unlinks a managed server once its orcad is proven to have exited: drops the persisted entry
 * and the sidecar record that held its deployment link.
 */
export function removeManagedOrcadEnvironment(
  ...args: Parameters<typeof removeManagedOrcadEnvironmentWithinMutation>
): ReturnType<typeof removeManagedOrcadEnvironmentWithinMutation> {
  return withRuntimeEnvironmentMutation(args[0], () =>
    removeManagedOrcadEnvironmentWithinMutation(...args)
  )
}

async function removeManagedOrcadEnvironmentWithinMutation(
  userDataPath: string,
  environmentId: string
): Promise<void> {
  const isCurrent = captureEnvironmentStoreVersion(userDataPath)
  const store = readPersistedEnvironmentStore(userDataPath)
  const persisted = resolveEnvironmentFromStore(store, environmentId)
  // Throws before the store write when the entry is unreadable, so its link is never orphaned.
  readCurrentRuntimeEnvironmentSidecarEntry(userDataPath, persisted)
  const remaining = store.environments.filter((entry) => entry.id !== persisted.id)
  await writeEnvironmentStoreAsync(
    userDataPath,
    { version: 1, environments: remaining },
    { shouldPublish: isCurrent }
  )
  await writeRuntimeEnvironmentSidecarEntryWithinMutation(userDataPath, remaining, persisted, null)
}

/** Keeps a managed server's pairing current after its orcad changed versions. */
export function refreshManagedOrcadPairing(
  ...args: Parameters<typeof refreshManagedOrcadPairingWithinMutation>
): ReturnType<typeof refreshManagedOrcadPairingWithinMutation> {
  return withRuntimeEnvironmentMutation(args[0], () =>
    refreshManagedOrcadPairingWithinMutation(...args)
  )
}

async function refreshManagedOrcadPairingWithinMutation(
  userDataPath: string,
  environmentId: string,
  pairingCode: string,
  now = Date.now(),
  options: { expectedPairingRevision?: number } = {}
): Promise<KnownRuntimeEnvironment> {
  const offer = parsePairingCode(pairingCode)
  if (!offer) {
    throw new RuntimeEnvironmentStoreError('invalid_argument', 'Invalid managed pairing code.')
  }
  return rebindManagedOrcadPairing(userDataPath, environmentId, () => offer, null, now, options)
}

/** Moves a managed server's tunnel to a new local port, keeping its pairing and identity. */
export function moveManagedOrcadLocalPort(
  ...args: Parameters<typeof moveManagedOrcadLocalPortWithinMutation>
): ReturnType<typeof moveManagedOrcadLocalPortWithinMutation> {
  return withRuntimeEnvironmentMutation(args[0], () =>
    moveManagedOrcadLocalPortWithinMutation(...args)
  )
}

async function moveManagedOrcadLocalPortWithinMutation(
  userDataPath: string,
  environmentId: string,
  localPort: number,
  now = Date.now()
): Promise<KnownRuntimeEnvironment> {
  return rebindManagedOrcadPairing(
    userDataPath,
    environmentId,
    (current) => {
      const offer = getPreferredPairingOffer(current)
      const endpoint = new URL(offer.endpoint)
      endpoint.port = String(localPort)
      return { ...offer, endpoint: endpoint.toString() }
    },
    localPort,
    now
  )
}

async function rebindManagedOrcadPairing(
  userDataPath: string,
  environmentId: string,
  nextOffer: (current: KnownRuntimeEnvironment) => PairingOffer,
  localPort: number | null,
  now: number,
  options: { expectedPairingRevision?: number } = {}
): Promise<KnownRuntimeEnvironment> {
  const isCurrent = captureEnvironmentStoreVersion(userDataPath)
  const current = resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), environmentId)
  // The profile lane may have queued behind a newer update after repair read SSH.
  // A refused revision is authority to replace only that revision, never its successor.
  if (
    options.expectedPairingRevision !== undefined &&
    (current.pairingRevision ?? current.createdAt) !== options.expectedPairingRevision
  ) {
    return current
  }
  if (!current.orcadDeployment) {
    throw new RuntimeEnvironmentStoreError('invalid_argument', 'This server is not managed.')
  }
  const deployment = getOrcadSshDeployment(current)
  if (!deployment) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'This server is not managed over SSH.'
    )
  }
  const offer = nextOffer(current)
  const nextDeployment = { ...deployment, localPort: localPort ?? deployment.localPort }
  // Unchanged enrolled offers need no rewrite; each rewrite rebinds the sidecar.
  if (samePairing(getPreferredPairingOffer(current), offer)) {
    return current
  }
  const store = readPersistedEnvironmentStore(userDataPath)
  const existing = resolveEnvironmentFromStore(store, environmentId)
  const entry = readCurrentRuntimeEnvironmentSidecarEntry(userDataPath, existing)
  const next = PersistedRuntimeEnvironmentSchema.parse({
    ...createEnvironmentFromPairingOffer({
      id: existing.id,
      name: existing.name,
      now: existing.createdAt,
      offer,
      runtimeId: existing.runtimeId,
      connectionDependency: 'ssh-tunnel'
    }),
    updatedAt: now,
    pairingRevision: Math.max(now, (existing.pairingRevision ?? existing.createdAt) + 1),
    lastUsedAt: existing.lastUsedAt
  })
  if (getPreferredLoopbackRuntimePort(next) !== nextDeployment.localPort) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'The managed pairing does not point at its SSH tunnel.'
    )
  }
  const environments = store.environments.map((candidate) =>
    candidate.id === existing.id ? next : candidate
  )
  const { binding: _binding, ...rest } = entry ?? {}
  // Why three writes: the entry stays current for both store states, so a failed or interrupted
  // store write can never strand the deployment link.
  await writeRuntimeEnvironmentSidecarEntryWithinMutation(
    userDataPath,
    store.environments,
    existing,
    { ...rest, orcadDeployment: deployment },
    next
  )
  await writeEnvironmentStoreAsync(
    userDataPath,
    { version: 1, environments },
    { shouldPublish: isCurrent }
  )
  await writeRuntimeEnvironmentSidecarEntryWithinMutation(userDataPath, environments, next, {
    ...rest,
    orcadDeployment: nextDeployment
  })
  return resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), environmentId)
}

function samePairing(left: PairingOffer, right: PairingOffer): boolean {
  return (
    left.endpoint === right.endpoint &&
    left.deviceToken === right.deviceToken &&
    left.publicKeyB64 === right.publicKeyB64 &&
    left.pairedDeviceId === right.pairedDeviceId
  )
}

/** Mark migration before attempting commit so a crash cannot leave rollback to a premigration snapshot enabled. */
export function recordManagedOrcadMigration(
  ...args: Parameters<typeof recordManagedOrcadMigrationWithinMutation>
): ReturnType<typeof recordManagedOrcadMigrationWithinMutation> {
  return withRuntimeEnvironmentMutation(args[0], () =>
    recordManagedOrcadMigrationWithinMutation(...args)
  )
}

async function recordManagedOrcadMigrationWithinMutation(
  userDataPath: string,
  environmentId: string,
  at: string
): Promise<KnownRuntimeEnvironment> {
  const store = readPersistedEnvironmentStore(userDataPath)
  const persisted = resolveEnvironmentFromStore(store, environmentId)
  const entry = readCurrentRuntimeEnvironmentSidecarEntry(userDataPath, persisted)
  if (!entry?.orcadDeployment) {
    throw new RuntimeEnvironmentStoreError('invalid_argument', 'This server is not managed.')
  }
  const { binding: _binding, ...state } = entry
  // Keep the latest migration mark, including delta moves, so older snapshots remain blocked.
  const latest =
    state.orcadMigratedAt && Date.parse(state.orcadMigratedAt) >= Date.parse(at)
      ? state.orcadMigratedAt
      : at
  await writeRuntimeEnvironmentSidecarEntryWithinMutation(
    userDataPath,
    store.environments,
    persisted,
    {
      ...state,
      orcadMigratedAt: latest
    }
  )
  return resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), environmentId)
}
