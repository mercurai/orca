import type {
  RuntimeDiagnosticState,
  RuntimeShellCloseDiagnostic
} from './runtime-shell-close-diagnostic'
import { RUNTIME_SHELL_MILESTONES } from './runtime-shell-milestones'
import type { RuntimeShellMilestone } from './runtime-shell-milestones'

const MAX_MEMBERS = 8

export function formatRuntimeShellCloseDiagnostic(input: RuntimeShellCloseDiagnostic): string {
  const members = input.members
    .slice(0, MAX_MEMBERS)
    .map(
      (member) =>
        `${safeMemberLabel(member.label)}:${safeImage(member.image)}<-${safeParent(member.parent)}`
    )
  const omitted = Math.max(input.truncatedMembers, input.members.length - members.length)
  return (
    `Windows Codex normal-close snapshot: shell=${safeShellName(input.shellName)}` +
    ` mode=${safeMode(input.mode)} session=${safeCountOrNone(input.sessionIndex)}` +
    ` milestone=${safeMilestone(input.latestMilestone)}` +
    ` childExit=${safeExitCode(input.exitCode)} childSignal=${safeSignal(input.signal)}` +
    ` closeObserved=${flag(input.closeObserved)} killed=${flag(input.killed)}` +
    ` stdin=${flag(input.stdin.writable)},${flag(input.stdin.destroyed)},${flag(input.stdin.ended)},${flag(input.stdin.finished)},${flag(input.stdin.closed)}` +
    ` stdout=${flag(input.stdout.readable)},${flag(input.stdout.destroyed)},${flag(input.stdout.ended)},${flag(input.stdout.closed)}` +
    ` stderr=${flag(input.stderr.readable)},${flag(input.stderr.destroyed)},${flag(input.stderr.ended)},${flag(input.stderr.closed)}` +
    ` pending=${safeCount(input.pendingRequests)}` +
    ` outBytes=${safeCount(input.stdoutBytes)} frames=${safeCount(input.stdoutFrames)}` +
    ` errBytes=${safeCount(input.stderrBytes)}` +
    ` table=${safeState(input.tableState)} job=${safeState(input.jobState)}` +
    ` jobMembers=${input.jobMemberCount === null ? 'unknown' : safeCount(input.jobMemberCount)}` +
    ` missing=${safeCount(input.missingIdentities)} changed=${safeCount(input.changedIdentities)}` +
    ` truncated=${safeCount(omitted)} members=[${members.join(';')}]`
  )
}

function safeShellName(name: string): string {
  return ['Git Bash', 'PowerShell 7', 'Windows PowerShell'].includes(name) ? name : 'other'
}

function safeMode(mode: string): string {
  return mode === 'native' || mode === 'optout' ? mode : 'other'
}

function safeCountOrNone(value: number | null): number | string {
  return value === null ? 'none' : safeCount(value)
}

function safeMilestone(value: RuntimeShellMilestone | null): string {
  return value !== null && RUNTIME_SHELL_MILESTONES.includes(value) ? value : 'none'
}

function safeState(state: RuntimeDiagnosticState): string {
  return [
    'ok',
    'timeout',
    'unavailable',
    'budget',
    'not-read',
    'no-job',
    'error',
    'invalid'
  ].includes(state)
    ? state
    : 'other'
}

function safeExitCode(value: number | null): string {
  return value !== null && Number.isSafeInteger(value) && Math.abs(value) <= 1_000_000_000
    ? String(value)
    : value === null
      ? 'none'
      : 'other'
}

function safeSignal(signal: NodeJS.Signals | null): string {
  if (signal === null) {
    return 'none'
  }
  return ['SIGABRT', 'SIGBREAK', 'SIGINT', 'SIGKILL', 'SIGTERM'].includes(signal) ? signal : 'other'
}

function safeMemberLabel(label: string): string {
  return label === 'root' || /^m\d{1,2}$/u.test(label) ? label : 'other'
}

function safeImage(image: string): string {
  return [
    'bash.exe',
    'codex.exe',
    'cmd.exe',
    'conhost.exe',
    'node.exe',
    'orca.exe',
    'powershell.exe',
    'pwsh.exe',
    'python.exe',
    'other'
  ].includes(image)
    ? image
    : 'other'
}

function safeParent(parent: string): string {
  return ['root', 'outside', 'unknown'].includes(parent) || /^m\d{1,2}$/u.test(parent)
    ? parent
    : 'other'
}

function flag(value: boolean): string {
  return value ? '1' : '0'
}

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000_000) : 0
}
