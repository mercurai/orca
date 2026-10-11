import {
  hydrateE2EEV2HostLatch,
  isHostLatchedToE2EEV2,
  latchHostToE2EEV2
} from './e2ee-v2-host-latch'

export type DirectE2EEFraming = 'v2' | 'legacy'

export type DirectE2EEFramingPolicy = {
  framingForNextDial: () => DirectE2EEFraming
  // Re-checked before a legacy credential is sent: another socket may have latched meanwhile.
  mayUseLegacy: () => boolean
  // Only a latched host refusing a v2 hello is an auth verdict; otherwise it is an old host.
  helloRefusalIsAuthFailure: () => boolean
  noteV2Authenticated: () => void
  noteV2HelloRefused: () => void
}

export function createDirectE2EEFramingPolicy(hostPublicKeyB64: string): DirectE2EEFramingPolicy {
  void hydrateE2EEV2HostLatch()
  let helloRefused = false
  const mayUseLegacy = () => isHostLatchedToE2EEV2(hostPublicKeyB64) === false
  return {
    // Why: only a host never seen speaking v2 that refused a v2 hello predates
    // direct v2; anything else falling back would be a downgrade.
    framingForNextDial: () => (helloRefused && mayUseLegacy() ? 'legacy' : 'v2'),
    mayUseLegacy,
    helloRefusalIsAuthFailure: () => isHostLatchedToE2EEV2(hostPublicKeyB64) === true,
    noteV2Authenticated: () => {
      helloRefused = false
      latchHostToE2EEV2(hostPublicKeyB64)
    },
    noteV2HelloRefused: () => {
      helloRefused = true
      void hydrateE2EEV2HostLatch()
    }
  }
}
