import type { CodexTurnHost } from './codex-structured-turn-start'

export function restoreRejectedCodexTurnOptions(
  host: Pick<CodexTurnHost, 'options' | 'appliedTurnOptions' | 'speedDispatchSequence'>,
  requested: Readonly<Record<string, string>>,
  previousOptions: ReadonlyMap<string, string>,
  previousApplied: Readonly<Record<string, string>> | undefined,
  sequence: number
): void {
  if (host.appliedTurnOptions === requested) {
    host.appliedTurnOptions = previousApplied
  }
  // An older rejection must not roll back a later picker change or request.
  if (
    host.speedDispatchSequence === sequence &&
    host.options.size === Object.keys(requested).length &&
    Object.entries(requested).every(([key, value]) => host.options.get(key) === value)
  ) {
    host.options.clear()
    for (const [key, value] of previousOptions) {
      host.options.set(key, value)
    }
  }
}
