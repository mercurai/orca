import { markEnvironmentUsedDetached } from '../../../shared/runtime-environment-usage-detached'

/** Subscription callbacks cannot reject to a caller; usage writes must tolerate removed or unreadable environments. */
export function recordRuntimeEnvironmentUsage(
  userDataPath: string,
  selector: string,
  args: Parameters<typeof markEnvironmentUsedDetached>[2] = {}
): void {
  try {
    markEnvironmentUsedDetached(userDataPath, selector, args)
  } catch (error) {
    console.warn(
      `Skipped last-used bookkeeping for runtime environment ${selector}:`,
      error instanceof Error ? error.message : error
    )
  }
}
