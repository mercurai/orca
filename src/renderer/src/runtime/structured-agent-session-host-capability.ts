import { useEffect, useMemo, useState } from 'react'
import type { SessionOptionProbePhase } from '../../../shared/codex-speed-facts-presentation'
import {
  AGENT_SESSION_CODEX_SERVICE_TIERS_RUNTIME_CAPABILITY,
  AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY,
  AGENT_SESSION_REWIND_RECOVERY_CAPABILITY,
  type RuntimeCapability
} from '../../../shared/protocol-version'
import type { RuntimeClientTarget } from './runtime-client-target'
import {
  ensureLocalRuntimeCapabilities,
  readLocalRuntimeCapabilitiesOrUnknown
} from './local-runtime-capabilities'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { subscribeRuntimeHostContactRegained } from './runtime-host-contact-regained'

export function structuredAgentSessionHostKey(target: RuntimeClientTarget): string {
  return target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
}

/** `unknown` until the host has answered, and after a failed probe: a failed probe is not
 *  evidence about the host. */
export type StructuredAgentSessionHostCapabilityState = 'unknown' | 'supported' | 'unsupported'

/** The state beside whether an actual probe of it is still out: `pending` is presentation only and
 *  never support, `failed` is an unanswered probe, `settled` a completed answer. */
export type StructuredAgentSessionHostCapabilityProbe = {
  state: StructuredAgentSessionHostCapabilityState
  phase: SessionOptionProbePhase
}

type CapabilityAnswer = StructuredAgentSessionHostCapabilityProbe & {
  /** The host and capability the answer is for; another pair never reuses it. */
  key: string
}

const UNANSWERED: StructuredAgentSessionHostCapabilityProbe = { state: 'unknown', phase: 'pending' }

/** Whether the session's host advertises `capability`, with the probe's phase. A failed probe stays
 *  `unknown` and a remote host is asked again each time this client regains contact with it. The one
 *  owner of the probe: the state-only hooks below read it. */
export function useStructuredAgentSessionHostCapabilityProbe(
  target: RuntimeClientTarget,
  capability: RuntimeCapability
): StructuredAgentSessionHostCapabilityProbe {
  const key = `${structuredAgentSessionHostKey(target)}\u0000${capability}`
  const [answer, setAnswer] = useState<CapabilityAnswer>(() => {
    const state = target.kind === 'local' ? localCapabilityState(capability) : 'unknown'
    return { key, state, phase: state === 'unknown' ? 'pending' : 'settled' }
  })
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const [contact, setContact] = useState(0)
  useEffect(() => {
    if (environmentId === null) {
      return
    }
    return subscribeRuntimeHostContactRegained(environmentId, () => setContact((n) => n + 1))
  }, [environmentId])
  useEffect(() => {
    let cancelled = false
    // An unanswered probe that is asked again is pending again; a known answer stands meanwhile.
    setAnswer((current) =>
      current.key === key && current.state === 'unknown' && current.phase === 'failed'
        ? { ...current, phase: 'pending' }
        : current
    )
    const probe: Promise<StructuredAgentSessionHostCapabilityState> =
      environmentId === null
        ? ensureLocalRuntimeCapabilities().then(() => localCapabilityState(capability))
        : runtimeEnvironmentSupportsCapability(environmentId, capability).then((supported) =>
            supported ? 'supported' : 'unsupported'
          )
    void probe
      .catch((): StructuredAgentSessionHostCapabilityState => 'unknown')
      .then((state) => {
        if (!cancelled) {
          const phase = state === 'unknown' ? 'failed' : 'settled'
          setAnswer((current) =>
            current.key === key && current.state === state && current.phase === phase
              ? current
              : { key, state, phase }
          )
        }
      })
    return () => {
      cancelled = true
    }
  }, [capability, contact, environmentId, key])
  const matches = answer.key === key
  const { state, phase } = answer
  return useMemo(() => (matches ? { state, phase } : UNANSWERED), [matches, phase, state])
}

/** Whether the session's host advertises `capability`. A failed probe stays `unknown` and a remote
 *  host is asked again each time this client regains contact with it. */
export function useStructuredAgentSessionHostCapabilityState(
  target: RuntimeClientTarget,
  capability: RuntimeCapability
): StructuredAgentSessionHostCapabilityState {
  return useStructuredAgentSessionHostCapabilityProbe(target, capability).state
}

function localCapabilityState(
  capability: RuntimeCapability
): StructuredAgentSessionHostCapabilityState {
  const capabilities = readLocalRuntimeCapabilitiesOrUnknown()
  return capabilities === null
    ? 'unknown'
    : capabilities.includes(capability)
      ? 'supported'
      : 'unsupported'
}

/** Whether the session's host advertises `capability`. False until the host has said so, and for
 *  a failed probe: an older host is handled as it always was. */
export function useStructuredAgentSessionHostCapability(
  target: RuntimeClientTarget,
  capability: RuntimeCapability
): boolean {
  return useStructuredAgentSessionHostCapabilityState(target, capability) === 'supported'
}

/** Whether the host takes a Stop naming no turn: the only Stop before the provider opens one. */
export function useStructuredAgentSessionHostStopsConversation(
  target: RuntimeClientTarget
): boolean {
  return useStructuredAgentSessionHostCapability(
    target,
    AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY
  )
}

/** Whether the host settles a rewind left in doubt on the next send, agent running or not: only
 *  then may a client offer a rewind, which hands an in-doubt prompt back for that send. */
export function useStructuredAgentSessionHostRecoversRewindOnSend(
  target: RuntimeClientTarget
): boolean {
  return useStructuredAgentSessionHostCapability(target, AGENT_SESSION_REWIND_RECOVERY_CAPABILITY)
}

/** Whether the host holds mid-turn sends as drafts: only then may a client send `delivery`. The
 *  published cards and their queuedMessage actions are not gated on it. */
export function useStructuredAgentSessionHostQueuesMessages(target: RuntimeClientTarget): boolean {
  return useStructuredAgentSessionHostQueuesMessagesState(target) === 'supported'
}

/** Three-state: only `supported` lets a send ask to be queued; `unknown` holds nothing back. */
export function useStructuredAgentSessionHostQueuesMessagesState(
  target: RuntimeClientTarget
): StructuredAgentSessionHostCapabilityState {
  return useStructuredAgentSessionHostCapabilityState(
    target,
    AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY
  )
}

/** The speed capability's state beside its probe phase. Admission reads the state only. */
export function useStructuredAgentSessionHostCodexSpeedProbe(
  target: RuntimeClientTarget
): StructuredAgentSessionHostCapabilityProbe {
  return useStructuredAgentSessionHostCapabilityProbe(
    target,
    AGENT_SESSION_CODEX_SERVICE_TIERS_RUNTIME_CAPABILITY
  )
}

/** Three-state: only `supported` lets a client offer, hold or send a catalog speed tier; every
 *  other answer keeps the older Fast control. */
export function useStructuredAgentSessionHostCodexSpeedState(
  target: RuntimeClientTarget
): StructuredAgentSessionHostCapabilityState {
  return useStructuredAgentSessionHostCodexSpeedProbe(target).state
}

/** Whether the host holds a /compact sent while the agent works as a queued card: only then may
 *  a client send the command's `delivery`, and only where it also renders the queue's cards. */
export function useStructuredAgentSessionHostQueuesCommands(target: RuntimeClientTarget): boolean {
  return useStructuredAgentSessionHostCapability(
    target,
    AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY
  )
}
