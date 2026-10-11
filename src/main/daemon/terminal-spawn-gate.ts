import {
  applySpawnAdmission,
  createSpawnAdmissionState,
  decideSpawnAdmission,
  DEFAULT_SPAWN_ADMISSION_LIMITS,
  pruneUserResumeBuckets,
  releaseLiveAutomatic,
  resolveSpawnCharge,
  settleSpawnAdmission,
  TERMINAL_SPAWN_DEFERRED_PREFIX,
  TERMINAL_SPAWN_REFUSED_MESSAGE,
  type AutomaticWorkMode,
  type HostPressureLevel,
  type SpawnAdmissionDecision,
  type SpawnAdmissionLimits,
  type SpawnAdmissionState,
  type SpawnCharge,
  type SpawnRequestFacts
} from '../../shared/host-spawn-admission'
import { TERMINAL_HOST_CAP_HINT } from '../../shared/terminal-spawn-error-copy'
import { DEFAULT_MAX_HOST_TERMINALS, HostTerminalLedger } from './host-terminal-ledger'

export type TerminalSpawnAdmissionMode = 'observe' | 'enforce'

const RECENT_AUTOMATIC_WORK_MS = 10 * 60_000

export const TERMINAL_SPAWN_ADMISSION_ARG = '--spawn-admission'

/** Reads the launcher's `--spawn-admission <mode>`; anything else observes. */
export function readTerminalSpawnAdmissionArg(argv: readonly string[]): TerminalSpawnAdmissionMode {
  const index = argv.indexOf(TERMINAL_SPAWN_ADMISSION_ARG)
  return index !== -1 && argv[index + 1] === 'enforce' ? 'enforce' : 'observe'
}

export type TerminalSpawnLease = {
  readonly charge: SpawnCharge
  /** The fork published a session; only a live automatic one holds a live-cap slot. */
  commit(sessionId: string, isAlive: boolean): void
  /** The fork never published a session. */
  abandon(): void
}

export type TerminalSpawnGateSnapshot = {
  mode: TerminalSpawnAdmissionMode
  inFlight: Record<SpawnCharge, number>
  liveAutomatic: number
  /** Live plus starting terminals of every charge; what the host cap counts for this daemon. */
  terminals: number
  waiting: number
  waited: number
  deferred: number
  refused: number
  hostCapRefused: number
}

export class TerminalSpawnDeferredError extends Error {
  constructor(readonly reason: string) {
    super(`${TERMINAL_SPAWN_DEFERRED_PREFIX}${reason}`)
    this.name = 'TerminalSpawnDeferredError'
  }
}

type TerminalSpawnGateOptions = {
  log: (event: string, details: Record<string, unknown>) => void
  mode?: TerminalSpawnAdmissionMode
  limits?: SpawnAdmissionLimits
  now?: () => number
  pressure?: () => HostPressureLevel
  automaticWorkMode?: () => AutomaticWorkMode
  /** Runs synchronously before the first automatic fork is admitted. */
  armAutomaticWork?: () => void
  /** The execution host's terminal cap; defaults to capping this daemon alone. */
  hostTerminals?: HostTerminalLedger
}

/**
 * The daemon's single fork gate. In `observe` every request is admitted at once and
 * the policy's verdict is only counted. In `enforce` automatic restores wait for a
 * slot inside the caller's deadline; a caller that declared an intent may instead be
 * told to keep its pane sleeping, and an undeclared caller is only ever paced.
 */
export class TerminalSpawnGate {
  private readonly mode: TerminalSpawnAdmissionMode
  private readonly limits: SpawnAdmissionLimits
  private readonly now: () => number
  private readonly pressure: () => HostPressureLevel
  private readonly automaticWorkMode: () => AutomaticWorkMode
  private readonly state: SpawnAdmissionState
  private readonly liveAutomaticSessions = new Set<string>()
  private readonly liveSessions = new Set<string>()
  private readonly hostTerminals: HostTerminalLedger
  private readonly waiters = new Set<() => void>()
  private waited = 0
  private lastAutomaticAdmitAt: number | null = null
  private deferred = 0
  private refused = 0
  private hostCapRefused = 0

