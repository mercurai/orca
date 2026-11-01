/** Host preparation failures stay on their IPC handlers; the desktop remains usable. */
export async function loadMainWindowAfterCoreServices(input: {
  ready: Promise<void>
  isCurrent: () => boolean
  load: () => void
  failed: (error: unknown) => void
}): Promise<void> {
  try {
    await input.ready
  } catch (error) {
    input.failed(error)
  }
  if (input.isCurrent()) {
    input.load()
  }
}
