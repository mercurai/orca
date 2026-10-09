import { writeStartupDiagnosticLine } from '../startup/startup-diagnostics'
import {
  MAIN_LOOP_WINDOW_MS,
  emitMainLoopSpan,
  mergeSpawnStats,
  newGapCounter,
  recordGap,
  recordMainLoopStall,
  resetGapCounter
} from './main-loop-span'

export const MAIN_THREAD_DIAGNOSTICS_ENV = 'ORCA_MAIN_THREAD_DIAGNOSTICS'

// Why: 25ms mirrors event-loop-stall-probe — a timer that fires late by N ms
// proves the main thread was blocked for N ms, which is the direct in-process
// measurement of the macOS "Performance Diagnostics" main-thread warnings
// reported in issue #7576.
const TICK_MS = 25
const REPORT_EVERY_MS = 5_000

export function isMainThreadDiagnosticsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MAIN_THREAD_DIAGNOSTICS_ENV] === '1'
}

// Git global options that precede the subcommand. Value-taking flags must be
// skipped together with their value to find the real subcommand.
const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--exec-path'])

// Why: only subcommand-style CLIs get a "<binary> <subcommand>" bucket; for
// anything else (rg, node, …) the first positional is an operand, not a
// subcommand, and would fragment the aggregation.
const SUBCOMMAND_BINARIES = new Set(['git', 'gh', 'glab'])

/**
 * Reduce a resolved spawn to a stable aggregation key like "git status" or
 * "gh api". Handles WSL wrapping (`wsl.exe -d <distro> -- git …`), absolute
 * binary paths, `.exe` suffixes, and git global flags before the subcommand.
 */
// Split on both separators so Windows-style paths classify correctly even
// when the classifier itself runs in a posix test environment.
function binaryName(command: string): string {
  const leaf = command.split(/[\\/]/).pop() ?? command
  return leaf.replace(/\.exe$/i, '').toLowerCase()
}

export function classifySubprocessCommand(command: string, args: readonly string[]): string {
  let binary = binaryName(command)
  const rest = [...args]
  if (binary === 'wsl') {
    // Orca spawns guest commands with `--exec`; `--`/`-e` still appear on
    // wsl.exe processes started outside Orca, so unwrap either separator.
    while (rest.length > 0) {
      const arg = rest.shift()
      if (arg === '--' || arg === '--exec' || arg === '-e') {
        break
      }
    }
    const unwrapped = rest.shift()
    if (!unwrapped) {
      return 'wsl'
    }
    binary = binaryName(unwrapped)
  }
  if (!SUBCOMMAND_BINARIES.has(binary)) {
    return binary
  }
  let subcommand: string | null = null
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (!arg.startsWith('-')) {
      subcommand = arg
      break
    }
    // Why: only git's global flags take a separate value; e.g. rg's -C takes
    // a number that must not be consumed as if it were a flag value.
    if (binary === 'git' && GIT_VALUE_FLAGS.has(arg)) {
      i++
    }
  }
  if (!subcommand) {
    return binary
  }
  return `${binary} ${subcommand.slice(0, 40)}`
}

export type SubprocessSpawnStats = {
  count: number
  // Cumulative and worst synchronous cost of initiating the spawn (the
  // uv_spawn → posix_spawn call runs on the main thread before returning).
  blockMsTotal: number
  blockMsMax: number
}

const spawnStatsByCommand = new Map<string, SubprocessSpawnStats>()

/**
 * Record one subprocess spawn from the main process. `blockMs` is how long
 * the synchronous spawn/execFile initiation call held the main thread.
 * Always on: the counts feed the per-minute `main.loop` span.
 */
export function recordSubprocessSpawn(
  command: string,
  args: readonly string[],
  blockMs: number
): void {
  const key = classifySubprocessCommand(command, args)
  const stats = spawnStatsByCommand.get(key)
  if (stats) {
    stats.count++
    stats.blockMsTotal += blockMs
    stats.blockMsMax = Math.max(stats.blockMsMax, blockMs)
  } else {
    spawnStatsByCommand.set(key, { count: 1, blockMsTotal: blockMs, blockMsMax: blockMs })
  }
}