  constructor(private readonly options: TerminalSpawnGateOptions) {
    this.mode = options.mode ?? 'observe'
    this.limits = options.limits ?? DEFAULT_SPAWN_ADMISSION_LIMITS
    this.now = options.now ?? Date.now
    this.pressure = options.pressure ?? (() => 'unknown')
    this.automaticWorkMode = options.automaticWorkMode ?? (() => ({ kind: 'normal' }))
    this.state = createSpawnAdmissionState(this.limits, this.now())
    this.hostTerminals =
      options.hostTerminals ??
      new HostTerminalLedger({
        dir: null,
        maxTerminals: DEFAULT_MAX_HOST_TERMINALS,
        log: options.log
      })
  }

  /** Returns synchronously unless the request has to wait, so an unpaced fork keeps
   *  today's timing against the host's shutdown fence. */
  admit(
    facts: SpawnRequestFacts,
    cancel?: { signal: AbortSignal; error: () => Error }
  ): TerminalSpawnLease | Promise<TerminalSpawnLease> {
    const attempt = this.attempt(facts, cancel, false)
    return attempt.kind === 'lease' ? attempt.lease : this.admitAfterWait(facts, cancel, attempt)
  }

  private async admitAfterWait(
    facts: SpawnRequestFacts,
    cancel: { signal: AbortSignal; error: () => Error } | undefined,
    first: { kind: 'wait'; untilMs: number }
  ): Promise<TerminalSpawnLease> {
    let attempt: ReturnType<TerminalSpawnGate['attempt']> = first
    while (attempt.kind === 'wait') {
      await this.waitForChange(attempt.untilMs, cancel?.signal)
      attempt = this.attempt(facts, cancel, true)
    }
    return attempt.lease
  }

  private attempt(
    facts: SpawnRequestFacts,
    cancel: { signal: AbortSignal; error: () => Error } | undefined,
    alreadyWaited: boolean
  ): { kind: 'lease'; lease: TerminalSpawnLease } | { kind: 'wait'; untilMs: number } {
    if (cancel?.signal.aborted) {
      throw cancel.error()
    }
    const now = this.now()
    pruneUserResumeBuckets(this.state, this.limits, now)
    const charge = resolveSpawnCharge(this.state, facts, this.limits, now)
    const decision = decideSpawnAdmission({
      state: this.state,
      facts,
      charge,
      pressure: this.pressure(),
      mode: this.automaticWorkMode(),
      limits: this.limits,
      now
    })
    if (this.mode === 'observe' || decision.kind === 'admit') {
      // Why reserve before recording: a refused fork must not be logged as admitted.
      if (!this.hostTerminals.tryReserve(this.ownTerminals())) {
        this.refuseAtHostCap(facts, charge)
      }
      this.record(decision, charge, facts, !alreadyWaited)
      return { kind: 'lease', lease: this.lease(facts, charge, now) }
    }
    // Why: a request that would only wait to be refused at the cap is told at once.
    if (decision.kind === 'wait' && !this.hostTerminals.hasRoom(this.ownTerminals())) {
      this.refuseAtHostCap(facts, charge)
    }
    this.record(decision, charge, facts, !alreadyWaited)
    if (decision.kind === 'defer') {
      throw new TerminalSpawnDeferredError(decision.reason)
    }
    if (decision.kind === 'refuse_retryable') {
      throw new Error(TERMINAL_SPAWN_REFUSED_MESSAGE)
    }
    return { kind: 'wait', untilMs: Math.min(decision.retryAt ?? Infinity, facts.deadlineAt) }
  }

  /** A pressure change can let a waiter through, or make it give up. */
  onPressureChanged(): void {
    this.wakeWaiters()
  }

  hasRecentAutomaticWork(now: number = this.now()): boolean {
    return (
      this.lastAutomaticAdmitAt !== null &&
      now - this.lastAutomaticAdmitAt < RECENT_AUTOMATIC_WORK_MS
    )
  }

  onSessionExit(sessionId: string): void {
    if (this.liveSessions.delete(sessionId)) {
      this.publishTerminals()
      this.wakeWaiters()
    }
    if (this.liveAutomaticSessions.delete(sessionId)) {
      releaseLiveAutomatic(this.state)
      this.wakeWaiters()
    }
  }

