import { performance } from 'node:perf_hooks'
import { forceTerminateProcessTree } from '@orca/process-host/process-tree-termination'
import { readWindowsProcessIdentityTableFresh } from '../../../src/main/windows/windows-process-table'
import {
  processIdentity,
  processTreeForRoot,
  waitForProcessTreeExit
} from './process-tree-identity'
import type { ProcessMetricsClient } from './process-metrics-client'
import type { ProcessIdentity } from './process-tree-identity'
import type { RuntimeShell } from './runtime-environment'
import type { Session } from './runtime-shell-session'

const LAUNCH_GATE_TOKEN = 'ORCA_RUNTIME_JOB_READY'
const CLOSE_WAIT_MS = 8_000
const TREE_POLL_MS = 200

export function runtimeShellJobGate(shell: RuntimeShell): string {
  if (shell.kind === 'bash') {
    return [
      'IFS= read -r __orca_runtime_job_gate || exit 97',
      `[[ "$__orca_runtime_job_gate" == '${LAUNCH_GATE_TOKEN}' ]] || exit 97`
    ].join('\n')
  }
  return [
    '# Read raw bytes so buffered input cannot consume the first app-server frame.',
    '$orcaRuntimeJobGateStream = [Console]::OpenStandardInput()',
    `$orcaRuntimeJobGateBytes = [byte[]]::new(${LAUNCH_GATE_TOKEN.length})`,
    '$orcaRuntimeJobGateLength = 0',
    'while ($true) {',
    '    $orcaRuntimeJobGateByte = $orcaRuntimeJobGateStream.ReadByte()',
    '    if ($orcaRuntimeJobGateByte -lt 0) { exit 97 }',
    '    if ($orcaRuntimeJobGateByte -eq 10) { break }',
    `    if ($orcaRuntimeJobGateLength -ge ${LAUNCH_GATE_TOKEN.length}) { exit 97 }`,
    '    $orcaRuntimeJobGateBytes[$orcaRuntimeJobGateLength] = [byte]$orcaRuntimeJobGateByte',
    '    $orcaRuntimeJobGateLength++',
    '}',
    `if ($orcaRuntimeJobGateLength -ne ${LAUNCH_GATE_TOKEN.length}) { exit 97 }`,
    `$orcaRuntimeJobGate = [Text.Encoding]::ASCII.GetString($orcaRuntimeJobGateBytes, 0, $orcaRuntimeJobGateLength)`,
    `if ($orcaRuntimeJobGate -cne '${LAUNCH_GATE_TOKEN}') { exit 97 }`
  ].join('\n')
}

export async function assignShellJobAndRelease(
  session: Session,
  sampler: ProcessMetricsClient
): Promise<void> {
  const beforeAssignment = await readWindowsProcessIdentityTableFresh()
  const initialTree = processTreeForRoot(beforeAssignment, session.pid, session.creationTimeMs)
  const root = initialTree[0]
  if (!root) {
    throw new Error(`${session.shell.name} process root was absent before job assignment`)
  }
  session.preGateProcessIdentities = initialTree.slice(1).map(processIdentity)
  rememberIdentities(session, initialTree.map(processIdentity))

  const jobId = await sampler.createJob(processIdentity(root))
  if (!Number.isSafeInteger(jobId) || jobId <= 0) {
    throw new Error('The runtime shell job helper returned an invalid job identity')
  }
  session.jobId = jobId

  const afterAssignment = await readWindowsProcessIdentityTableFresh()
  const memberPids = await sampler.listJobProcessIds(jobId)
  if (new Set(memberPids).size !== memberPids.length) {
    throw new Error('The runtime shell job helper returned duplicate process identities')
  }
  if (!memberPids.includes(session.pid)) {
    throw new Error('The runtime shell was not present in its assigned job')
  }
  const tableByPid = new Map(afterAssignment.map((row) => [row.pid, row]))
  const members: ProcessIdentity[] = []
  for (const pid of memberPids) {
    const row = tableByPid.get(pid)
    if (!row) {
      throw new Error('The native process table omitted a runtime job member')
    }
    const identity = processIdentity(row)
    if (pid === session.pid && identity.creationTimeMs !== session.creationTimeMs) {
      throw new Error('The runtime shell identity changed while assigning its job')
    }
    members.push(identity)
  }
  rememberIdentities(session, members)
  await releaseShellGate(session)
}

