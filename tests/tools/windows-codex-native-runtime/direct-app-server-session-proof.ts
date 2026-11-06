import { performance } from 'node:perf_hooks'
import type { ChildProcessHandle } from '@orca/process-host/process-spec'
import { runCodexAppServerSession } from '../../../src/main/codex/codex-app-server-session'
import {
  spawnCodexAppServerProcess,
  type CodexAppServerSpawn
} from '../../../src/main/codex/codex-app-server-process-tree-kill'
import { readWindowsProcessIdentityTableFresh } from '../../../src/main/windows/windows-process-table'
import { processIdentity, processTreeForRoot } from './process-tree-identity'
import {
  preserveFailureAfterDirectCleanup,
  waitForDirectTreeExit,
  withDirectTimeout
} from './direct-app-server-cleanup'
import {
  creationTime,
  environmentFrom,
  makeLaunch,
  rootKind,
  stringEnvironment,
  verifyDirectRoute,
  verifySpawnEnvironment,
  waitForIdentity
} from './direct-app-server-route'
import type { DirectRunEvidence } from './direct-app-server-lifecycle-types'
import type { RuntimeMode, RuntimeSettings } from './runtime-environment'

const CLOSE_WAIT_MS = 15_000

type CloseResult = { code: number | null; signal: NodeJS.Signals | null }

export async function runSessionStop(
  settings: RuntimeSettings,
  mode: RuntimeMode,
  homeRoot: string
): Promise<DirectRunEvidence> {
  const launch = makeLaunch(settings, mode, homeRoot)
  const controller = new AbortController()
  const startedAt = performance.now()
  let child: ChildProcessHandle | undefined
  let exitPromise: Promise<CloseResult> | undefined
  let activeRoot: Awaited<ReturnType<typeof waitForIdentity>> | undefined
  let activeTree: Awaited<ReturnType<typeof readWindowsProcessIdentityTableFresh>> = []
  let readyAt: number | undefined
  let stopStartedAt: number | undefined
  let spawnEnvironmentVerified = false
  const spawnImpl: CodexAppServerSpawn = (program, args, options) => {
    verifySpawnEnvironment(environmentFrom(options['env']), homeRoot, settings)
    spawnEnvironmentVerified = true
    const trackedChild = spawnCodexAppServerProcess(program, args, options)
    child = trackedChild
    exitPromise = new Promise((resolveExit, rejectExit) => {
      trackedChild.once('error', rejectExit)
      trackedChild.once('exit', (code, signal) => resolveExit({ code, signal }))
    })
    void exitPromise.catch(() => {})
    return trackedChild
  }

  let cancelled = false
  let sessionFailure: unknown
  try {
    await runCodexAppServerSession(
      {
        command: launch.command,
        args: ['app-server'],
        cliPath: launch.command,
        env: stringEnvironment(launch.env),
        envToDelete: launch.envToDelete,
        timeoutMs: 30_000,
        signal: controller.signal
      },
      async () => {
        if (!child?.pid) {
          throw new Error('Direct stop API did not expose its process ID')
        }
        activeRoot = await waitForIdentity(child.pid)
        const rows = await readWindowsProcessIdentityTableFresh()
        activeTree = processTreeForRoot(rows, child.pid, creationTime(activeRoot))
        verifyDirectRoute(rows, child.pid, creationTime(activeRoot), mode)
        readyAt = performance.now()
        cancelled = true
        stopStartedAt = performance.now()
        controller.abort()
        return new Promise<never>(() => {})
      },
      spawnImpl
    )
  } catch (error) {
    sessionFailure = error
  }

  const trackedChild = child
  let lifecycleFailure: unknown
  if (trackedChild?.pid && exitPromise) {
    let exit: CloseResult | undefined
    try {
      exit = await withDirectTimeout(exitPromise, CLOSE_WAIT_MS)
    } catch (error) {
      lifecycleFailure = error
    }
    if (lifecycleFailure === undefined && exit && exit.code === null && exit.signal === null) {
      lifecycleFailure = new Error('Direct stop API did not observe process exit')
    }
    const observedRoot = activeRoot ?? (await readObservedRoot(trackedChild.pid))
    if (!activeRoot && observedRoot) {
      activeRoot = observedRoot
      const rows = await readWindowsProcessIdentityTableFresh()
      activeTree = processTreeForRoot(rows, trackedChild.pid, creationTime(observedRoot))
    }
    if (activeRoot) {
      const observed =
        activeTree.length > 0 ? activeTree.map(processIdentity) : [processIdentity(activeRoot)]
      const cleanupOptions = {
        timeoutMs: CLOSE_WAIT_MS,
        intervalMs: 100,
        label: 'Direct app-server stop'
      }
      if (lifecycleFailure !== undefined) {
        await preserveFailureAfterDirectCleanup(
          lifecycleFailure,
          trackedChild,
          trackedChild.pid,
          creationTime(activeRoot),
          observed,
          cleanupOptions
        )
      }
      try {
        await waitForDirectTreeExit(
          trackedChild,
          trackedChild.pid,
          creationTime(activeRoot),
          observed,
          cleanupOptions
        )
      } catch (error) {
        lifecycleFailure = error
      }
    } else if (lifecycleFailure !== undefined) {
      await preserveFailureAfterDirectCleanup(
        lifecycleFailure,
        trackedChild,
        trackedChild.pid,
        undefined,
        [],
        {
          timeoutMs: CLOSE_WAIT_MS,
          intervalMs: 100,
          label: 'Direct app-server stop'
        }
      )
    }
  }
  if (lifecycleFailure !== undefined) {
    throw lifecycleFailure
  }
  if (
    sessionFailure &&
    !(
      sessionFailure instanceof Error &&
      sessionFailure.message === 'codex app-server session stopped'
    )
  ) {
    throw sessionFailure
  }
  if (
    !cancelled ||
    !spawnEnvironmentVerified ||
    !trackedChild?.pid ||
    !activeRoot ||
    activeTree.length === 0
  ) {
    throw new Error('Direct app-server stop API did not reach its cancellation point')
  }
  return {
    mode,
    api: 'session-stop',
    startupMs: (readyAt ?? performance.now()) - startedAt,
    cleanupMs: performance.now() - (stopStartedAt ?? performance.now()),
    processTreeSize: activeTree.length,
    rootKind: rootKind(activeRoot)
  }
}

async function readObservedRoot(
  pid: number
): Promise<Awaited<ReturnType<typeof waitForIdentity>> | undefined> {
  const rows = await readWindowsProcessIdentityTableFresh()
  const row = rows.find((candidate) => candidate.pid === pid)
  return row && typeof row.creationTimeMs === 'number' ? row : undefined
}
