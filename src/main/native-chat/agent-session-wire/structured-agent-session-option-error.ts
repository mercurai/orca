/** Option validation failed before the provider session was mutated. */
export class AgentSessionOptionRejectedError extends Error {
  constructor(
    cause: unknown,
    /** `providerStarting`: nothing is wrong with the value; the session cannot take it yet. */
    readonly refusalReason: 'optionRejected' | 'providerStarting' = 'optionRejected',
    /** The complete option map that records this refusal; the host persists it before refusing. */
    readonly refusalOptions?: Readonly<Record<string, string>>
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'AgentSessionOptionRejectedError'
  }
}

export function isAgentSessionOptionRejectedError(
  error: unknown
): error is AgentSessionOptionRejectedError {
  return error instanceof Error && error.name === 'AgentSessionOptionRejectedError'
}

/** The map a refusal records, or undefined. A starting provider never records one: nothing was
 *  wrong with the value, so there is no refusal to remember. */
export function recordedRefusalOptions(
  error: unknown
): Readonly<Record<string, string>> | undefined {
  return isAgentSessionOptionRejectedError(error) && error.refusalReason === 'optionRejected'
    ? error.refusalOptions
    : undefined
}
