import type { WslHostStatus } from '../../shared/wsl-host-types'

export type WslHostServiceDependencies = {
  userDataPath: () => string
  isEnabled: () => boolean
  /** Whether this build ships the orcad template a WSL host deploys from. */
  hasServerFiles: () => boolean
  publish: (status: WslHostStatus) => void
  /** The environment's pairing changed: transports that authenticate with the old one retire. */
  pairingChanged: (environmentId: string) => void
  /** A connection came up: verify the server now rather than on the status owner's backoff. */
  ready: (environmentId: string) => void
  removed: (environmentId: string) => Promise<void> | void
}
