import type { ProcessMetricsIncompleteError } from './process-metric-failure'
import type { ProcessIdentity } from './process-tree-identity'
import type {
  NamedProcessIdentity,
  ResourceWindowDependencies,
  ResourceWindowSnapshot
} from './runtime-resource-window'

type TreeState = 'unchanged' | 'peripheral-change' | 'critical-change' | 'unavailable'
type RecoveryClassification =
  | 'eligible'
  | 'malformed-request'
  | 'malformed-snapshot'
  | 'critical-mismatch'
  | 'failed-identity-still-present'
  | 'failed-pid-reused'
  | 'retained-identity-renamed'
  | 'unchanged'
  | 'unavailable'
type RecoveryOutcome = 'restart' | 'restart-cap' | 'deadline' | 'rejected'
export type FailedSampleTreeDiagnostic = {
  snapshot?: ResourceWindowSnapshot
  outcome: RecoveryOutcome
}

export async function reportFailedSampleDiagnostic(
  error: ProcessMetricsIncompleteError,
  dependencies: ResourceWindowDependencies,
  deadline: number,
  baselineCritical: NamedProcessIdentity[],
  previous: ResourceWindowSnapshot,
  restartCount: number,
  restartCap: number
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
  const assessment = currentSnapshot
    ? classifyFailedPeripheralDrift(error, baselineCritical, previous, currentSnapshot)
    : 'unavailable'
  const isMalformed = assessment === 'malformed-request' || assessment === 'malformed-snapshot'
  const classification: RecoveryClassification = isMalformed
    ? assessment
    : treeState === 'unavailable'
      ? 'unavailable'
      : treeState === 'critical-change' || assessment === 'critical-mismatch'
        ? 'critical-mismatch'
        : treeState === 'unchanged' && assessment === 'eligible'
          ? 'unchanged'
          : assessment
  const eligible = treeState === 'peripheral-change' && classification === 'eligible'
  const deadlineExpired = dependencies.now() >= deadline
  const outcome: RecoveryOutcome = deadlineExpired
    ? 'deadline'
    : eligible
      ? restartCount >= restartCap
        ? 'restart-cap'
        : 'restart'
      : 'rejected'
  const shell = ['Git Bash', 'PowerShell 7', 'Windows PowerShell'].includes(previous.shell)
    ? previous.shell
    : 'other'
  try {
    console.error(
      `Windows Codex process metric failure: shell=${shell} mode=${previous.mode}` +
        ` operation=${error.operation} measured=${safeCount(error.measuredCount)}/${safeCount(error.expectedCount)}` +
        ` error=${safeErrorCode(error.errorCode)} tree=${treeState}` +
        ` classification=${classification} restarts=${safeCount(restartCount)}/${safeCount(restartCap)}` +
        ` outcome=${outcome}`
    )
  } catch {
    // Keep diagnostics from replacing the original fail-closed metric error.
  }
  return { snapshot: currentSnapshot, outcome }
}

