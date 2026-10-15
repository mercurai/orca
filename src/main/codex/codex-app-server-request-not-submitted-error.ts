/** A request refused before any byte was serialized to the child: the connection was already
 *  closed, terminal or exited, or the frame could not be serialized. Nothing reached the provider.
 *  A failure after the write began is never this type; its delivery stays unknown. */
export class CodexAppServerRequestNotSubmittedError extends Error {
  constructor(
    readonly method: string,
    cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'CodexAppServerRequestNotSubmittedError'
  }
}

export function isCodexAppServerRequestNotSubmittedError(
  error: unknown
): error is CodexAppServerRequestNotSubmittedError {
  return error instanceof Error && error.name === 'CodexAppServerRequestNotSubmittedError'
}
