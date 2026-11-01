import { withRuntimeEnvironmentMutation } from './runtime-environment-store-mutation'
import { readEnvironmentStore } from './runtime-environment-store-file'
import { getPreferredLoopbackRuntimePort, getPreferredPairingOffer } from './runtime-environments'
import {
  hasNonWslOwner,
  readWslHostDeployments,
  writeWslHostDeploymentWithinMutation
} from './wsl-host-deployment-store'

/**
 * A crash between refreshWslHostPairing's writes leaves the record's bridge port off the saved
 * pairing, so the overlay drops the WSL link. The record follows the pairing: its port is only
 * where the next connect listens, and that connect saves both. Returns the repaired ids.
 */
export function reconcileWslHostBridgePorts(userDataPath: string): Promise<string[]> {
  return withRuntimeEnvironmentMutation(userDataPath, async () => {
    const environments = readEnvironmentStore(userDataPath).environments
    const repaired: string[] = []
    for (const record of readWslHostDeployments(userDataPath).deployments) {
      const environment = environments.find((entry) => entry.id === record.environmentId)
      // A link that overlaid cleanly reads as an owner too, and needs nothing.
      if (!environment || hasNonWslOwner(environment)) {
        continue
      }
      // A record written for a different pairing stays ignored, not rebound to this one.
      const key = getPreferredPairingOffer(environment).publicKeyB64
      if (
        record.pairingPublicKeyB64 !== undefined &&
        key !== record.pairingPublicKeyB64 &&
        key !== record.previousPairingPublicKeyB64
      ) {
        continue
      }
      const port = getPreferredLoopbackRuntimePort(environment)
      if (port === null || port === record.localPort) {
        continue
      }
      await writeWslHostDeploymentWithinMutation(userDataPath, record.environmentId, {
        ...record,
        localPort: port
      })
      repaired.push(record.environmentId)
    }
    return repaired
  })
}
