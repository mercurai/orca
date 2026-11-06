import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { ProcessMetricsClient } from './process-metrics-client'
import type { Session } from './runtime-shell-session'
import { runDirectAppServerLifecycleQualification } from './direct-app-server-lifecycle'
import { runInvalidEnumCheck, runProcessHostInvalidEnumCheck } from './runtime-invalid-argv'
import { summarizePairedDeltas, summarizeRuns } from './runtime-report'
import { collectResources, type RunSummary } from './runtime-resource-measurement'
import { assignShellJobAndRelease } from './runtime-shell-job'
import {
  initializeSession,
  launchSession,
  stopSession,
  waitForRootIdentity
} from './runtime-shell-session'
import {
  readRuntimeSettings,
  type RuntimeMode,
  type RuntimeSettings,
  type RuntimeShell
} from './runtime-environment'
import {
  isWindowsProcessStartTimeAvailable,
  isWindowsProcessTableAvailable,
  readWindowsProcessIdentityTableFresh
} from '../../../src/main/windows/windows-process-table'

const PAIR_COUNT = 3
const MAX_REPORT_BYTES = 32 * 1024

async function runStage(
  settings: RuntimeSettings,
  shell: RuntimeShell,
  mode: RuntimeMode,
  sessionCount: number,
  sampler: ProcessMetricsClient,
  runRoot: string,
  runIndex: number,
  pairId: number
): Promise<RunSummary> {
  const sessions: Session[] = []
  try {
    const homeRoot = join(runRoot, `${shell.name.replaceAll(' ', '-')}-${mode}-${runIndex}`)
    mkdirSync(homeRoot, { recursive: true })
    for (let index = 0; index < sessionCount; index++) {
      const session = launchSession(settings, shell, mode, homeRoot)
      sessions.push(session)
      await waitForRootIdentity(session)
      await assignShellJobAndRelease(session, sampler)
      await initializeSession(session)
    }
    const startupMs = sessions.map(
      (session) => (session.readyAt ?? performance.now()) - session.startedAt
    )
    const jobGateSetupMs = sessions.map((session) => {
      if (session.launchGateReleasedAt === undefined) {
        throw new Error(`${session.shell.name} launch gate release time was unavailable`)
      }
      return session.launchGateReleasedAt - session.startedAt
    })
    const { samples, idleCpuCorePercent } = await collectResources(
      sessions,
      sampler,
      settings.nativeExecutable
    )
    const closeStartedAt = performance.now()
    const closeDurations = await Promise.all(
      sessions.map((session) => stopSession(session, sampler))
    )
    const cleanupMs = Math.max(performance.now() - closeStartedAt, ...closeDurations)
    return {
      shell: shell.name,
      mode,
      sessionCount,
      pairId,
      startupMs,
      jobGateSetupMs,
      cleanupMs,
      samples,
      idleCpuCorePercent
    }
  } catch (error) {
    const cleanup = await Promise.allSettled(
      sessions.map((session) => stopSession(session, sampler))
    )
    const cleanupErrors = cleanup.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'Runtime stage failed and at least one owned process job could not be verified empty'
      )
    }
    throw error
  }
}

