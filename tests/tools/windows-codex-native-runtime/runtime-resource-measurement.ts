import { performance } from 'node:perf_hooks'
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
import type { ProcessMetricsClient, ProcessMetrics } from './process-metrics-client'
import type { Session } from './runtime-shell-session'
import type { RuntimeMode } from './runtime-environment'

const IDLE_SAMPLE_COUNT = 4
const IDLE_SAMPLE_INTERVAL_MS = 1_000

export type ResourceSample = {
  privateBytes: number
  workingSetBytes: number
  handleCount: number
  nodeCount: number
  cmdCount: number
  cpu100ns: number
}

export type RunSummary = {
  shell: string
  mode: RuntimeMode
  sessionCount: number
  pairId: number
  startupMs: number[]
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
): Promise<{ samples: ResourceSample[]; idleCpuCorePercent: number }> {
  await waitForStableTrees(sessions)
  const samples: ResourceSample[] = []
  let totalCpu100ns = 0
  let totalWallMs = 0
  let previousCpu100ns: number | undefined
  let previousSampledAt: number | undefined
  let previousKeys = ''
  for (let index = 0; index < IDLE_SAMPLE_COUNT; index++) {
    if (index > 0) {
      await delay(IDLE_SAMPLE_INTERVAL_MS)
    }
    const snapshots = await readTrees(sessions)
    for (const snapshot of snapshots) {
      validateTree(snapshot)
    }
    const keys = treeSignature(snapshots)
    if (previousKeys && keys !== previousKeys) {
      throw new Error('The settled Codex process tree changed during resource sampling')
    }
    const identities: ProcessIdentity[] = snapshots.flatMap((snapshot) =>
      snapshot.rows.map(processIdentity)
    )
    const current = aggregateMetrics(snapshots, await sampler.sample(identities), nativeExecutable)
    const sampledAt = performance.now()
    if (previousCpu100ns !== undefined && previousSampledAt !== undefined) {
      const cpuDelta = current.cpu100ns - previousCpu100ns
      if (cpuDelta < 0) {
        throw new Error('Codex CPU counters moved backwards')
      }
      totalCpu100ns += cpuDelta
      totalWallMs += sampledAt - previousSampledAt
    }
    samples.push(current)
    previousCpu100ns = current.cpu100ns
    previousSampledAt = sampledAt
    previousKeys = keys
  }
  if (totalWallMs <= 0) {
    throw new Error('Idle CPU sample duration was empty')
  }
  return { samples, idleCpuCorePercent: (totalCpu100ns / 10_000 / totalWallMs) * 100 }
}

function normalizeImagePath(value: string): string {
  return resolve(value)
    .replace(/[\\/]+/g, '\\')
    .toLowerCase()
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}
