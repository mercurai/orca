import {
  addEnvironmentFromPairingCode as addEnvironmentFromPairingCodeInStore,
  getEnvironmentStorePath,
  listEnvironments,
  removeEnvironment as removeEnvironmentFromStore,
  resolveEnvironment as resolveEnvironmentFromStore,
  resolveEnvironmentPairingOffer as resolveEnvironmentPairingOfferFromStore,
  RuntimeEnvironmentStoreError,
  type RuntimeEnvironmentStoreErrorCode
} from '../../shared/runtime-environment-store'
import { markEnvironmentUsed as markEnvironmentUsedInStore } from '../../shared/runtime-environment-usage'
import type {
  KnownRuntimeEnvironment,
  PublicKnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import type { PairingOffer } from '../../shared/pairing'
import { RuntimeClientError } from './types'

export type EnvironmentAddResult = {
  environment: PublicKnownRuntimeEnvironment
}

export type EnvironmentRemoveResult = {
  removed: PublicKnownRuntimeEnvironment
}

export { getEnvironmentStorePath, listEnvironments }

export function addEnvironmentFromPairingCode(
  userDataPath: string,
  args: { name: string; pairingCode: string; now?: number }
): Promise<KnownRuntimeEnvironment> {
  return translateStoreErrorAsync(() => addEnvironmentFromPairingCodeInStore(userDataPath, args))
}

export function removeEnvironment(
  userDataPath: string,
  selector: string
): Promise<KnownRuntimeEnvironment> {
  return translateStoreErrorAsync(() => removeEnvironmentFromStore(userDataPath, selector))
}

export function resolveEnvironment(
  userDataPath: string,
  selector: string
): KnownRuntimeEnvironment {
  return translateStoreError(() => resolveEnvironmentFromStore(userDataPath, selector))
}

export function resolveEnvironmentPairingOffer(
  userDataPath: string,
  selector: string
): PairingOffer {
  return translateStoreError(() => resolveEnvironmentPairingOfferFromStore(userDataPath, selector))
}

export function markEnvironmentUsed(
  userDataPath: string,
  selector: string,
  args: { runtimeId?: string | null; now?: number } = {}
): Promise<void> {
  return translateStoreErrorAsync(() => markEnvironmentUsedInStore(userDataPath, selector, args))
}

function toRuntimeClientError(error: unknown): unknown {
  return error instanceof RuntimeEnvironmentStoreError
    ? new RuntimeClientError(toRuntimeClientErrorCode(error.code), error.message)
    : error
}

function translateStoreError<TResult>(fn: () => TResult): TResult {
  try {
    return fn()
  } catch (error) {
    throw toRuntimeClientError(error)
  }
}

// Why: the store mutators reject (or throw synchronously) with store errors; both must surface as client errors.
async function translateStoreErrorAsync<TResult>(fn: () => Promise<TResult>): Promise<TResult> {
  try {
    return await fn()
  } catch (error) {
    throw toRuntimeClientError(error)
  }
}

function toRuntimeClientErrorCode(
  code: RuntimeEnvironmentStoreErrorCode
): 'invalid_argument' | 'runtime_error' {
  return code
}
