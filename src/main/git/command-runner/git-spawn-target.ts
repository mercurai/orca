import { resolveGitCommand } from './git-command-resolution'
import { untranslatedGitOutputEnv } from './git-process-env'
import type { GitSpawnOptions } from './git-spawn'

/** Resolved binary, args, cwd and env for a git spawn, shared by in-process and worker spawns. */
export function resolveGitSpawnTarget(
  args: string[],
  options: Pick<GitSpawnOptions, 'cwd' | 'wslDistro' | 'env'>
): { binary: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } {
  const resolved = resolveGitCommand(args, {
    cwd: options.cwd,
    ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
    ...(options.env ? { env: options.env } : {})
  })
  return {
    binary: resolved.binary,
    args: resolved.args,
    cwd: resolved.cwd,
    env: untranslatedGitOutputEnv(options.env ?? process.env)
  }
}
