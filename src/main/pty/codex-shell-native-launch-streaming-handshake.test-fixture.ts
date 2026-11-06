import { readFileSync } from 'node:fs'
import { spawnProcess } from '@orca/process-host'
import { forceTerminateProcessTree } from '@orca/process-host/process-tree-termination'
import type { RuntimeShell } from '../../../tests/tools/windows-codex-native-runtime/runtime-environment'
import { shellArgs as runtimeShellArgs } from '../../../tests/tools/windows-codex-native-runtime/runtime-shell-session'
import {
  RuntimeShellMilestoneCapture,
  RUNTIME_SHELL_MILESTONES
} from '../../../tests/tools/windows-codex-native-runtime/runtime-shell-milestones'
import type { RuntimeShellMilestone } from '../../../tests/tools/windows-codex-native-runtime/runtime-shell-milestones'
import {
  prepareStreamingLaunch,
  streamingLogCounts,
  type StreamingLaunchCase,
  type StreamingLaunchFixture
} from './codex-shell-native-launch-streaming.test-fixture'

export type StreamingHandshakeResult = {
  close: { code: number | null; signal: NodeJS.Signals | null }
  responseFrame: unknown
  stdoutLines: string[]
  stdoutOverflow: boolean
  stderrMarkers: RuntimeShellMilestone[]
  stderrBytes: number
  stderrOverflow: boolean
  unexpectedStderrBytes: number
  frames: unknown[]
  expectedShim: string | null
  counts: ReturnType<typeof streamingLogCounts>
}

