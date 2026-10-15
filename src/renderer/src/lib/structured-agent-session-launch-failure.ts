// The failed start's refusal and host-composed authentication guidance, and the speed block that
// holds a launch back.

import type { TuiAgent } from '../../../shared/tui-agent'
import { readAgentSessionRefusalReference } from '../../../shared/agent-session-wire-refusals'
import {
  agentSessionRefusalFailure,
  readAgentSessionErrorRefusal,
  type AgentSessionWriteRefusal
} from '../../../shared/agent-session-write-failure'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { readStructuredAgentSessionCodexSpeedSupport } from '@/runtime/structured-agent-session-client'
import {
  StructuredAgentSessionSpeedHostUnknownError,
  StructuredAgentSessionSpeedHostUnsupportedError,
  type StructuredLaunchSpeedBlock
} from './structured-agent-session-launch-errors'

export type StructuredLaunchFailure = AgentSessionWriteRefusal & { authStartupMessage?: string }

/** The canonical speed a launch seed asks of Codex's host. Every one, Standard included, needs the
 *  executing host's affirmative capability: a host that cannot say does not take it by default. The
 *  legacy Fast boolean never asks, and another provider's launch never carries a tier. */
export function codexSeedSpeedTier(
  agent: TuiAgent,
  seed: Readonly<Record<string, string>> | undefined
): string | undefined {
  return agent === 'codex' ? seed?.serviceTier : undefined
}

async function readSpeedSupport(target: RuntimeClientTarget) {
  try {
    return await readStructuredAgentSessionCodexSpeedSupport(target)
  } catch {
    // A failed probe is not evidence about the host.
    return 'unknown' as const
  }
}

/** What stops `tierId` unless the execution host affirms it takes service tiers; undefined when it does. */
export async function readCodexSpeedBlock(
  target: RuntimeClientTarget,
  tierId: string
): Promise<StructuredLaunchSpeedBlock | undefined> {
  const support = await readSpeedSupport(target)
  if (support === 'supported') {
    return undefined
  }
  return { tierId, reason: support === 'unsupported' ? 'host-update-needed' : 'host-unreachable' }
}

/** The speed block a refused or unanswered create names, when it was the speed that stopped it. */
export function structuredLaunchSpeedBlock(error: unknown): StructuredLaunchSpeedBlock | undefined {
  return error instanceof StructuredAgentSessionSpeedHostUnsupportedError ||
    error instanceof StructuredAgentSessionSpeedHostUnknownError
    ? error.block
    : undefined
}

/** The host's refusal behind a failed launch; undefined when the failure carried none. */
export function structuredLaunchFailure(error: unknown): StructuredLaunchFailure | undefined {
  const refusal =
    error instanceof Error && 'refusal' in error
      ? readAgentSessionRefusalReference(error.refusal)
      : readAgentSessionErrorRefusal(error)
  if (!refusal) {
    return undefined
  }
  const failure = agentSessionRefusalFailure(refusal)
  const message = error instanceof Error ? error.message : undefined
  return failure.code === 'agent_session_operation_invalid' &&
    failure.details?.reason === 'notSignedIn' &&
    message &&
    message !== failure.code
    ? { ...failure, authStartupMessage: message }
    : failure
}
