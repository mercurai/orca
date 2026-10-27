import { withRuntimeEnvironmentMutation } from './runtime-environment-store-mutation'
import { RuntimeEnvironmentStoreError } from './runtime-environment-store-records'
import {
  readWslHostDeployments,
  writeWslHostDeploymentWithinMutation,
  type WslHostPendingStop
} from './wsl-host-deployment-store'

/** Marks (or with null, clears) a Remove that could not prove the host's server stopped. */
export function setWslHostPendingStop(
  userDataPath: string,
  environmentId: string,
  pendingStop: WslHostPendingStop | null,
  expectedCreatedAt?: number
): Promise<void> {
  return withRuntimeEnvironmentMutation(userDataPath, async () => {
    const record = readWslHostDeployments(userDataPath).deployments.find(
      (entry) => entry.environmentId === environmentId
    )
    if (!record) {
      throw new RuntimeEnvironmentStoreError('invalid_argument', 'This server is not a WSL host.')
    }
    if (expectedCreatedAt !== undefined && record.createdAt !== expectedCreatedAt) {
      throw new RuntimeEnvironmentStoreError(
        'invalid_argument',
        'This WSL host changed while removal was pending.'
      )
    }
    const { pendingStop: _previous, ...rest } = record
    await writeWslHostDeploymentWithinMutation(
      userDataPath,
      environmentId,
      pendingStop ? { ...rest, pendingStop } : rest
    )
  })
}
