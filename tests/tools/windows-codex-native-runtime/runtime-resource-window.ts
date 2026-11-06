import { performance } from 'node:perf_hooks'
import type { ProcessIdentity } from './process-tree-identity'
import type { ProcessMetrics } from './process-metrics-protocol'
import { ProcessMetricsIncompleteError } from './process-metric-failure'
import type { RuntimeMode } from './runtime-environment'
import {
  isExactFailedPeripheralRemoval,
  reportFailedSampleDiagnostic
} from './runtime-metric-failure-diagnostic'

const SAMPLE_COUNT = 4
const SAMPLE_INTERVAL_MS = 1_000
const WINDOW_DEADLINE_MS = 60_000
const MAX_WINDOW_RESTARTS = 3
const MAX_DIAGNOSTIC_NAMES = 8

export type ResourceSample = {
  privateBytes: number
  workingSetBytes: number
  handleCount: number
  nodeCount: number
  cmdCount: number
  cpu100ns: number
}

export type NamedProcessIdentity = {
  name: string
  identity: ProcessIdentity
}

export type ResourceWindowSnapshot = {
  shell: string
  mode: RuntimeMode
  signature: string
  processes: NamedProcessIdentity[]
  criticalProcesses: NamedProcessIdentity[]
  identities: ProcessIdentity[]
  measure: (metrics: ProcessMetrics[]) => ResourceSample
}

export type ResourceWindowDependencies = {
  settle: (timeoutMs: number) => Promise<ResourceWindowSnapshot>
  read: (timeoutMs: number) => Promise<ResourceWindowSnapshot>
  sample: (identities: ProcessIdentity[], timeoutMs: number) => Promise<ProcessMetrics[]>
  now: () => number
  delay: (milliseconds: number) => Promise<void>
}

export type ResourceWindowResult = {
  samples: ResourceSample[]
  idleCpuCorePercent: number
  restarts: number
  restartSettleMs: number
}

export async function collectStableResourceWindow(
  dependencies: ResourceWindowDependencies
): Promise<ResourceWindowResult> {
  const deadline = dependencies.now() + WINDOW_DEADLINE_MS
  let baselineCritical: NamedProcessIdentity[] | undefined
  let context: { shell: string; mode: RuntimeMode } | undefined
  let restarts = 0
  let restartSettleMs = 0
  let lastChange = 'removed=[] added=[]'

  while (true) {
    const remainingMs = deadline - dependencies.now()
    if (remainingMs <= 0) {
      throw windowFailure('deadline expired', context, lastChange, restarts)
    }
    const settleStartedAt = dependencies.now()
    const settled = await dependencies.settle(remainingMs)
    context ??= { shell: settled.shell, mode: settled.mode }
    if (dependencies.now() >= deadline) {
      throw windowFailure('deadline expired while settling', context, lastChange, restarts)
    }
    if (!baselineCritical) {
      baselineCritical = settled.criticalProcesses
    } else {
      assertCriticalIdentities(baselineCritical, settled)
      restartSettleMs += dependencies.now() - settleStartedAt
    }

    const samples: ResourceSample[] = []
    let totalCpu100ns = 0
    let totalWallMs = 0
    let previousCpu100ns: number | undefined
    let previousSampledAt: number | undefined
    let previous = settled
    let restartWindow = false

    for (let index = 0; index < SAMPLE_COUNT; index++) {
      if (index > 0) {
        const remaining = deadline - dependencies.now()
        if (remaining <= 0) {
          throw windowFailure('deadline expired during sampling', context, lastChange, restarts)
        }
        await dependencies.delay(Math.min(SAMPLE_INTERVAL_MS, remaining))
        if (dependencies.now() >= deadline) {
          throw windowFailure('deadline expired during sampling', context, lastChange, restarts)
        }

        const remainingForRead = deadline - dependencies.now()
        if (remainingForRead <= 0) {
          throw windowFailure(
            'deadline expired before tree verification',
            context,
            lastChange,
            restarts
          )
        }
        const current = await dependencies.read(remainingForRead)
        if (dependencies.now() >= deadline) {
          throw windowFailure(
            'deadline expired during tree verification',
            context,
            lastChange,
            restarts
          )
        }
        const changedTree = processTreeChange(baselineCritical, previous, current)
        if (changedTree !== null) {
          lastChange = changedTree
          if (restarts >= MAX_WINDOW_RESTARTS || dependencies.now() >= deadline) {
            throw windowFailure('process membership kept changing', context, lastChange, restarts)
          }
          restarts++
          restartWindow = true
          break
        }
        previous = current
      }

      const remainingForSample = deadline - dependencies.now()
      if (remainingForSample <= 0) {
        throw windowFailure('deadline expired during sampling', context, lastChange, restarts)
      }
      let measured: ProcessMetrics[]
      try {
        measured = await dependencies.sample(previous.identities, remainingForSample)
      } catch (error) {
        if (!(error instanceof ProcessMetricsIncompleteError)) {
          throw error
        }
        const treeDiagnostic = await reportFailedSampleDiagnostic(
          error,
          dependencies,
          deadline,
          baselineCritical ?? previous.criticalProcesses,
          previous
        )
        if (
          treeDiagnostic.state === 'peripheral-change' &&
          treeDiagnostic.snapshot &&
          isExactFailedPeripheralRemoval(
            error,
            baselineCritical ?? previous.criticalProcesses,
            previous,
            treeDiagnostic.snapshot
          )
        ) {
          lastChange = identityDelta(previous.processes, treeDiagnostic.snapshot.processes)
          if (restarts >= MAX_WINDOW_RESTARTS || dependencies.now() >= deadline) {
            throw error
          }
          restarts++
          restartWindow = true
          break
        }
        throw error
      }
      if (dependencies.now() >= deadline) {
        throw windowFailure('deadline expired during sampling', context, lastChange, restarts)
      }
      const current = previous.measure(measured)
      const sampledAt = dependencies.now()
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

      if (index === SAMPLE_COUNT - 1) {
        const remainingForVerification = deadline - dependencies.now()
        if (remainingForVerification <= 0) {
          throw windowFailure(
            'deadline expired before final verification',
            context,
            lastChange,
            restarts
          )
        }
        const finalSnapshot = await dependencies.read(remainingForVerification)
        if (dependencies.now() >= deadline) {
          throw windowFailure(
            'deadline expired during final verification',
            context,
            lastChange,
            restarts
          )
        }
        const changedTree = processTreeChange(baselineCritical, previous, finalSnapshot)
        if (changedTree !== null) {
          lastChange = changedTree
          if (restarts >= MAX_WINDOW_RESTARTS) {
            throw windowFailure('process membership kept changing', context, lastChange, restarts)
          }
          restarts++
          restartWindow = true
          break
        }
      }
    }

    if (restartWindow) {
      continue
    }
    if (samples.length !== SAMPLE_COUNT || totalWallMs <= 0) {
      throw new Error('Idle CPU sample window was incomplete')
    }
    return {
      samples,
      idleCpuCorePercent: (totalCpu100ns / 10_000 / totalWallMs) * 100,
      restarts,
      restartSettleMs
    }
  }
}

