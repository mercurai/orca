import { performance } from 'node:perf_hooks'
import type { PipedProcessSpawner, ChildProcessHandle } from '@orca/process-host/process-spec'
import { spawnProcess } from '@orca/process-host'
import { openCodexAppServerConnection } from '../../../src/main/codex/codex-app-server-connection'
import { readWindowsProcessIdentityTableFresh } from '../../../src/main/windows/windows-process-table'
import { processIdentity, waitForProcessTreeExit } from './process-tree-identity'
import {
  preserveFailureAfterDirectCleanup,
  waitForDirectTreeExit,
  withDirectTimeout
} from './direct-app-server-cleanup'
import {
  creationTime,
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

export async function runConnectionClose(
  settings: RuntimeSettings,
  mode: RuntimeMode,
  homeRoot: string
): Promise<DirectRunEvidence> {
  const launch = makeLaunch(settings, mode, homeRoot)
  const startedAt = performance.now()
  let spawnEnvironmentVerified = false
  let spawnedChild: ChildProcessHandle | undefined
  const spawnImpl: PipedProcessSpawner = (spec) => {
    verifySpawnEnvironment(spec.env, homeRoot, settings)
    spawnEnvironmentVerified = true
    const child = spawnProcess(spec)
    spawnedChild = child
    return child
  }
  const connection = await openCodexAppServerConnection(
    {
      command: launch.command,
      args: ['app-server'],
      cwd: process.cwd(),
      env: stringEnvironment(launch.env),
      envToDelete: launch.envToDelete
    },
    {},
    spawnImpl
  )
  const connectionPid = connection.pid
  let identity: Awaited<ReturnType<typeof waitForIdentity>> | undefined
  let tree: Awaited<ReturnType<typeof readWindowsProcessIdentityTableFresh>> = []
  let validationError: unknown
  try {
    if (!spawnEnvironmentVerified) {
      throw new Error('Direct app-server spawn environment was not observed')
    }
    if (connectionPid === undefined) {
      throw new Error('Direct app-server connection has no process ID')
    }
    identity = await waitForIdentity(connectionPid)
    tree = verifyDirectRoute(
      await readWindowsProcessIdentityTableFresh(),
      connectionPid,
      creationTime(identity),
      mode
    )
  } catch (error) {
    validationError = error
  }

  const startupMs = performance.now() - startedAt
  const closeStartedAt = performance.now()
  let observedClose = false
  let closeFailure: unknown
  try {
    observedClose = await withDirectTimeout(connection.close(), CLOSE_WAIT_MS)
  } catch (error) {
    closeFailure = error
  }
  if (closeFailure === undefined && (!observedClose || connection.processTreeUnproven)) {
    closeFailure = new Error(
      'Direct app-server connection did not prove close and descendant cleanup'
    )
  }
  if (connectionPid !== undefined && identity) {
    const observed = tree.length > 0 ? tree.map(processIdentity) : [processIdentity(identity)]
    const cleanupOptions = {
      timeoutMs: CLOSE_WAIT_MS,
      intervalMs: 100,
      label: 'Direct app-server'
    }
    if (closeFailure !== undefined) {
      await preserveFailureAfterDirectCleanup(
        closeFailure,
        spawnedChild,
        connectionPid,
        creationTime(identity),
        observed,
        cleanupOptions
      )
    }
    await (spawnedChild
      ? waitForDirectTreeExit(
          spawnedChild,
          connectionPid,
          creationTime(identity),
          observed,
          cleanupOptions
        )
      : waitForProcessTreeExit(connectionPid, creationTime(identity), observed, cleanupOptions))
  } else if (closeFailure !== undefined || validationError !== undefined) {
    const failure = closeFailure ?? validationError
    await preserveFailureAfterDirectCleanup(failure, spawnedChild, connectionPid, undefined, [], {
      timeoutMs: CLOSE_WAIT_MS,
      intervalMs: 100,
      label: 'Direct app-server'
    })
  }
  if (closeFailure !== undefined) {
    throw closeFailure
  }
  if (validationError !== undefined) {
    throw validationError
  }
  if (connectionPid === undefined || !identity || tree.length === 0) {
    throw new Error('Direct app-server runtime identity was incomplete')
  }
  const root = tree.find((row) => row.pid === connectionPid)
  if (!root) {
    throw new Error('Direct app-server root was absent from its verified tree')
  }
  return {
    mode,
    api: 'connection-close',
    startupMs,
    cleanupMs: performance.now() - closeStartedAt,
    processTreeSize: tree.length,
    rootKind: rootKind(root)
  }
}
