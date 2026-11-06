import { performance } from 'node:perf_hooks'
import type { WindowsProcessIdentityRow } from '../../../src/main/windows/windows-process-table'
import { readWindowsProcessIdentityTableFresh } from '../../../src/main/windows/windows-process-table'
import type { ProcessMetricsClient } from './process-metrics-client'
import type { RuntimeMode } from './runtime-environment'
import type { Session } from './runtime-shell-session'

const CAPTURE_BUDGET_MS = 900
const TABLE_READ_BUDGET_MS = 200
const JOB_READ_BUDGET_MS = 400
const MAX_MEMBERS = 8

export type RuntimeDiagnosticState =
  | 'ok'
  | 'timeout'
  | 'unavailable'
  | 'budget'
  | 'not-read'
  | 'no-job'
  | 'error'
  | 'invalid'
export type RuntimeDiagnosticMember = { label: string; image: string; parent: string }

export type RuntimeShellCloseDiagnostic = {
  shellName: string
  mode: RuntimeMode
  sessionIndex: number | null
  exitCode: number | null
  signal: NodeJS.Signals | null
  closeObserved: boolean
  killed: boolean
  stdin: {
    writable: boolean
    destroyed: boolean
    ended: boolean
    finished: boolean
    closed: boolean
  }
  stdout: { readable: boolean; destroyed: boolean; ended: boolean; closed: boolean }
  stderr: { readable: boolean; destroyed: boolean; ended: boolean; closed: boolean }
  pendingRequests: number
  stdoutBytes: number
  stdoutFrames: number
  stderrBytes: number
  tableState: RuntimeDiagnosticState
  jobState: RuntimeDiagnosticState
  jobMemberCount: number | null
  missingIdentities: number
  changedIdentities: number
  truncatedMembers: number
  members: RuntimeDiagnosticMember[]
}

type TableReadResult =
  | { state: 'ok'; rows: WindowsProcessIdentityRow[] }
  | { state: 'timeout' | 'unavailable' | 'budget' }

export async function captureRuntimeShellCloseDiagnostic(
  session: Session,
  sampler: ProcessMetricsClient
): Promise<RuntimeShellCloseDiagnostic> {
  const diagnostic = snapshotShell(session)
  const deadline = performance.now() + CAPTURE_BUDGET_MS
  try {
    if (session.jobId === null) {
      diagnostic.jobState = 'no-job'
      return diagnostic
    }
    const before = await readTableWithin(remainingBudget(deadline, TABLE_READ_BUDGET_MS))
    diagnostic.tableState = before.state
    if (before.state !== 'ok') {
      diagnostic.jobState = 'not-read'
      return diagnostic
    }
    if (sampler.isUnavailable) {
      diagnostic.jobState = 'unavailable'
      return diagnostic
    }
    const jobBudget = remainingBudget(deadline, JOB_READ_BUDGET_MS)
    if (jobBudget === 0) {
      diagnostic.jobState = 'budget'
      return diagnostic
    }
    let memberPids: number[]
    try {
      memberPids = await sampler.listJobProcessIds(session.jobId, jobBudget)
    } catch (error) {
      diagnostic.jobState = samplerTimeout(error)
        ? 'timeout'
        : sampler.isUnavailable
          ? 'unavailable'
          : 'error'
      return diagnostic
    }
    diagnostic.jobMemberCount = memberPids.length
    if (new Set(memberPids).size !== memberPids.length) {
      diagnostic.jobState = 'invalid'
      return diagnostic
    }
    diagnostic.jobState = 'ok'
    const after = await readTableWithin(remainingBudget(deadline, TABLE_READ_BUDGET_MS))
    diagnostic.tableState = after.state
    if (after.state !== 'ok') {
      return diagnostic
    }
    const stable = stableJobMembers(
      memberPids,
      before.rows,
      after.rows,
      session.pid,
      session.creationTimeMs
    )
    diagnostic.missingIdentities = stable.missing
    diagnostic.changedIdentities = stable.changed
    const bounded = stable.rows.slice(0, MAX_MEMBERS)
    diagnostic.truncatedMembers = Math.max(0, stable.rows.length - bounded.length)
    const labels = new Map(
      stable.rows.map((row, index) => [row.pid, row.pid === session.pid ? 'root' : `m${index}`])
    )
    diagnostic.members = bounded.map((row) => ({
      label: labels.get(row.pid) ?? 'other',
      image: processCategory(row.name),
      parent: processParent(row, stable.rows, labels, session.pid)
    }))
    return diagnostic
  } catch {
    diagnostic.tableState =
      diagnostic.tableState === 'not-read' ? 'unavailable' : diagnostic.tableState
    diagnostic.jobState = diagnostic.jobState === 'not-read' ? 'error' : diagnostic.jobState
    return diagnostic
  }
}

