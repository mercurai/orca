import { AsyncLocalStorage } from 'node:async_hooks'
import type { GitAdmissionTier } from './git-exec-options'

const operations = new AsyncLocalStorage<{ tier: GitAdmissionTier; active: boolean }>()
const callers = new AsyncLocalStorage<string>()

/** Label the code path that starts git work so `git.exec` spans carry `git.caller`. */
export function withGitCaller<T>(caller: string, operation: () => T): T {
  return callers.run(caller, operation)
}

export function bindGitCaller<A extends unknown[], R>(
  caller: string,
  fn: (...args: A) => R
): (...args: A) => R {
  return (...args) => callers.run(caller, () => fn(...args))
}

export function currentGitCaller(): string | undefined {
  return callers.getStore()
}

/** Async context keeps concurrent operations isolated without forwarding a tier through routing options. */
export function createGitOperationExecutor(tier: GitAdmissionTier) {
  return {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      const scope = { tier, active: true }
      return operations.run(scope, async () => {
        try {
          return await operation()
        } finally {
          // Timers and detached work must not retain a completed create's priority.
          scope.active = false
        }
      })
    }
  }
}

export function resolveGitAdmissionTier(tier?: GitAdmissionTier): GitAdmissionTier {
  const scope = operations.getStore()
  return tier ?? (scope?.active ? scope.tier : undefined) ?? 'status'
}
