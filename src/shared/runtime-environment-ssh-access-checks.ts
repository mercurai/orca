import { runtimeEnvironmentSshAccessBinding } from './runtime-environment-authority-binding'
import type { KnownRuntimeEnvironment, RuntimeSshAccessOperation } from './runtime-environments'
import { RuntimeEnvironmentStoreError } from './runtime-environment-store-file'

// Validation for runtime-environment-ssh-access-store; pure, so it stays outside the mutation lane.

export function requireMatchingIntent(
  environment: KnownRuntimeEnvironment,
  intent: RuntimeSshAccessOperation
): void {
  if (JSON.stringify(environment.pendingSshAccessOperation) !== JSON.stringify(intent)) {
    throw invalid('Another SSH access operation is pending.')
  }
}

export function requireUnchangedEnvironment(
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
    throw invalid(
      'The paired server changed while SSH access was being verified. Retry with its current pairing.'
    )
  }
  return existing
}

export function nextPairingRevision(environment: KnownRuntimeEnvironment, now: number): number {
  return Math.max(now, (environment.pairingRevision ?? environment.createdAt) + 1)
}

export function invalid(message: string): RuntimeEnvironmentStoreError {
  return new RuntimeEnvironmentStoreError('invalid_argument', message)
}
