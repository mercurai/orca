import type {
  KnownRuntimeEnvironment,
  PublicKnownRuntimeEnvironment,
  RuntimeSshAccessOperation
} from './runtime-environments'
import { RuntimeEnvironmentStoreError } from './runtime-environment-store-records'

/** Everything an SSH access operation was authorized against; any change invalidates the operation. */
export function runtimeEnvironmentSshAccessBinding(
  environment: KnownRuntimeEnvironment | PublicKnownRuntimeEnvironment,
  ignoreIntent = false
): unknown {
  return {
    createdAt: environment.createdAt,
    pairingRevision: environment.pairingRevision ?? environment.createdAt,
    runtimeId: environment.runtimeId,
    pairedDeviceId: environment.pairedDeviceId,
    preferredEndpointId: environment.preferredEndpointId,
    endpoints: environment.endpoints,
    connectionDependency: environment.connectionDependency,
    sshAccess: environment.sshAccess,
    pendingSshAccessOperation: ignoreIntent ? undefined : environment.pendingSshAccessOperation
  }
}

export function requireMatchingRuntimeEnvironmentSshAccessIntent(
  environment: KnownRuntimeEnvironment,
  intent: RuntimeSshAccessOperation
): void {
  if (JSON.stringify(environment.pendingSshAccessOperation) !== JSON.stringify(intent)) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'Another SSH access operation is pending.'
    )
  }
}

export function requireUnchangedRuntimeEnvironmentSshAccess(
  environments: KnownRuntimeEnvironment[],
  expected: KnownRuntimeEnvironment,
  ignoreIntent = false
): KnownRuntimeEnvironment {
  const existing = environments.find((entry) => entry.id === expected.id)
  if (
    !existing ||
    JSON.stringify(runtimeEnvironmentSshAccessBinding(existing, ignoreIntent)) !==
      JSON.stringify(runtimeEnvironmentSshAccessBinding(expected, ignoreIntent))
  ) {
    throw new RuntimeEnvironmentStoreError(
      'invalid_argument',
      'The paired server changed while SSH access was being verified. Retry with its current pairing.'
    )
  }
  return existing
}

export function nextRuntimeEnvironmentPairingRevision(
  environment: KnownRuntimeEnvironment,
  now: number
): number {
  return Math.max(now, (environment.pairingRevision ?? environment.createdAt) + 1)
}

export function runtimeEnvironmentSshAccessError(message: string): RuntimeEnvironmentStoreError {
  return new RuntimeEnvironmentStoreError('invalid_argument', message)
}
