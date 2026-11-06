import { resolve } from 'node:path'
import type { ProcessIdentity } from './process-tree-identity'
import { processIdentity } from './process-tree-identity'
import {
  readTrees,
  treeSignature,
  validateTree,
  waitForStableTrees,
  type TreeSnapshot
} from './runtime-process-trees'
import {
  MAX_METRICS_REQUEST_TIMEOUT_MS,
  type ProcessMetricsClient,
  type ProcessMetrics
} from './process-metrics-client'
import {
  collectStableResourceWindow,
  defaultResourceWindowClock,
  type NamedProcessIdentity,
  type ResourceSample,
  type ResourceWindowSnapshot
} from './runtime-resource-window'
import type { Session } from './runtime-shell-session'
import type { RuntimeMode } from './runtime-environment'

export type { ResourceSample } from './runtime-resource-window'

export type RunSummary = {
  shell: string
  mode: RuntimeMode
  sessionCount: number
  pairId: number
  startupMs: number[]
  jobGateSetupMs: number[]
  resourceWindowRestarts: number
  resourceWindowRestartWaitMs: number
  cleanupMs: number
  samples: ResourceSample[]
  idleCpuCorePercent: number
}

function aggregateMetrics(
  snapshots: TreeSnapshot[],
  measurements: ProcessMetrics[],
  nativeExecutable: string
): ResourceSample {
  const byIdentity = new Map(measurements.map((row) => [`${row.pid}:${row.creationTimeMs}`, row]))
  const expected = snapshots.flatMap((snapshot) => snapshot.rows.map(processIdentity))
  if (byIdentity.size !== expected.length) {
    throw new Error('Metrics did not cover the complete process tree')
  }
  const selected = expected.map((identity) => {
    const measured = byIdentity.get(`${identity.pid}:${identity.creationTimeMs}`)
    if (!measured) {
      throw new Error('A process metric did not match its PID creation time')
    }
    return measured
  })
  const nativePath = normalizeImagePath(nativeExecutable)
  for (const snapshot of snapshots) {
    const codexRows = snapshot.descendants.filter((row) => row.name.toLowerCase() === 'codex.exe')
    for (const codexRow of codexRows) {
      const measured = byIdentity.get(`${codexRow.pid}:${codexRow.creationTimeMs}`)
      if (!measured || normalizeImagePath(measured.imagePath) !== nativePath) {
        throw new Error(
          'A sampled Codex executable did not match the installed native package path'
        )
      }
    }
  }
  return {
    privateBytes: sum(selected.map((row) => row.privateBytes)),
    workingSetBytes: sum(selected.map((row) => row.workingSetBytes)),
    handleCount: sum(selected.map((row) => row.handleCount)),
    nodeCount: snapshots
      .flatMap((snapshot) => snapshot.descendants)
      .filter((row) => row.name.toLowerCase() === 'node.exe').length,
    cmdCount: snapshots
      .flatMap((snapshot) => snapshot.descendants)
      .filter((row) => row.name.toLowerCase() === 'cmd.exe').length,
    cpu100ns: sum(selected.map((row) => row.kernel100ns + row.user100ns))
  }
}

export async function collectResources(
  sessions: Session[],
  sampler: ProcessMetricsClient,
  nativeExecutable: string
): Promise<{
  samples: ResourceSample[]
  idleCpuCorePercent: number
  windowRestarts: number
  restartSettleMs: number
}> {
  const clock = defaultResourceWindowClock()
  const read = async (timeoutMs: number): Promise<ResourceWindowSnapshot> => {
    const snapshots = await readTrees(sessions, sampler, timeoutMs)
    for (const snapshot of snapshots) {
      validateTree(snapshot)
    }
    return toResourceWindowSnapshot(snapshots, nativeExecutable)
  }
  const result = await collectStableResourceWindow({
    settle: async (timeoutMs) =>
      toResourceWindowSnapshot(
        await waitForStableTrees(sessions, sampler, timeoutMs),
        nativeExecutable
      ),
    read,
    sample: (identities, timeoutMs) => sampler.sample(identities, metricsRequestTimeout(timeoutMs)),
    ...clock
  })
  return {
    samples: result.samples,
    idleCpuCorePercent: result.idleCpuCorePercent,
    windowRestarts: result.restarts,
    restartSettleMs: result.restartSettleMs
  }
}

function metricsRequestTimeout(timeoutMs: number): number {
  const boundedTimeout = Math.floor(timeoutMs)
  if (boundedTimeout <= 0) {
    throw new Error('Codex metrics request deadline was empty')
  }
  return Math.min(MAX_METRICS_REQUEST_TIMEOUT_MS, boundedTimeout)
}

function toResourceWindowSnapshot(
  snapshots: TreeSnapshot[],
  nativeExecutable: string
): ResourceWindowSnapshot {
  const first = snapshots[0]
  if (!first) {
    throw new Error('Cannot measure an empty Codex process tree')
  }
  const processes: NamedProcessIdentity[] = []
  const criticalProcesses: NamedProcessIdentity[] = []
  for (const snapshot of snapshots) {
    const root = snapshot.rows[0]
    if (!root) {
      throw new Error(`${snapshot.session.shell.name} process root was absent from its snapshot`)
    }
    const rootIdentity = processIdentity(root)
    const rootProcess = { name: root.name, identity: rootIdentity }
    criticalProcesses.push(rootProcess)
    for (const row of snapshot.rows) {
      processes.push({ name: row.name, identity: processIdentity(row) })
    }
    for (const row of snapshot.descendants) {
      const name = row.name.toLowerCase()
      if (name === 'codex.exe' || name === 'node.exe') {
        criticalProcesses.push({ name: row.name, identity: processIdentity(row) })
      }
    }
  }
  const identities: ProcessIdentity[] = processes.map(({ identity }) => identity)
  return {
    shell: first.session.shell.name,
    mode: first.session.mode,
    signature: treeSignature(snapshots),
    processes,
    criticalProcesses,
    identities,
    measure: (metrics) => aggregateMetrics(snapshots, metrics, nativeExecutable)
  }
}

function normalizeImagePath(value: string): string {
  return resolve(value)
    .replace(/[\\/]+/g, '\\')
    .toLowerCase()
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}
