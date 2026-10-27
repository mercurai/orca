import type { CodexTurnHost } from './codex-structured-turn-start'

type Options = Readonly<Record<string, string>>
type Host = Pick<CodexTurnHost, 'options' | 'appliedTurnOptions'>
type Previous = {
  options: ReadonlyMap<string, string>
  applied: Options | undefined
  owner: Attempt | undefined
}
type Attempt = {
  requested: Options
  revision: number
  rejected: boolean
  previous: Previous | undefined
}
type Ownership = {
  revision: number
  owner: Attempt | undefined
  attempts: WeakMap<Options, Attempt>
}

const ownership = new WeakMap<Host, Ownership>()

function ownershipFor(host: Host): Ownership {
  const existing = ownership.get(host)
  if (existing) {
    return existing
  }
  const created = { revision: 0, owner: undefined, attempts: new WeakMap<Options, Attempt>() }
  ownership.set(host, created)
  return created
}

function matches(options: ReadonlyMap<string, string>, requested: Options): boolean {
  return (
    options.size === Object.keys(requested).length &&
    Object.entries(requested).every(([key, value]) => options.get(key) === value)
  )
}

/** An explicit picker action owns intent even when it selects the currently shown value. */
export function recordCodexOptionIntent(host: Host): void {
  const state = ownershipFor(host)
  state.revision += 1
  state.owner = undefined
}

function rejectAttempt(host: Host, state: Ownership, attempt: Attempt): void {
  attempt.rejected = true
  let applied = host.appliedTurnOptions && state.attempts.get(host.appliedTurnOptions)
  while (applied?.rejected && applied.previous) {
    host.appliedTurnOptions = applied.previous.applied
    applied = host.appliedTurnOptions && state.attempts.get(host.appliedTurnOptions)
  }
  let owner = state.owner
  if (!owner || owner.revision !== state.revision || !matches(host.options, owner.requested)) {
    state.owner = undefined
    return
  }
  let restored: ReadonlyMap<string, string> | undefined
  while (owner?.rejected && owner.previous) {
    restored = owner.previous.options
    owner = owner.previous.owner
  }
  state.owner = owner
  if (restored) {
    host.options.clear()
    for (const [key, value] of restored) {
      host.options.set(key, value)
    }
  }
}

/** Track request ownership without treating a pending or retained request as accepted processing. */
export function beginCodexTurnOptions(host: Host, requested: Options) {
  const state = ownershipFor(host)
  const attempt: Attempt = {
    requested,
    revision: state.revision,
    rejected: false,
    previous: {
      options: new Map(host.options),
      applied: host.appliedTurnOptions,
      owner: state.owner && matches(host.options, state.owner.requested) ? state.owner : undefined
    }
  }
  state.attempts.set(requested, attempt)
  state.owner = attempt
  host.options.clear()
  for (const [key, value] of Object.entries(requested)) {
    host.options.set(key, value)
  }
  host.appliedTurnOptions = requested
  return {
    reject: () => rejectAttempt(host, state, attempt),
    // Accepted or uncertain replies no longer need rollback predecessors.
    retain: () => {
      attempt.previous = undefined
    }
  }
}
