import { performance } from 'node:perf_hooks'
import { forceTerminateProcessTree } from '@orca/process-host/process-tree-termination'
import { waitForProcessTreeExit } from './process-tree-identity'
import { MAX_METRICS_REQUEST_TIMEOUT_MS, type ProcessMetricsClient } from './process-metrics-client'
import { captureRuntimeShellCloseDiagnostic } from './runtime-shell-close-diagnostic'
import { formatRuntimeShellCloseDiagnostic } from './runtime-shell-close-diagnostic-format'
import type { Session } from './runtime-shell-session'

const CLOSE_WAIT_MS = 8_000
const TREE_POLL_MS = 200
const CLEANUP_JOB_RPC_TIMEOUT_MS = 2_000
const CLEANUP_VERIFICATION_RESERVE_MS = 3_500

export async function stopSession(
  session: Session,
  sampler: ProcessMetricsClient
): Promise<number> {
  if (session.cleanupComplete) {
    return session.cleanupMs ?? 0
  }
  const startedAt = performance.now()
  try {
    await stopNormally(session, sampler)
    session.cleanupComplete = true
    session.cleanupMode = 'normal'
    session.cleanupMs = performance.now() - startedAt
    return session.cleanupMs
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === `${session.shell.name} shell exit after app-server EOF timed out`
    ) {
      try {
        const diagnostic = await captureRuntimeShellCloseDiagnostic(session, sampler)
        console.error(formatRuntimeShellCloseDiagnostic(diagnostic))
      } catch {
        console.error('Windows Codex normal-close snapshot: capture=unavailable')
      }
    }
    try {
      await terminateOwnedSession(session, sampler)
      session.cleanupComplete = true
      session.cleanupMode = 'forced'
      session.cleanupMs = performance.now() - startedAt
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${session.shell.name} failed and its owned process cleanup was not verified`
      )
    }
    throw error
  }
}

async function stopNormally(session: Session, sampler: ProcessMetricsClient): Promise<void> {
  if (session.child.exitCode === null && session.child.signalCode === null) {
    session.child.stdin.end()
  }
  const close = await withTimeout(
    session.closePromise,
    CLOSE_WAIT_MS,
    `${session.shell.name} shell exit after app-server EOF`
  )
  if (close.code !== 0 || close.signal !== null) {
    throw new Error(`${session.shell.name} did not exit normally after app-server EOF`)
  }
  assertSamplerAvailableForNormalCleanup(session, sampler)
  await waitForOwnedSessionExit(session, sampler)
  assertSamplerAvailableForNormalCleanup(session, sampler)
  await releaseEmptyJob(session, sampler)
  assertSamplerAvailableForNormalCleanup(session, sampler)
}

function assertSamplerAvailableForNormalCleanup(
  session: Session,
  sampler: ProcessMetricsClient
): void {
  if (sampler.isUnavailable) {
    throw new Error(`${session.shell.name} sampler failed during normal process cleanup`)
  }
}

async function terminateOwnedSession(
  session: Session,
  sampler: ProcessMetricsClient
): Promise<void> {
  const deadline = Date.now() + CLOSE_WAIT_MS
  if (session.jobId !== null && !sampler.isUnavailable) {
    try {
      await sampler.terminateJob(
        session.jobId,
        cleanupRpcTimeout(deadline, session.shell.name, CLEANUP_VERIFICATION_RESERVE_MS)
      )
    } catch (error) {
      if (!sampler.isUnavailable) {
        throw error
      }
    }
  } else if (
    session.jobId === null &&
    session.child.exitCode === null &&
    session.child.signalCode === null
  ) {
    await forceTerminateProcessTree(session.child)
  }
  if (sampler.isUnavailable) {
    await waitForSamplerExit(sampler, deadline, session.shell.name)
    session.jobReleased = true
  }
  await withTimeout(
    session.closePromise,
    remainingCleanupMs(deadline, session.shell.name),
    `${session.shell.name} shell exit after owned-job termination`
  )
  await waitForOwnedSessionExit(session, sampler, deadline)
  await releaseEmptyJob(session, sampler, deadline)
}

async function waitForOwnedSessionExit(
  session: Session,
  sampler: ProcessMetricsClient,
  deadline = Date.now() + CLOSE_WAIT_MS
): Promise<void> {
  if (session.jobId !== null && sampler.isUnavailable) {
    await waitForSamplerExit(sampler, deadline, session.shell.name)
    session.jobReleased = true
  }
  if (session.jobId !== null && !sampler.isUnavailable) {
    let jobEmpty = false
    while (Date.now() < deadline) {
      let members: number[]
      try {
        members = await sampler.listJobProcessIds(
          session.jobId,
          cleanupRpcTimeout(deadline, session.shell.name, CLEANUP_VERIFICATION_RESERVE_MS)
        )
      } catch (error) {
        if (!sampler.isUnavailable) {
          throw error
        }
        await waitForSamplerExit(sampler, deadline, session.shell.name)
        session.jobReleased = true
        break
      }
      if (Date.now() >= deadline) {
        throw new Error(`${session.shell.name} process job check exceeded its cleanup deadline`)
      }
      if (sampler.isUnavailable) {
        await waitForSamplerExit(sampler, deadline, session.shell.name)
        session.jobReleased = true
        break
      }
      if (members.length === 0) {
        jobEmpty = true
        break
      }
      const remainingMs = deadline - Date.now()
      if (remainingMs > 0) {
        await delay(Math.min(TREE_POLL_MS, remainingMs))
      }
    }
    if (!jobEmpty && !session.jobReleased) {
      throw new Error(`${session.shell.name} left live members in its owned process job`)
    }
  }
  const remainingMs = remainingCleanupMs(deadline, session.shell.name)
  await waitForProcessTreeExit(
    session.pid,
    session.creationTimeMs,
    session.observedProcessIdentities,
    { timeoutMs: remainingMs, intervalMs: TREE_POLL_MS, label: session.shell.name }
  )
}

async function releaseEmptyJob(
  session: Session,
  sampler: ProcessMetricsClient,
  deadline = Date.now() + CLOSE_WAIT_MS
): Promise<void> {
  if (session.jobId !== null && !session.jobReleased && sampler.isUnavailable) {
    await waitForSamplerExit(sampler, deadline, session.shell.name)
    session.jobReleased = true
  }
  if (session.jobId !== null && !session.jobReleased) {
    try {
      await sampler.releaseJob(session.jobId, cleanupRpcTimeout(deadline, session.shell.name))
    } catch (error) {
      if (!sampler.isUnavailable) {
        throw error
      }
      await waitForSamplerExit(sampler, deadline, session.shell.name)
    }
    session.jobReleased = true
  }
}

async function waitForSamplerExit(
  sampler: ProcessMetricsClient,
  deadline: number,
  label: string
): Promise<void> {
  await withTimeout(
    sampler.waitForExit(),
    remainingCleanupMs(deadline, label),
    `${label} sampler helper exit`
  )
}

function cleanupRpcTimeout(deadline: number, label: string, reserveMs = 0): number {
  const remainingMs = remainingCleanupMs(deadline, label) - reserveMs
  if (remainingMs <= 0) {
    throw new Error(`${label} process cleanup has no time reserved for verification`)
  }
  return Math.min(CLEANUP_JOB_RPC_TIMEOUT_MS, MAX_METRICS_REQUEST_TIMEOUT_MS, remainingMs)
}

function remainingCleanupMs(deadline: number, label: string): number {
  const remainingMs = Math.floor(deadline - Date.now())
  if (remainingMs <= 0) {
    throw new Error(`${label} process cleanup deadline expired`)
  }
  return remainingMs
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${operation} timed out`)), timeoutMs)
      })
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}