export async function runNativeCodexRuntimeQualification(): Promise<void> {
  if (!isWindowsProcessTableAvailable() || !isWindowsProcessStartTimeAvailable()) {
    throw new Error(
      'The requested runtime gate requires the native process-table addon with creation times'
    )
  }
  const settings = readRuntimeSettings()
  const selfRows = await readWindowsProcessIdentityTableFresh()
  if (!selfRows.some((row) => row.pid === process.pid && typeof row.creationTimeMs === 'number')) {
    throw new Error('Native process-table identity did not include the test process')
  }
  const scriptPath = resolve(
    process.cwd(),
    'tests/tools/windows-codex-native-runtime/process-metrics.py'
  )
  if (!existsSync(scriptPath)) {
    throw new Error('The test-only Windows metrics sampler is missing')
  }

  const runRoot = mkdtempSync(join(tmpdir(), 'orca-codex-native-runtime-'))
  let sampler: ProcessMetricsClient | undefined
  let samplerClosed = false
  let cleanupVerified = false
  let operationFailure: unknown
  let operationFailed = false
  try {
    sampler = new ProcessMetricsClient(settings.python, scriptPath)
    const runs: RunSummary[] = []
    const argvResults: { route: 'shell' | 'process-host'; shell: string; passed: boolean }[] = []
    let runIndex = 0
    for (const shell of settings.shells) {
      for (const sessionCount of [1, settings.fleetSize]) {
        for (let pair = 0; pair < PAIR_COUNT; pair++) {
          const first: RuntimeMode = pair % 2 === 0 ? 'optout' : 'native'
          const second: RuntimeMode = first === 'optout' ? 'native' : 'optout'
          runs.push(
            await runStage(settings, shell, first, sessionCount, sampler, runRoot, runIndex++, pair)
          )
          runs.push(
            await runStage(
              settings,
              shell,
              second,
              sessionCount,
              sampler,
              runRoot,
              runIndex++,
              pair
            )
          )
        }
      }

      const argvHome = join(runRoot, `${shell.name.replaceAll(' ', '-')}-invalid-argv`)
      mkdirSync(argvHome, { recursive: true })
      const optout = await runInvalidEnumCheck(settings, shell, 'optout', argvHome)
      const native = await runInvalidEnumCheck(settings, shell, 'native', argvHome)
      const passed =
        optout.exitCode !== null &&
        optout.exitCode !== 0 &&
        optout.signal === null &&
        native.exitCode === optout.exitCode &&
        native.signal === null &&
        optout.containsInvalidEnum &&
        native.containsInvalidEnum
      if (!passed) {
        throw new Error(
          `${shell.name} did not preserve invalid enum argv through both launch routes`
        )
      }
      argvResults.push({ route: 'shell', shell: shell.name, passed })
    }

    const processHostHome = join(runRoot, 'process-host-invalid-argv')
    mkdirSync(processHostHome, { recursive: true })
    const processHostOptout = await runProcessHostInvalidEnumCheck(
      settings,
      'optout',
      processHostHome
    )
    const processHostNative = await runProcessHostInvalidEnumCheck(
      settings,
      'native',
      processHostHome
    )
    const processHostArgvPassed =
      processHostOptout.exitCode !== null &&
      processHostOptout.exitCode !== 0 &&
      processHostOptout.signal === null &&
      processHostNative.exitCode === processHostOptout.exitCode &&
      processHostNative.signal === null &&
      processHostOptout.containsInvalidEnum &&
      processHostNative.containsInvalidEnum
    if (!processHostArgvPassed) {
      throw new Error(
        'The process-host route did not preserve invalid enum argv through both launch modes'
      )
    }
    argvResults.push({ route: 'process-host', shell: 'Direct', passed: processHostArgvPassed })

    const directLifecycle = await runDirectAppServerLifecycleQualification(settings, runRoot)
    const report = JSON.stringify({
      gate: 'windows-codex-native-runtime',
      packageVersion: '0.166.0',
      architecture: settings.architecture,
      pairedRunsPerModeAndLoad: PAIR_COUNT,
      fleetSize: settings.fleetSize,
      idleCpuDefinition: 'whole-tree CPU time divided by wall time; one core = 100%',
      argvComparison: argvResults,
      results: summarizeRuns(runs),
      pairedDeltas: summarizePairedDeltas(runs),
      directAppServerLifecycle: directLifecycle
    })
    if (Buffer.byteLength(report) > MAX_REPORT_BYTES) {
      throw new Error('Sanitized Windows runtime report exceeded the output size limit')
    }
    samplerClosed = true
    await sampler.close()
    mkdirSync(dirname(settings.reportPath), { recursive: true })
    writeFileSync(settings.reportPath, report, 'utf8')
    console.log(report)
    cleanupVerified = true
  } catch (error) {
    operationFailure = error
    operationFailed = true
  } finally {
    if (sampler && !samplerClosed) {
      samplerClosed = true
      try {
        await sampler.close()
      } catch (closeError) {
        operationFailure = operationFailed
          ? new AggregateError(
              [operationFailure, closeError],
              'The runtime gate failed and its process-job helper did not close cleanly'
            )
          : closeError
        operationFailed = true
      }
    }
    if (cleanupVerified) {
      rmSync(runRoot, { recursive: true, force: true })
    }
  }
  if (operationFailed) {
    throw operationFailure
  }
}
