import { performance } from 'node:perf_hooks'
import type { ProcessMetricsClient } from './process-metrics-client'
import { readTrees, treeSignature, validateTree, type TreeSnapshot } from './runtime-process-trees'
import type { Session } from './runtime-shell-session'

const TREE_SETTLE_MS = 3_000
const TREE_POLL_MS = 200
const TREE_MAX_OBSERVATION_GAP_MS = 1_000
const TREE_WAIT_MS = 15_000

export type TreeWaitDependencies = {
  now?: () => number
  read?: typeof readTrees
  delay?: typeof delay
}

export async function waitForStableTrees(
  sessions: Session[],
  sampler: Pick<ProcessMetricsClient, 'listJobProcessIds'>,
  timeoutMs = TREE_WAIT_MS,
  dependencies: TreeWaitDependencies = {}
): Promise<TreeSnapshot[]> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Codex process tree settle deadline was empty')
  }
  const { now = () => performance.now(), read = readTrees, delay: pause = delay } = dependencies
  const deadline = now() + Math.min(TREE_WAIT_MS, timeoutMs)
  let previous: string | undefined
  let previousObservedAt: number | undefined
  let stableSince: number | undefined
  while (now() < deadline) {
    const remainingMs = deadline - now()
    const snapshots = await read(sessions, sampler, remainingMs)
    if (now() >= deadline) {
      break
    }
    for (const snapshot of snapshots) {
      validateTree(snapshot)
    }
    const signature = treeSignature(snapshots)
    const sampledAt = now()
    if (sampledAt >= deadline) {
      break
    }
    const observationGap = previousObservedAt === undefined ? 0 : sampledAt - previousObservedAt
    previousObservedAt = sampledAt
    if (signature !== previous || observationGap > TREE_MAX_OBSERVATION_GAP_MS) {
      previous = signature
      stableSince = sampledAt
    } else if (stableSince !== undefined && sampledAt - stableSince >= TREE_SETTLE_MS) {
      return snapshots
    }
    const pollRemainingMs = deadline - now()
    if (pollRemainingMs > 0) {
      await pause(Math.min(TREE_POLL_MS, pollRemainingMs))
    }
  }
  throw new Error('Codex process trees did not reach a settled state')
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}
