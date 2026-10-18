import { agentSessionFailureFact } from '../../../shared/agent-session-failure'

/** A speed refusal is actionable before delivery; it must not become an unrelated host fault. */
export class StructuredAgentSessionSpeedOptionError extends Error {
  readonly failure = agentSessionFailureFact('speedUnavailable', { neverReachedAgent: true })

  constructor(message: string, cause: unknown) {
    super(message, { cause })
    this.name = 'StructuredAgentSessionSpeedOptionError'
  }
}

/** Preserve actionable speed facts through the delivery loop's existing failure journal path. */
export function speedOptionDeliveryFailure(error: unknown) {
  return {
    startKey: null,
    cause: error instanceof StructuredAgentSessionSpeedOptionError
      ? { failure: error.failure } : { hostFault: true as const }
  }
}
