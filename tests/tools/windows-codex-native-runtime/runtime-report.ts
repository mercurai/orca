import type { ResourceSample, RunSummary } from './runtime-resource-measurement'
import type { RuntimeMode } from './runtime-environment'

export function summarizeRuns(runs: RunSummary[]): unknown[] {
  const groups = new Map<string, RunSummary[]>()
  for (const run of runs) {
    const key = `${run.shell}|${run.sessionCount}|${run.mode}`
    groups.set(key, [...(groups.get(key) ?? []), run])
  }
  return [...groups.values()].map((group) => {
    const first = group[0]
    if (!first) {
      throw new Error('Runtime summary group was empty')
    }
    const sampleFor = (run: RunSummary, key: keyof ResourceSample): number[] =>
      run.samples.map((sample) => Number(sample[key] ?? 0))
    const startup = group.flatMap((run) => run.startupMs)
    const jobGateSetup = group.flatMap((run) => run.jobGateSetupMs)
    const privateBytes = group.flatMap((run) => sampleFor(run, 'privateBytes'))
    const workingSetBytes = group.flatMap((run) => sampleFor(run, 'workingSetBytes'))
    const handles = group.flatMap((run) => sampleFor(run, 'handleCount'))
    const nodeCount = group.flatMap((run) => sampleFor(run, 'nodeCount'))
    const cmdCount = group.flatMap((run) => sampleFor(run, 'cmdCount'))
    const idleCpu = group.map((run) => run.idleCpuCorePercent)
    const cleanup = group.map((run) => run.cleanupMs)
    const windowRestarts = group.map((run) => run.resourceWindowRestarts)
    const restartSettle = group.map((run) => run.resourceWindowRestartWaitMs)
    return {
      shell: first.shell,
      sessions: first.sessionCount,
      mode: first.mode,
      pairedRuns: group.length,
      startupToReadyMs: range(startup),
      jobGateSetupMs: range(jobGateSetup),
      privateCommitBytes: range(privateBytes),
      workingSetBytes: range(workingSetBytes),
      handles: range(handles),
      idleCpuCorePercent: range(idleCpu),
      persistentNodeWrappers: range(nodeCount),
      cmdShims: range(cmdCount),
      resourceWindowRestarts: range(windowRestarts),
      resourceWindowRestartSettleMs: range(restartSettle),
      cleanupMs: range(cleanup),
      sampleCountPerRun: 4,
      sampleIntervalMs: 1_000,
      cpuIntervalsPerRun: 3
    }
  })
}

export function summarizePairedDeltas(runs: RunSummary[]): unknown[] {
  const pairs = new Map<string, Map<number, Partial<Record<RuntimeMode, RunSummary>>>>()
  for (const run of runs) {
    const groupKey = `${run.shell}|${run.sessionCount}`
    const group = pairs.get(groupKey) ?? new Map<number, Partial<Record<RuntimeMode, RunSummary>>>()
    const pair = group.get(run.pairId) ?? {}
    pair[run.mode] = run
    group.set(run.pairId, pair)
    pairs.set(groupKey, group)
  }
  return [...pairs.entries()].map(([groupKey, group]) => {
    const separator = groupKey.indexOf('|')
    const shell = groupKey.slice(0, separator)
    const sessionCount = Number(groupKey.slice(separator + 1))
    const metricDeltas: Record<string, number[]> = {}
    for (const pair of group.values()) {
      if (!pair.native || !pair.optout) {
        throw new Error('Runtime pair is missing one launch mode')
      }
      const nativeValues = runMedians(pair.native)
      const optoutValues = runMedians(pair.optout)
      for (const metric of Object.keys(nativeValues)) {
        const nativeValue = nativeValues[metric]
        const optoutValue = optoutValues[metric]
        if (nativeValue === undefined || optoutValue === undefined) {
          throw new Error('Runtime pair omitted a summarized metric')
        }
        const deltas = metricDeltas[metric] ?? []
        deltas.push(nativeValue - optoutValue)
        metricDeltas[metric] = deltas
      }
    }
    return {
      shell,
      sessions: sessionCount,
      pairedRuns: group.size,
      nativeMinusOptout: Object.fromEntries(
        Object.entries(metricDeltas).map(([metric, values]) => [metric, range(values)])
      )
    }
  })
}

function runMedians(run: RunSummary): Record<string, number> {
  return {
    startupToReadyMs: median(run.startupMs),
    privateCommitBytes: median(run.samples.map((sample) => sample.privateBytes)),
    workingSetBytes: median(run.samples.map((sample) => sample.workingSetBytes)),
    handles: median(run.samples.map((sample) => sample.handleCount)),
    idleCpuCorePercent: run.idleCpuCorePercent,
    persistentNodeWrappers: median(run.samples.map((sample) => sample.nodeCount)),
    cmdShims: median(run.samples.map((sample) => sample.cmdCount)),
    cleanupMs: run.cleanupMs
  }
}

function range(values: number[]): { median: number; min: number; max: number } {
  return {
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values)
  }
}

function median(values: number[]): number {
  if (values.length === 0) {
    throw new Error('Cannot summarize an empty runtime sample')
  }
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const upper = sorted[middle]
  if (upper === undefined) {
    throw new Error('Runtime median index was invalid')
  }
  if (sorted.length % 2 !== 0) {
    return upper
  }
  const lower = sorted[middle - 1]
  if (lower === undefined) {
    throw new Error('Runtime median index was invalid')
  }
  return (lower + upper) / 2
}
