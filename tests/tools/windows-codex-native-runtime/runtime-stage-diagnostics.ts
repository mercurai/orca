import type { RuntimeMode } from './runtime-environment'
import type { Session } from './runtime-shell-session'

export type RuntimeChildFailureSnapshot = {
  closeObserved: boolean
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdoutBytes: number
  stdoutFrames: number
  stderrBytes: number
}

type RuntimeStageContext = {
  shellName: string
  mode: RuntimeMode
  sessionCount: number
  runIndex: number
  pairId: number
  phase: string
  sessionIndex: number | null
}

export type RuntimeStageDiagnostic = RuntimeStageContext & {
  error: unknown
  childrenAtFailure: RuntimeChildFailureSnapshot[]
}

export function runtimeStageFailureMessage(input: RuntimeStageDiagnostic): string {
  const children = input.childrenAtFailure.slice(0, 3).map(sessionDiagnostic)
  const omittedChildren = Math.max(0, input.childrenAtFailure.length - children.length)
  return (
    `Windows Codex runtime stage failed: shell=${safeShellName(input.shellName)}` +
    ` mode=${input.mode} sessions=${input.sessionCount}` +
    ` run=${input.runIndex + 1} pair=${input.pairId + 1}` +
    ` phase=${safePhase(input.phase)} session=${input.sessionIndex ?? 'none'}` +
    ` cause=${safeFailureCategory(input.error)}` +
    ` childrenAtFailure=[${children.join(';')}${omittedChildren > 0 ? `;+${omittedChildren}` : ''}]`
  )
}

export function runtimeStageCleanupMessage(
  input: RuntimeStageContext & {
    cleanupErrorCount: number
    unverifiedCleanupCount: number
    forcedCleanupCount: number
    sessions: Pick<Session, 'cleanupComplete' | 'cleanupMode'>[]
  }
): string {
  const cleanupModes = input.sessions.slice(0, 3).map((session, index) => {
    const mode = session.cleanupMode ?? (session.cleanupComplete ? 'verified' : 'unverified')
    return `s${index + 1}:${mode}`
  })
  const omittedSessions = Math.max(0, input.sessions.length - cleanupModes.length)
  return (
    `Windows Codex runtime cleanup: shell=${safeShellName(input.shellName)}` +
    ` mode=${input.mode} sessions=${input.sessionCount}` +
    ` run=${input.runIndex + 1} pair=${input.pairId + 1}` +
    ` errors=${safeCount(input.cleanupErrorCount)}` +
    ` unverified=${safeCount(input.unverifiedCleanupCount)}` +
    ` forced=${safeCount(input.forcedCleanupCount)}` +
    ` sessions=[${cleanupModes.join(';')}${omittedSessions > 0 ? `;+${omittedSessions}` : ''}]`
  )
}

export function snapshotRuntimeChild(session: Session): RuntimeChildFailureSnapshot {
  return {
    closeObserved: session.closeObserved,
    exitCode: session.closeResult?.code ?? session.child.exitCode,
    signal: session.closeResult?.signal ?? session.child.signalCode,
    stdoutBytes: session.stdoutBytes,
    stdoutFrames: session.stdoutFrames,
    stderrBytes: session.stderrBytes
  }
}

function sessionDiagnostic(session: RuntimeChildFailureSnapshot, index: number): string {
  const childState = session.closeObserved
    ? `exit=${session.exitCode ?? 'none'},signal=${safeSignal(session.signal)}`
    : session.exitCode !== null || session.signal !== null
      ? `closing,exit=${session.exitCode ?? 'none'},signal=${safeSignal(session.signal)}`
      : 'open'
  return (
    `s${index + 1}{${childState}` +
    `,outBytes=${safeCount(session.stdoutBytes)}` +
    `,frames=${safeCount(session.stdoutFrames)}` +
    `,errBytes=${safeCount(session.stderrBytes)}}`
  )
}

function safeShellName(name: string): string {
  return ['Git Bash', 'PowerShell 7', 'Windows PowerShell'].includes(name) ? name : 'other'
}

function safePhase(phase: string): string {
  return /^[a-z-]{1,40}$/u.test(phase) ? phase : 'other'
}

function safeSignal(signal: NodeJS.Signals | null): string {
  if (signal === null) {
    return 'none'
  }
  return ['SIGABRT', 'SIGBREAK', 'SIGINT', 'SIGKILL', 'SIGTERM'].includes(signal) ? signal : 'other'
}

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000_000) : 0
}

function safeFailureCategory(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'unknown'
  }
  if (error.message === 'Codex app-server initialize timed out') {
    return 'initialize-timeout'
  }
  if (error.message.endsWith(' timed out')) {
    return 'operation-timeout'
  }
  return error instanceof AggregateError ? 'aggregate-error' : 'operation-failed'
}