  snapshot(): TerminalSpawnGateSnapshot {
    return {
      mode: this.mode,
      inFlight: { ...this.state.inFlight },
      liveAutomatic: this.state.liveAutomatic,
      terminals: this.ownTerminals(),
      waiting: this.waiters.size,
      waited: this.waited,
      deferred: this.deferred,
      refused: this.refused,
      hostCapRefused: this.hostCapRefused
    }
  }

  /** Starts keeping this daemon's entry in the host's shared count fresh. */
  startHostTerminals(): void {
    this.hostTerminals.start()
  }

  /** Removes this daemon from the host's shared count; its sessions are gone. */
  stopHostTerminals(): void {
    this.hostTerminals.close()
  }

  private ownTerminals(): number {
    const { interactive, user, automatic } = this.state.inFlight
    return this.liveSessions.size + interactive + user + automatic
  }

  private publishTerminals(): void {
    try {
      this.hostTerminals.publish(this.ownTerminals())
    } catch {
      // The shared count is advisory for other daemons; this one's own cap still holds.
    }
  }

  private refuseAtHostCap(facts: SpawnRequestFacts, charge: SpawnCharge): never {
    this.hostCapRefused += 1
    try {
      this.options.log('host-terminal-cap-reached', {
        charge,
        declaredIntent: facts.declaredIntent,
        terminals: this.ownTerminals(),
        maxTerminals: this.hostTerminals.maxTerminals
      })
    } catch {
      // Diagnostics must never change the refusal.
    }
    // Why: a caller that declared a restore keeps its pane sleeping with its handle; every
    // other caller, old ones included, sees a plain message it already renders as an error.
    if (facts.declaredIntent !== null && charge !== 'interactive') {
      throw new TerminalSpawnDeferredError('live_cap')
    }
    throw new Error(TERMINAL_HOST_CAP_HINT)
  }

  private lease(facts: SpawnRequestFacts, charge: SpawnCharge, now: number): TerminalSpawnLease {
    if (charge === 'automatic') {
      this.options.armAutomaticWork?.()
      this.lastAutomaticAdmitAt = now
    }
    applySpawnAdmission(this.state, facts, charge, this.limits, now)
    let settled = false
    const settle = (sessionId: string | null, isAlive: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      const becameLive = charge === 'automatic' && isAlive && sessionId !== null
      settleSpawnAdmission(this.state, charge, becameLive)
      if (becameLive) {
        this.liveAutomaticSessions.add(sessionId)
      }
      if (isAlive && sessionId !== null) {
        this.liveSessions.add(sessionId)
      }
      this.publishTerminals()
      this.wakeWaiters()
    }
    return {
      charge,
      commit: (sessionId, isAlive) => settle(sessionId, isAlive),
      abandon: () => settle(null, false)
    }
  }

  private waitForChange(untilMs: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', done)
        this.waiters.delete(done)
        resolve()
      }
      const delayMs = Number.isFinite(untilMs) ? Math.max(0, untilMs - this.now()) : 2_147_483_647
      const timer = setTimeout(done, Math.min(delayMs, 2_147_483_647))
      timer.unref?.()
      this.waiters.add(done)
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  private wakeWaiters(): void {
    for (const wake of this.waiters) {
      wake()
    }
  }

  private record(
    decision: SpawnAdmissionDecision,
    charge: SpawnCharge,
    facts: SpawnRequestFacts,
    firstDecision: boolean
  ): void {
    // Why first only: a woken waiter re-decides, and counting each pass would inflate `waited`.
    if ((decision.kind === 'admit' && charge === 'interactive') || !firstDecision) {
      return
    }
    if (decision.kind === 'wait') {
      this.waited += 1
    } else if (decision.kind === 'defer') {
      this.deferred += 1
    } else if (decision.kind === 'refuse_retryable') {
      this.refused += 1
    }
    try {
      this.options.log(this.mode === 'observe' ? 'spawn-admission-observed' : 'spawn-admission', {
        decision: decision.kind,
        ...(decision.kind === 'defer' ? { reason: decision.reason } : {}),
        charge,
        declaredIntent: facts.declaredIntent,
        inFlightAutomatic: this.state.inFlight.automatic,
        liveAutomatic: this.state.liveAutomatic
      })
    } catch {
      // Diagnostics must never turn an admitted fork into a failed create.
    }
  }
}
