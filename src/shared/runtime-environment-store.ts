import { randomUUID } from 'node:crypto'
import { parsePairingCode, type PairingOffer } from './pairing'
import { classifyRemotePairingHostname } from './remote-pairing-address'
import { isProfileRuntimePublicKey } from './runtime-e2ee-keypair-file'
import {
  createEnvironmentFromPairingOffer,
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment,
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
import { findCollidingEnvironmentName } from './runtime-environment-name-collision'
import { resolveEnvironmentFromStore } from './runtime-environment-store-records'
export { resolveEnvironmentFromStore } from './runtime-environment-store-records'
import {
  findEnvironmentWithHostKey,
  savedHostKeySpelling
} from './runtime-environment-host-key-match'
import {
  assertNoIndependentSshAccess,
  assertPairingReplaceableByAdd
} from './runtime-environment-pairing-replace-guards'

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

export type AddEnvironmentArgs = {
  name: string
  pairingCode: string
  now?: number
  source?: RuntimeEnvironmentSource
  connectionDependency?: 'ssh-tunnel'
  /** Recorded only when the code turns out to be for an already saved server. */
  runtimeId?: string
}

export type AddEnvironmentOutcome = {
  environment: KnownRuntimeEnvironment
  /** The code was for a saved server, whose pairing it replaced instead of adding a second entry. */
  updatedExisting: boolean
}

/**
 * Saves a pairing, refusing one for a server already saved. Why never a second entry: two entries
 * for one server publish the same workspaces, which makes every write to them ambiguous.
 */
export async function addEnvironmentFromPairingCode(
  userDataPath: string,
  args: AddEnvironmentArgs
): Promise<KnownRuntimeEnvironment> {
  return (await saveEnvironmentFromPairingCode(userDataPath, args, false)).environment
}

/**
 * Saves a pairing, or refreshes the saved server it is for. Only for callers that then retire the
 * running app's connections to that server, which still authenticate with the replaced pairing.
 */
export async function addOrUpdateEnvironmentFromPairingCode(
  userDataPath: string,
  args: AddEnvironmentArgs
): Promise<AddEnvironmentOutcome> {
  return saveEnvironmentFromPairingCode(userDataPath, args, true)
}

async function saveEnvironmentFromPairingCode(
  userDataPath: string,
  args: AddEnvironmentArgs,
  refreshSameServer: boolean
): Promise<AddEnvironmentOutcome> {
  const offer = parseRemotePairingCode(userDataPath, args.pairingCode)
  const now = args.now ?? Date.now()
  return mutateEnvironmentStore<AddEnvironmentOutcome>(userDataPath, (store) => {
    const samePersisted = findEnvironmentWithHostKey(store.environments, offer.publicKeyB64)
    // Why the overlaid entry: SSH access or a deployment lives only there, and the guard reads it.
    const samePaired =
      samePersisted &&
      readEnvironmentStore(userDataPath).environments.find((entry) => entry.id === samePersisted.id)
    if (samePersisted && !samePaired) {
      throw new RuntimeEnvironmentStoreError(
        'invalid_argument',
        `This server is already paired as "${samePersisted.name}", whose saved settings this version of Orca cannot read.`
      )
    }
    if (samePaired) {
      assertPairingReplaceableByAdd(samePaired, args.source, refreshSameServer)
      const sameSpelling = { ...offer, publicKeyB64: savedHostKeySpelling(samePaired, offer) }
      const environment = replaceEnvironmentPairingInStore(store, samePaired.id, sameSpelling, {
        now,
        runtimeId: args.runtimeId,
        connectionDependency: args.connectionDependency
      })
      return {
        store: withReplacedEnvironment(store, environment),
        result: { environment, updatedExisting: true }
      }
    }
    const existing = findCollidingEnvironmentName(store.environments, args.name)
    if (existing) {
      throw new RuntimeEnvironmentStoreError(
        'invalid_argument',
        `A server named "${existing.name}" already exists.`
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
    return { store: next, result: { environment, updatedExisting: false } }
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
    await writeRuntimeEnvironmentSidecarEntryWithinMutation(
      userDataPath,
      removal.remaining,
      removal.persisted,
      null
    )
    return removal.environment
  })
}

export async function updateEnvironmentFromPairingCode(
  userDataPath: string,
  selector: string,
  args: { pairingCode: string; now?: number; runtimeId?: string }
): Promise<KnownRuntimeEnvironment> {
  const offer = parseRemotePairingCode(userDataPath, args.pairingCode)
  return mutateEnvironmentStore(userDataPath, (store) => {
    const current = resolveEnvironmentFromStore(readEnvironmentStore(userDataPath), selector)
    assertNoIndependentSshAccess(current)
    const next = replaceEnvironmentPairingInStore(store, current.id, offer, {
      now: args.now ?? Date.now(),
      runtimeId: args.runtimeId,
      connectionDependency: current.connectionDependency
    })
    return { store: withReplacedEnvironment(store, next), result: next }
  })
}

/** Computes a replacement under the profile mutation lane, without nesting that lane. */
function replaceEnvironmentPairingInStore(
  store: RuntimeEnvironmentStore,
  selector: string,
  offer: PairingOffer,
  args: { now: number; runtimeId?: string; connectionDependency?: 'ssh-tunnel' }
): KnownRuntimeEnvironment {
  const existing = resolveEnvironmentFromStore(store, selector)
  const previousPairingRevision = existing.pairingRevision ?? existing.createdAt
  const environment = createEnvironmentFromPairingOffer({
    id: existing.id,
    name: existing.name,
    now: existing.createdAt,
    offer,
    runtimeId: args.runtimeId ?? existing.runtimeId,
    ...(existing.source ? { source: existing.source } : {}),
    ...getPairingConnectionDependency(args.connectionDependency, offer)
  })
  return {
    ...environment,
    createdAt: existing.createdAt,
    updatedAt: args.now,
    pairingRevision: Math.max(args.now, previousPairingRevision + 1),
    lastUsedAt: existing.lastUsedAt
  }
}

function withReplacedEnvironment(
  store: RuntimeEnvironmentStore,
  environment: KnownRuntimeEnvironment
): RuntimeEnvironmentStore {
  return {
    version: 1,
    environments: store.environments
      .map((entry) => (entry.id === environment.id ? environment : entry))
      .sort((a, b) => a.name.localeCompare(b.name))
  }
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

const MAX_MUTATION_ATTEMPTS = 5

function mutateEnvironmentStore<TResult>(
  userDataPath: string,
  compute: (store: RuntimeEnvironmentStore) => { store: RuntimeEnvironmentStore; result: TResult }
): Promise<TResult> {
  return withRuntimeEnvironmentMutation(userDataPath, () =>
    mutateEnvironmentStoreWithinMutation(userDataPath, compute)
  )
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