function snapshotShell(session: Session): RuntimeShellCloseDiagnostic {
  return {
    shellName: session.shell.name,
    mode: session.mode,
    sessionIndex: session.runtimeSessionIndex ?? null,
    exitCode: session.closeResult?.code ?? session.child.exitCode,
    signal: session.closeResult?.signal ?? session.child.signalCode,
    closeObserved: session.closeObserved,
    killed: session.child.killed,
    stdin: {
      writable: session.child.stdin.writable,
      destroyed: session.child.stdin.destroyed,
      ended: session.child.stdin.writableEnded,
      finished: session.child.stdin.writableFinished,
      closed: session.child.stdin.closed
    },
    stdout: {
      readable: session.child.stdout.readable,
      destroyed: session.child.stdout.destroyed,
      ended: session.child.stdout.readableEnded,
      closed: session.child.stdout.closed
    },
    stderr: {
      readable: session.child.stderr.readable,
      destroyed: session.child.stderr.destroyed,
      ended: session.child.stderr.readableEnded,
      closed: session.child.stderr.closed
    },
    pendingRequests: session.pending.size,
    stdoutBytes: session.stdoutBytes,
    stdoutFrames: session.stdoutFrames,
    stderrBytes: session.stderrBytes,
    tableState: 'not-read',
    jobState: 'not-read',
    jobMemberCount: null,
    missingIdentities: 0,
    changedIdentities: 0,
    truncatedMembers: 0,
    members: []
  }
}

async function readTableWithin(timeoutMs: number): Promise<TableReadResult> {
  if (timeoutMs <= 0) {
    return { state: 'budget' }
  }
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      readWindowsProcessIdentityTableFresh().then(
        (rows): TableReadResult => ({ state: 'ok', rows }),
        (): TableReadResult => ({ state: 'unavailable' })
      ),
      new Promise<TableReadResult>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout({ state: 'timeout' }), timeoutMs)
      })
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

function remainingBudget(deadline: number, maximum: number): number {
  const remaining = Math.floor(deadline - performance.now())
  return remaining > 0 ? Math.min(remaining, maximum) : 0
}

function samplerTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === 'Python metrics sampler request timed out'
}

function stableJobMembers(
  pids: number[],
  before: WindowsProcessIdentityRow[],
  after: WindowsProcessIdentityRow[],
  rootPid: number,
  rootCreationTimeMs: number
): { rows: WindowsProcessIdentityRow[]; missing: number; changed: number } {
  const beforeByPid = new Map(before.map((row) => [row.pid, row]))
  const afterByPid = new Map(after.map((row) => [row.pid, row]))
  const rows: WindowsProcessIdentityRow[] = []
  let missing = 0
  let changed = 0
  for (const pid of pids) {
    const first = beforeByPid.get(pid)
    const second = afterByPid.get(pid)
    if (
      !first ||
      !second ||
      typeof first.creationTimeMs !== 'number' ||
      typeof second.creationTimeMs !== 'number'
    ) {
      missing++
      continue
    }
    if (
      first.creationTimeMs !== second.creationTimeMs ||
      (pid === rootPid && second.creationTimeMs !== rootCreationTimeMs)
    ) {
      changed++
      continue
    }
    rows.push(second)
  }
  rows.sort((left, right) => {
    if (left.pid === rootPid) {
      return -1
    }
    if (right.pid === rootPid) {
      return 1
    }
    return left.pid - right.pid
  })
  return { rows, missing, changed }
}

function processParent(
  row: WindowsProcessIdentityRow,
  members: WindowsProcessIdentityRow[],
  labels: Map<number, string>,
  rootPid: number
): string {
  if (labels.has(row.ppid)) {
    return labels.get(row.ppid) ?? 'unknown'
  }
  return members.some((candidate) => candidate.pid === rootPid) ? 'outside' : 'unknown'
}

function processCategory(name: string): string {
  const basename = name.split(/[\\/]/u).at(-1)?.toLowerCase() ?? ''
  return [
    'bash.exe',
    'codex.exe',
    'cmd.exe',
    'conhost.exe',
    'node.exe',
    'orca.exe',
    'powershell.exe',
    'pwsh.exe',
    'python.exe'
  ].includes(basename)
    ? basename
    : 'other'
}
