import type { ProcessMetricsIncompleteError } from './process-metric-failure'
import type { ProcessIdentity } from './process-tree-identity'
import type {
  NamedProcessIdentity,
  ResourceWindowDependencies,
  ResourceWindowSnapshot
} from './runtime-resource-window'

type TreeState = 'unchanged' | 'peripheral-change' | 'critical-change' | 'unavailable'
export type FailedSampleTreeDiagnostic = {
  state: TreeState
  snapshot?: ResourceWindowSnapshot
}

export async function reportFailedSampleDiagnostic(
  error: ProcessMetricsIncompleteError,
  dependencies: ResourceWindowDependencies,
  deadline: number,
  baselineCritical: NamedProcessIdentity[],
  previous: ResourceWindowSnapshot
): Promise<FailedSampleTreeDiagnostic> {
  let treeState: TreeState = 'unavailable'
  let currentSnapshot: ResourceWindowSnapshot | undefined
  try {
    const remainingMs = deadline - dependencies.now()
    if (remainingMs > 0) {
      const current = await dependencies.read(remainingMs)
      if (dependencies.now() < deadline) {
        currentSnapshot = current
        if (!sameNamedIdentities(baselineCritical, current.criticalProcesses)) {
          treeState = 'critical-change'
        } else {
          treeState = current.signature === previous.signature ? 'unchanged' : 'peripheral-change'
        }
      }
    }
  } catch {
    treeState = 'unavailable'
  }
  const shell = ['Git Bash', 'PowerShell 7', 'Windows PowerShell'].includes(previous.shell)
    ? previous.shell
    : 'other'
  try {
    console.error(
      `Windows Codex process metric failure: shell=${shell} mode=${previous.mode}` +
        ` operation=${error.operation} measured=${safeCount(error.measuredCount)}/${safeCount(error.expectedCount)}` +
        ` error=${safeErrorCode(error.errorCode)} tree=${treeState}`
    )
  } catch {
    // Keep diagnostics from replacing the original fail-closed metric error.
  }
  return { state: treeState, snapshot: currentSnapshot }
}

export function isExactFailedPeripheralRemoval(
  error: ProcessMetricsIncompleteError,
  baselineCritical: NamedProcessIdentity[],
  previous: ResourceWindowSnapshot,
  current: ResourceWindowSnapshot
): boolean {
  const failedInPrevious = previous.processes
    .filter(({ identity }) => error.matchesFailedIdentity(identity))
    .map(({ identity }) => identity)
  if (
    error.expectedCount !== previous.identities.length ||
    error.expectedCount - error.measuredCount !== error.failedIdentityCount ||
    !sameNamedIdentities(baselineCritical, current.criticalProcesses) ||
    !error.matchesFailedIdentities(failedInPrevious) ||
    baselineCritical.some(({ identity }) => error.matchesFailedIdentity(identity)) ||
    current.processes.some(({ identity }) => error.matchesFailedIdentity(identity))
  ) {
    return false
  }

  const before = namedIdentityMap(previous.processes)
  const after = namedIdentityMap(current.processes)
  if (
    before.size !== previous.processes.length ||
    after.size !== current.processes.length ||
    before.size !== after.size + error.failedIdentityCount
  ) {
    return false
  }
  const removed: ProcessIdentity[] = []
  for (const [key, process] of before) {
    const currentProcess = after.get(key)
    if (!currentProcess) {
      removed.push(process.identity)
    } else if (currentProcess.name !== process.name) {
      return false
    }
  }
  return error.matchesFailedIdentities(removed) && [...after.keys()].every((key) => before.has(key))
}

function sameNamedIdentities(
  before: NamedProcessIdentity[],
  after: NamedProcessIdentity[]
): boolean {
  if (before.length !== after.length) {
    return false
  }
  const current = new Map(
    after.map(({ identity, name }) => [`${identity.pid}:${identity.creationTimeMs}`, name])
  )
  return before.every(
    ({ identity, name }) => current.get(`${identity.pid}:${identity.creationTimeMs}`) === name
  )
}

function namedIdentityMap(processes: NamedProcessIdentity[]): Map<string, NamedProcessIdentity> {
  return new Map(
    processes.map((process) => [
      `${process.identity.pid}:${process.identity.creationTimeMs}`,
      process
    ])
  )
}

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 4096) : 0
}

function safeErrorCode(value: number | null): number | 'n/a' {
  return value !== null && Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff
    ? value
    : 'n/a'
}
