import type { ChildProcessHandle } from '@orca/process-host/process-spec'
import { forceTerminateProcessTree } from '@orca/process-host/process-tree-termination'
import { readWindowsProcessIdentityTableFresh } from '../../../src/main/windows/windows-process-table'
import { waitForProcessTreeExit, type ProcessIdentity } from './process-tree-identity'

type CleanupOptions = {
  timeoutMs: number
  intervalMs: number
  label: string
}

export async function waitForDirectTreeExit(
  child: ChildProcessHandle,
  rootPid: number,
  rootCreationTimeMs: number,
  observed: ProcessIdentity[],
  options: CleanupOptions
): Promise<void> {
  try {
    await waitForProcessTreeExit(rootPid, rootCreationTimeMs, observed, options)
  } catch (exitError) {
    try {
      await forceTerminateObservedTree(child, rootPid, rootCreationTimeMs, observed, options)
    } catch (cleanupError) {
      throw new Error(`${options.label} cleanup could not be verified`, {
        cause: new AggregateError([exitError, cleanupError], `${options.label} cleanup failed`)
      })
    }
    throw exitError
  }
}

export async function forceTerminateObservedTree(
  child: ChildProcessHandle,
  rootPid: number,
  rootCreationTimeMs: number,
  observed: ProcessIdentity[],
  options: CleanupOptions
): Promise<void> {
  const rows = await readWindowsProcessIdentityTableFresh()
  const root = rows.find((row) => row.pid === rootPid)
  if (root && root.creationTimeMs === rootCreationTimeMs) {
    if (child.pid !== rootPid) {
      throw new Error(`${options.label} child handle did not match the observed process identity`)
    }
    await forceTerminateProcessTree(child)
  }
  await waitForProcessTreeExit(rootPid, rootCreationTimeMs, observed, options)
}

export async function preserveFailureAfterDirectCleanup(
  failure: unknown,
  child: ChildProcessHandle | undefined,
  rootPid: number | undefined,
  rootCreationTimeMs: number | undefined,
  observed: ProcessIdentity[],
  options: CleanupOptions
): Promise<never> {
  try {
    if (!child || rootPid === undefined || rootCreationTimeMs === undefined) {
      throw new Error(`${options.label} has no observed process identity for safe cleanup`)
    }
    await forceTerminateObservedTree(child, rootPid, rootCreationTimeMs, observed, options)
  } catch (cleanupError) {
    throw new Error(`${options.label} failed and cleanup could not be verified`, {
      cause: new AggregateError([failure, cleanupError], `${options.label} failure and cleanup`)
    })
  }
  throw failure
}

export async function withDirectTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Direct app-server operation timed out')),
          timeoutMs
        )
      })
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}
