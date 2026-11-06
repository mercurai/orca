type LifecycleFailure = { error: unknown } | null
type ShutdownAction = () => Promise<void>

export async function finishPackagedPtyLifecycle(
  lifecycleFailure: LifecycleFailure,
  shutdownActions: readonly ShutdownAction[],
  removeTempRoot: () => void
): Promise<void> {
  const cleanupErrors: unknown[] = []
  for (const shutdown of shutdownActions) {
    try {
      await shutdown()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }

  if (cleanupErrors.length === 0) {
    try {
      removeTempRoot()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }

  if (lifecycleFailure !== null) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [lifecycleFailure.error, ...cleanupErrors],
        'Packaged Codex PTY lifecycle failed and cleanup was incomplete'
      )
    }
    throw lifecycleFailure.error
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'Packaged Codex PTY cleanup failed')
  }
}