function classifyFailedPeripheralDrift(
  error: ProcessMetricsIncompleteError,
  baselineCritical: NamedProcessIdentity[],
  previous: ResourceWindowSnapshot,
  current: ResourceWindowSnapshot
): RecoveryClassification {
  const previousIdentities = previous.processes.map(({ identity }) => identity)
  const currentIdentities = current.processes.map(({ identity }) => identity)
  if (
    !Number.isSafeInteger(error.expectedCount) ||
    !Number.isSafeInteger(error.measuredCount) ||
    !Number.isSafeInteger(error.failedIdentityCount) ||
    error.expectedCount <= 0 ||
    error.measuredCount < 0 ||
    error.measuredCount >= error.expectedCount ||
    error.failedIdentityCount <= 0
  ) {
    return 'malformed-request'
  }
  if (
    !hasUniqueIdentities(previous.identities) ||
    !hasUniqueIdentities(current.identities) ||
    !hasUniqueNamedIdentities(previous.processes) ||
    !hasUniqueNamedIdentities(current.processes) ||
    !hasUniqueNamedIdentities(baselineCritical) ||
    !hasUniqueNamedIdentities(previous.criticalProcesses) ||
    !hasUniqueNamedIdentities(current.criticalProcesses)
  ) {
    return 'malformed-snapshot'
  }
  if (
    error.expectedCount !== previous.identities.length ||
    error.expectedCount - error.measuredCount !== error.failedIdentityCount ||
    !error.matchesFailedIdentities(
      previous.identities.filter((identity) => error.matchesFailedIdentity(identity))
    )
  ) {
    return 'malformed-request'
  }
  if (
    !sameIdentitySet(previous.identities, previousIdentities) ||
    !sameIdentitySet(current.identities, currentIdentities) ||
    !containsNamedIdentities(previous.processes, previous.criticalProcesses) ||
    !containsNamedIdentities(current.processes, current.criticalProcesses)
  ) {
    return 'malformed-snapshot'
  }
  if (
    !sameNamedIdentities(baselineCritical, previous.criticalProcesses) ||
    !sameNamedIdentities(baselineCritical, current.criticalProcesses)
  ) {
    return 'critical-mismatch'
  }

  const failedInRequest = previous.identities.filter((identity) =>
    error.matchesFailedIdentity(identity)
  )
  const failedInPrevious = previous.processes
    .filter(({ identity }) => error.matchesFailedIdentity(identity))
    .map(({ identity }) => identity)
  if (!error.matchesFailedIdentities(failedInPrevious)) {
    return 'malformed-snapshot'
  }
  if (baselineCritical.some(({ identity }) => error.matchesFailedIdentity(identity))) {
    return 'critical-mismatch'
  }

  for (const failedIdentity of failedInRequest) {
    const currentProcess = current.processes.find(
      ({ identity }) => identity.pid === failedIdentity.pid
    )
    if (currentProcess) {
      return currentProcess.identity.creationTimeMs === failedIdentity.creationTimeMs
        ? 'failed-identity-still-present'
        : 'failed-pid-reused'
    }
  }

  const before = namedIdentityMap(previous.processes)
  const after = namedIdentityMap(current.processes)
  for (const [key, process] of before) {
    const currentProcess = after.get(key)
    if (currentProcess && currentProcess.name !== process.name) {
      return 'retained-identity-renamed'
    }
  }
  return 'eligible'
}

function hasUniqueIdentities(identities: ProcessIdentity[]): boolean {
  const pids = new Set<number>()
  const keys = new Set<string>()
  for (const identity of identities) {
    const key = identityKey(identity)
    if (pids.has(identity.pid) || keys.has(key)) {
      return false
    }
    pids.add(identity.pid)
    keys.add(key)
  }
  return true
}

function hasUniqueNamedIdentities(processes: NamedProcessIdentity[]): boolean {
  return hasUniqueIdentities(processes.map(({ identity }) => identity))
}

function sameIdentitySet(left: ProcessIdentity[], right: ProcessIdentity[]): boolean {
  if (left.length !== right.length) {
    return false
  }
  const rightKeys = new Set(right.map(identityKey))
  return (
    rightKeys.size === right.length &&
    left.every((identity) => rightKeys.has(identityKey(identity)))
  )
}

function containsNamedIdentities(
  processes: NamedProcessIdentity[],
  required: NamedProcessIdentity[]
): boolean {
  const namesByIdentity = new Map(
    processes.map(({ identity, name }) => [identityKey(identity), name])
  )
  return required.every(({ identity, name }) => namesByIdentity.get(identityKey(identity)) === name)
}

function sameNamedIdentities(
  before: NamedProcessIdentity[],
  after: NamedProcessIdentity[]
): boolean {
  if (before.length !== after.length) {
    return false
  }
  const current = new Map(after.map(({ identity, name }) => [identityKey(identity), name]))
  return before.every(({ identity, name }) => current.get(identityKey(identity)) === name)
}

function namedIdentityMap(processes: NamedProcessIdentity[]): Map<string, NamedProcessIdentity> {
  return new Map(processes.map((process) => [identityKey(process.identity), process]))
}

function identityKey(identity: ProcessIdentity): string {
  return `${identity.pid}:${identity.creationTimeMs}`
}

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 4096) : 0
}

function safeErrorCode(value: number | null): number | 'n/a' {
  return value !== null && Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff
    ? value
    : 'n/a'
}
