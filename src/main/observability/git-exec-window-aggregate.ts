export type GitExecWindowStats = { count: number; execMsSum: number }

// Why: git.exec spans are sampled (fast successes are budgeted per cwd), so span counts
// under-report volume. This aggregate sees every exec and feeds the main.loop span.
const statsBySubcommand = new Map<string, GitExecWindowStats>()

export function recordGitExecForWindow(subcommand: string, durationMs: number): void {
  const stats = statsBySubcommand.get(subcommand)
  if (stats) {
    stats.count++
    stats.execMsSum += durationMs
  } else {
    statsBySubcommand.set(subcommand, { count: 1, execMsSum: durationMs })
  }
}

export function drainGitExecWindow(): Record<string, GitExecWindowStats> {
  const drained: Record<string, GitExecWindowStats> = {}
  for (const [subcommand, stats] of statsBySubcommand) {
    drained[subcommand] = { count: stats.count, execMsSum: Math.round(stats.execMsSum) }
  }
  statsBySubcommand.clear()
  return drained
}
