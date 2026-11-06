import { performance } from 'node:perf_hooks'
import { readWindowsProcessIdentityTableFresh } from '../../../src/main/windows/windows-process-table'
import { processIdentity, processTreeForRoot } from './process-tree-identity'
import type { ProcessMetricsClient } from './process-metrics-client'
import type { ProcessIdentity } from './process-tree-identity'
import type { RuntimeShell } from './runtime-environment'
import type { Session } from './runtime-shell-session'

const LAUNCH_GATE_TOKEN = 'ORCA_RUNTIME_JOB_READY'

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