export function drainSubprocessSpawnStats(): Record<string, SubprocessSpawnStats> {
  const drained: Record<string, SubprocessSpawnStats> = {}
  for (const [key, stats] of spawnStatsByCommand) {
    drained[key] = {
      count: stats.count,
      blockMsTotal: Math.round(stats.blockMsTotal * 100) / 100,
      blockMsMax: Math.round(stats.blockMsMax * 100) / 100
    }
  }
  spawnStatsByCommand.clear()
  return drained
}

/**
 * Timestamped marker line for correlating a specific main-process activity
 * (e.g. an updater check) with the probe's stall windows and with macOS
 * Performance Diagnostics log entries in field captures. No-op unless
 * ORCA_MAIN_THREAD_DIAGNOSTICS=1.
 */
export function writeMainThreadDiagnosticMarker(marker: string): void {
  if (!isMainThreadDiagnosticsEnabled()) {
    return
  }
  writeStartupDiagnosticLine(
    `[main-thread] ${JSON.stringify({ marker, t: Math.round(performance.now()) })}`
  )
}

export type MainThreadChurnProbeOptions = {
  /** Extra counters folded into each report line, sampled once per window. */
  extraStats?: () => Record<string, unknown>
}

/**
 * Long-running main-process jank probe, always on. Every 60s it emits one
 * `main.loop` trace span (worst event-loop stall, stall counts over 50/250ms,
 * spawn stats) and a durable `main_loop_stall` breadcrumb for any gap >= 1s.
 * With ORCA_MAIN_THREAD_DIAGNOSTICS=1 it also writes a `[main-thread] {json}`
 * stderr line every 5s (issue #7576). Unlike the startup stall probe this
 * never stops: the churn it measures (git status polling, updater retries) is
 * steady-state.
 */
export function startMainThreadChurnProbe(options: MainThreadChurnProbeOptions = {}): void {
  let last = performance.now()
  let lastReport = last
  let windowStart = last
  const reportGaps = newGapCounter()
  const windowGaps = newGapCounter()
  const windowSpawns: Record<string, SubprocessSpawnStats> = {}
  const reportSpawns: Record<string, SubprocessSpawnStats> = {}
  // Why both: a window roll between stderr reports must not steal spawns from the next report.
  const drainSpawns = (): void => {
    const drained = drainSubprocessSpawnStats()
    mergeSpawnStats(windowSpawns, drained)
    mergeSpawnStats(reportSpawns, drained)
  }
  const timer = setInterval(() => {
    const now = performance.now()
    const gap = now - last - TICK_MS
    last = now
    recordGap(reportGaps, gap)
    recordGap(windowGaps, gap)
    recordMainLoopStall(gap)
    if (now - lastReport >= REPORT_EVERY_MS) {
      lastReport = now
      drainSpawns()
      const spawns = { ...reportSpawns }
      if (isMainThreadDiagnosticsEnabled()) {
        const report = {
          t: Math.round(now),
          maxGapMs: Math.max(0, Math.round(reportGaps.maxGapMs)),
          gapsOver50Ms: reportGaps.gapsOver50Ms,
          gapsOver250Ms: reportGaps.gapsOver250Ms,
          spawnCount: Object.values(spawns).reduce((sum, s) => sum + s.count, 0),
          spawns,
          ...options.extraStats?.()
        }
        writeStartupDiagnosticLine(`[main-thread] ${JSON.stringify(report)}`)
      }
      resetGapCounter(reportGaps)
      for (const key of Object.keys(reportSpawns)) {
        delete reportSpawns[key]
      }
    }
    if (now - windowStart >= MAIN_LOOP_WINDOW_MS) {
      drainSpawns()
      emitMainLoopSpan(now - windowStart, windowGaps, windowSpawns)
      windowStart = now
      resetGapCounter(windowGaps)
      for (const key of Object.keys(windowSpawns)) {
        delete windowSpawns[key]
      }
    }
  }, TICK_MS)
  timer.unref?.()
}
