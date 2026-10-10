import { recordCoalescedDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'
import { drainGitExecWindow } from '../observability/git-exec-window-aggregate'
import { startSpan } from '../observability/tracer'
import { terminalInputLatency } from './terminal-input-latency'
import type { SubprocessSpawnStats } from './main-thread-churn-probe'

export const MAIN_LOOP_WINDOW_MS = 60_000
export const MAIN_LOOP_STALL_BREADCRUMB_MS = 1_000
const MAIN_LOOP_STALL_COALESCE_MS = 10_000
const TOP_SPAWN_KEYS = 5

export type GapCounter = { maxGapMs: number; gapsOver50Ms: number; gapsOver250Ms: number }

export function newGapCounter(): GapCounter {
  return { maxGapMs: 0, gapsOver50Ms: 0, gapsOver250Ms: 0 }
}

export function recordGap(counter: GapCounter, gapMs: number): void {
  counter.maxGapMs = Math.max(counter.maxGapMs, gapMs)
  if (gapMs > 50) {
    counter.gapsOver50Ms++
  }
  if (gapMs > 250) {
    counter.gapsOver250Ms++
  }
}

export function resetGapCounter(counter: GapCounter): void {
  Object.assign(counter, newGapCounter())
}

export function mergeSpawnStats(
  into: Record<string, SubprocessSpawnStats>,
  from: Record<string, SubprocessSpawnStats>
): void {
  for (const [key, stats] of Object.entries(from)) {
    const existing = into[key]
    into[key] = existing
      ? {
          count: existing.count + stats.count,
          blockMsTotal: Math.round((existing.blockMsTotal + stats.blockMsTotal) * 100) / 100,
          blockMsMax: Math.max(existing.blockMsMax, stats.blockMsMax)
        }
      : { ...stats }
  }
}

export function recordMainLoopStall(gapMs: number): void {
  if (gapMs < MAIN_LOOP_STALL_BREADCRUMB_MS) {
    return
  }
  recordCoalescedDurableCrashBreadcrumb({
    name: 'main_loop_stall',
    data: { gapMs: Math.round(gapMs) },
    coalesceKey: 'main_loop_stall',
    minIntervalMs: MAIN_LOOP_STALL_COALESCE_MS
  })
}

/** One span per window; started at window end because the trace sink may not exist at probe start. */
export function emitMainLoopSpan(
  windowMs: number,
  gaps: GapCounter,
  spawns: Record<string, SubprocessSpawnStats>
): void {
  const entries = Object.entries(spawns)
  const span = startSpan('main.loop', { attributes: { kind: 'main-loop' } })
  span.setAttribute('windowMs', Math.round(windowMs))
  span.setAttribute('maxGapMs', Math.max(0, Math.round(gaps.maxGapMs)))
  span.setAttribute('gapsOver50Ms', gaps.gapsOver50Ms)
  span.setAttribute('gapsOver250Ms', gaps.gapsOver250Ms)
  span.setAttribute(
    'spawnCount',
    entries.reduce((sum, [, s]) => sum + s.count, 0)
  )
  span.setAttribute(
    'spawnBlockMsTotal',
    Math.round(entries.reduce((sum, [, s]) => sum + s.blockMsTotal, 0))
  )
  span.setAttribute(
    'spawnBlockMsMax',
    Math.round(Math.max(0, ...entries.map(([, s]) => s.blockMsMax)))
  )
  const top = entries.sort((a, b) => b[1].count - a[1].count).slice(0, TOP_SPAWN_KEYS)
  for (const [key, stats] of top) {
    // "git status" -> spawns.git.status
    span.setAttribute(`spawns.${key.replace(/ /g, '.')}`, stats.count)
  }
  for (const [key, value] of Object.entries(terminalInputLatency.drain())) {
    span.setAttribute(`terminalInput.${key}`, value)
  }
  for (const [subcommand, stats] of Object.entries(drainGitExecWindow())) {
    span.setAttribute(`git.${subcommand}.count`, stats.count)
    span.setAttribute(`git.${subcommand}.execMsSum`, stats.execMsSum)
  }
  span.end()
}