function processTreeChange(
  baselineCritical: NamedProcessIdentity[],
  previous: ResourceWindowSnapshot,
  current: ResourceWindowSnapshot
): string | null {
  assertCriticalIdentities(baselineCritical, current)
  return current.signature === previous.signature
    ? null
    : identityDelta(previous.processes, current.processes)
}

function assertCriticalIdentities(
  baseline: NamedProcessIdentity[],
  current: ResourceWindowSnapshot
): void {
  const delta = identityDelta(baseline, current.criticalProcesses)
  if (delta !== 'removed=[] added=[]') {
    throw new Error(`${current.shell} ${current.mode} critical process identity changed; ${delta}`)
  }
}

function identityDelta(before: NamedProcessIdentity[], after: NamedProcessIdentity[]): string {
  const beforeByIdentity = identityNameMap(before)
  const afterByIdentity = identityNameMap(after)
  const removed = [...beforeByIdentity]
    .filter(([identity, name]) => afterByIdentity.get(identity) !== name)
    .map(([, name]) => name)
  const added = [...afterByIdentity]
    .filter(([identity, name]) => beforeByIdentity.get(identity) !== name)
    .map(([, name]) => name)
  return `removed=${formatNames(removed)} added=${formatNames(added)}`
}

function identityNameMap(processes: NamedProcessIdentity[]): Map<string, string> {
  return new Map(
    processes.map(({ identity, name }) => [
      `${identity.pid}:${identity.creationTimeMs}`,
      safeProcessName(name)
    ])
  )
}

function formatNames(names: string[]): string {
  const sorted = names.sort()
  const shown = sorted.slice(0, MAX_DIAGNOSTIC_NAMES)
  const omitted = sorted.length - shown.length
  return `[${shown.join(',')}${omitted > 0 ? `,+${omitted}` : ''}]`
}

function safeProcessName(name: string): string {
  const basename = name.split(/[\\/]/u).at(-1) ?? ''
  return /^[A-Za-z0-9_.-]{1,64}$/u.test(basename) ? basename : 'other'
}

function windowFailure(
  reason: string,
  context: { shell: string; mode: RuntimeMode } | undefined,
  lastChange: string,
  restarts: number
): Error {
  return new Error(
    `${context?.shell ?? 'Windows shell'} ${context?.mode ?? 'unknown'} resource window ${reason} after ${restarts} restarts; ${lastChange}`
  )
}

export function defaultResourceWindowClock(): Pick<ResourceWindowDependencies, 'now' | 'delay'> {
  return {
    now: () => performance.now(),
    delay: (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
  }
}
