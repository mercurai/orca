import { agentSessionFailureFact } from '../../../shared/agent-session-failure'

/** A speed refusal is actionable before delivery; it must not become an unrelated host fault. */
export class StructuredAgentSessionSpeedOptionError extends Error {
  readonly failure = agentSessionFailureFact('speedUnavailable', { neverReachedAgent: true })

  constructor(message: string, cause: unknown) {
    super(message, { cause })
    this.name = 'StructuredAgentSessionSpeedOptionError'
  }
}