export async function runStreamingHandshake(
  fixture: StreamingLaunchFixture,
  runtimeShell: RuntimeShell,
  mode: 'native' | 'optout',
  launchCase: StreamingLaunchCase
): Promise<StreamingHandshakeResult> {
  const { env, script, expectedShim } = prepareStreamingLaunch(
    fixture,
    runtimeShell,
    mode,
    launchCase
  )
  const child = spawnProcess({
    program: runtimeShell.executable,
    args: runtimeShellArgs(runtimeShell, script, fixture.root),
    cwd: fixture.root,
    env,
    stdio: 'pipe'
  })
  let closeResult: { code: number | null; signal: NodeJS.Signals | null } | undefined
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveClose, rejectClose) => {
      child.once('close', (code, signal) => {
        closeResult = { code, signal }
        resolveClose(closeResult)
      })
      child.once('error', rejectClose)
    }
  )
  void closed.catch(() => {})
  const stdoutLines: string[] = []
  let stdoutPending = Buffer.alloc(0)
  let stdoutBytes = 0
  let stdoutOverflow = false
  const stderrMarkers: RuntimeShellMilestone[] = []
  let recognizedStderrBytes = 0
  const milestoneCapture = new RuntimeShellMilestoneCapture((milestone, byteLength) => {
    recognizedStderrBytes += byteLength
    if (stderrMarkers.length <= RUNTIME_SHELL_MILESTONES.length) {
      stderrMarkers.push(milestone)
    }
  })
  let stderrBytes = 0
  let stderrOverflow = false
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length
    stderrOverflow ||= stderrBytes > 4096
    milestoneCapture.consume(chunk)
  })
  const response = new Promise<string>((resolveResponse, rejectResponse) => {
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes = Math.min(stdoutBytes + chunk.length, 1_000_000_000)
      if (stdoutOverflow || stdoutBytes > 4096) {
        stdoutOverflow = true
        stdoutPending = Buffer.alloc(0)
        rejectResponse(new Error('Initialize stdout exceeded the fixture limit'))
        return
      }
      stdoutPending = Buffer.concat([stdoutPending, chunk])
      let newline = stdoutPending.indexOf(10)
      while (newline >= 0) {
        if (stdoutLines.length === 2) {
          stdoutOverflow = true
          stdoutPending = Buffer.alloc(0)
          rejectResponse(new Error('Initialize stdout exceeded the fixture line limit'))
          return
        }
        const line = stdoutPending.subarray(0, newline).toString('utf8').replace(/\r$/u, '')
        stdoutPending = stdoutPending.subarray(newline + 1)
        stdoutLines.push(line)
        if (stdoutLines.length === 1) {
          resolveResponse(line)
        }
        newline = stdoutPending.indexOf(10)
      }
    })
    child.stdout.once('error', rejectResponse)
    child.once('error', rejectResponse)
    child.stdin.once('error', rejectResponse)
    child.once('close', () => rejectResponse(new Error('Shell closed before initialize response')))
  })
  void response.catch(() => {})
  let responseFrame: unknown
  let failureKind: string | undefined
  let exitCodeAtFailure: number | null | undefined
  let signalAtFailure: NodeJS.Signals | null | undefined
  let close: { code: number | null; signal: NodeJS.Signals | null } | undefined
  let cleanupFailure = false

  try {
    await writeChild('ORCA_RUNTIME_JOB_READY\n')
    await writeChild(`${JSON.stringify({ id: 1, method: 'initialize', params: {} })}\n`)
    const responseLine = await withTimeout(response, 10_000, `${runtimeShell.name} initialize`)
    try {
      responseFrame = JSON.parse(responseLine)
    } catch {
      throw new Error('Initialize response was not JSON')
    }
    await writeChild(`${JSON.stringify({ method: 'initialized' })}\n`)
    child.stdin.end()
    close = await withTimeout(closed, 5_000, `${runtimeShell.name} EOF cleanup`)
  } catch (error) {
    failureKind =
      error instanceof Error && error.message.includes('timed out')
        ? 'timeout'
        : error instanceof Error && error.message.includes('closed before')
          ? 'closed-before-response'
          : 'handshake-failure'
    exitCodeAtFailure = child.exitCode
    signalAtFailure = child.signalCode
  }

  if (child.exitCode === null && child.signalCode === null) {
    child.stdin.end()
    try {
      cleanupFailure = !(await forceTerminateProcessTree(child))
    } catch {
      cleanupFailure = true
    }
  }
  try {
    close = await withTimeout(closed, 5_000, `${runtimeShell.name} close`)
  } catch {
    cleanupFailure = true
  }

  const unexpectedStderrBytes = stderrBytes - recognizedStderrBytes
  const stderrMatches =
    !stderrOverflow &&
    unexpectedStderrBytes === 0 &&
    stderrMarkers.length === RUNTIME_SHELL_MILESTONES.length &&
    stderrMarkers.every((milestone, index) => milestone === RUNTIME_SHELL_MILESTONES[index])
  const frames = readFixtureFrames(fixture.appServerLog)
  const counts = streamingLogCounts(fixture)

  if (
    cleanupFailure ||
    failureKind ||
    !stderrMatches ||
    stdoutOverflow ||
    stdoutPending.length > 0
  ) {
    const status =
      exitCodeAtFailure === undefined ? 'not-captured' : (exitCodeAtFailure ?? 'running')
    const signal = signalAtFailure === undefined ? 'not-captured' : (signalAtFailure ?? 'none')
    throw new Error(
      `${runtimeShell.name} ${launchCase} ${mode} ${failureKind ?? 'output-failure'}; ` +
        `cleanupFailure=${cleanupFailure}, exit=${status}, signal=${signal}, ` +
        `close=${close?.code ?? 'open'}, latestMilestone=${stderrMarkers.at(-1) ?? 'none'}, ` +
        `milestones=${stderrMarkers.join(',') || 'none'}, resolverCalls=${counts.resolverCalls}, ` +
        `helpCalls=${counts.helpCalls}, serverStarts=${counts.serverStarts}, ` +
        `appServerFrames=${counts.appServerFrames}, codexHomeChecks=${counts.codexHomeChecks}, ` +
        `codexHomeMismatches=${counts.codexHomeMismatches}, ` +
        `stdoutLines=${stdoutLines.length}, stdoutBytes=${stdoutBytes}, stdoutOverflow=${stdoutOverflow}, ` +
        `stdoutPendingBytes=${stdoutPending.length}, stderrBytes=${stderrBytes}, stderrOverflow=${stderrOverflow}, ` +
        `unexpectedStderrBytes=${unexpectedStderrBytes}`
    )
  }
  if (!close) {
    throw new Error(`${runtimeShell.name} close result was missing`)
  }
  return {
    close,
    responseFrame,
    stdoutLines,
    stdoutOverflow,
    stderrMarkers,
    stderrBytes,
    stderrOverflow,
    unexpectedStderrBytes,
    frames,
    expectedShim,
    counts
  }

  function writeChild(value: string): Promise<void> {
    return new Promise((resolveWrite, rejectWrite) => {
      child.stdin.write(value, (error) => (error ? rejectWrite(error) : resolveWrite()))
    })
  }
}

function readFixtureFrames(path: string): unknown[] {
  const contents = readFileSync(path, 'utf8')
  return contents
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds)
    })
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer)
    }
  })
}
