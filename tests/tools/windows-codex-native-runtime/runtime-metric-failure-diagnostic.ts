import type { ProcessMetricsIncompleteError } from './process-metrics-protocol'
import type {
  NamedProcessIdentity,
  ResourceWindowDependencies,
  ResourceWindowSnapshot
} from './runtime-resource-window'

type TreeState = 'unchanged' | 'peripheral-change' | 'critical-change' | 'unavailable'

export async function reportFailedSampleDiagnostic(
  error: ProcessMetricsIncompleteError,
  dependencies: ResourceWindowDependencies,
  deadline: number,
  baselineCritical: NamedProcessIdentity[],
  previous: ResourceWindowSnapshot
): Promise<void> {
  let treeState: TreeState = 'unavailable'
  try {
    const remainingMs = deadline - dependencies.now()
    if (remainingMs > 0) {
      const current = await dependencies.read(remainingMs)
      if (dependencies.now() < deadline) {
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

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 4096) : 0
}

function safeErrorCode(value: number | null): number | 'n/a' {
  return value !== null && Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff
    ? value
    : 'n/a'
}