async function releaseShellGate(session: Session): Promise<void> {
  await new Promise<void>((resolveWrite, rejectWrite) => {
    session.child.stdin.write(`${LAUNCH_GATE_TOKEN}\n`, (error) => {
      if (error) {
        rejectWrite(error)
      } else {
        resolveWrite()
      }
    })
  })
  session.launchGateReleasedAt = performance.now()
}

function rememberIdentities(session: Session, identities: ProcessIdentity[]): void {
  const observed = new Map(
    session.observedProcessIdentities.map((identity) => [
      `${identity.pid}:${identity.creationTimeMs}`,
      identity
    ])
  )
  for (const identity of identities) {
    observed.set(`${identity.pid}:${identity.creationTimeMs}`, identity)
  }
  session.observedProcessIdentities = [...observed.values()]
}

export async function stopSession(
  session: Session,
  sampler: ProcessMetricsClient
): Promise<number> {
  if (session.cleanupComplete) {
    return session.cleanupMs ?? 0
  }
  const startedAt = performance.now()
  try {
    await stopNormally(session, sampler)
    session.cleanupComplete = true
    session.cleanupMs = performance.now() - startedAt
    return session.cleanupMs
  } catch (error) {
    try {
      await terminateOwnedSession(session, sampler)
      session.cleanupComplete = true
      session.cleanupMs = performance.now() - startedAt
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${session.shell.name} failed and its owned process cleanup was not verified`
      )
    }
    throw error
  }
}

async function stopNormally(session: Session, sampler: ProcessMetricsClient): Promise<void> {
  if (session.child.exitCode === null && session.child.signalCode === null) {
    session.child.stdin.end()
  }
  const close = await withTimeout(session.closePromise, CLOSE_WAIT_MS)
  if (close.code !== 0 || close.signal !== null) {
    throw new Error(`${session.shell.name} did not exit normally after app-server EOF`)
  }
  await waitForOwnedSessionExit(session, sampler)
  await releaseEmptyJob(session, sampler)
}

async function terminateOwnedSession(
  session: Session,
  sampler: ProcessMetricsClient
): Promise<void> {
  if (session.jobId !== null) {
    await sampler.terminateJob(session.jobId)
  } else if (session.child.exitCode === null && session.child.signalCode === null) {
    await forceTerminateProcessTree(session.child)
  }
  await withTimeout(session.closePromise, CLOSE_WAIT_MS)
  await waitForOwnedSessionExit(session, sampler)
  await releaseEmptyJob(session, sampler)
}

async function waitForOwnedSessionExit(
  session: Session,
  sampler: ProcessMetricsClient
): Promise<void> {
  const deadline = Date.now() + CLOSE_WAIT_MS
  if (session.jobId !== null) {
    while (Date.now() < deadline) {
      const members = await sampler.listJobProcessIds(session.jobId)
      if (members.length === 0) {
        break
      }
      await delay(TREE_POLL_MS)
    }
    if (Date.now() >= deadline) {
      throw new Error(`${session.shell.name} left live members in its owned process job`)
    }
  }
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) {
    throw new Error(`${session.shell.name} process identity did not exit before the deadline`)
  }
  await waitForProcessTreeExit(
    session.pid,
    session.creationTimeMs,
    session.observedProcessIdentities,
    { timeoutMs: remainingMs, intervalMs: TREE_POLL_MS, label: session.shell.name }
  )
}

async function releaseEmptyJob(session: Session, sampler: ProcessMetricsClient): Promise<void> {
  if (session.jobId !== null && !session.jobReleased) {
    await sampler.releaseJob(session.jobId)
    session.jobReleased = true
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out')), timeoutMs)
      })
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}
