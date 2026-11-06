import { join } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import { forceTerminateProcessTree } from '@orca/process-host/process-tree-termination'
import type { PipedChildProcess } from '@orca/process-host/process-spec'
import type { RuntimeMode, RuntimeSettings, RuntimeShell } from './runtime-environment'
import { createRuntimeEnvironment } from './runtime-environment'
import { shellArgs, shellScript } from './runtime-shell-session'

const INVALID_ARG = '__orca_native_runtime_invalid_sandbox__'

export async function runInvalidEnumCheck(
  settings: RuntimeSettings,
  shell: RuntimeShell,
  mode: RuntimeMode,
  homeRoot: string
): Promise<{
  exitCode: number | null
  signal: NodeJS.Signals | null
  containsInvalidEnum: boolean
}> {
  const env = createRuntimeEnvironment(settings, shell, mode, homeRoot)
  const child = spawnProcess({
    program: shell.executable,
    args: shellArgs(shell, shellScript(shell, settings.npmBin, true), homeRoot),
    cwd: process.cwd(),
    env,
    stdio: 'pipe'
  })
  if (!child.pid) {
    throw new Error(`${shell.name} invalid-argument process did not start`)
  }
  return finishInvalidEnumProcess(child, shell.name)
}

export async function runProcessHostInvalidEnumCheck(
  settings: RuntimeSettings,
  mode: RuntimeMode,
  homeRoot: string
): Promise<{
  exitCode: number | null
  signal: NodeJS.Signals | null
  containsInvalidEnum: boolean
}> {
  const shell = settings.shells.find((candidate) => candidate.name === 'PowerShell 7')
  if (!shell) {
    throw new Error(
      'The process-host argv check needs the PowerShell 7 runtime environment definition'
    )
  }
  const child = spawnProcess({
    program: join(settings.npmBin, 'codex.cmd'),
    args: ['--sandbox', INVALID_ARG, 'app-server'],
    cwd: process.cwd(),
    env: createRuntimeEnvironment(settings, shell, mode, homeRoot),
    stdio: 'pipe'
  })
  if (!child.pid) {
    throw new Error('The process-host invalid-argument process did not start')
  }
  return finishInvalidEnumProcess(child, 'Process-host')
}

async function finishInvalidEnumProcess(
  child: PipedChildProcess,
  label: string
): Promise<{
  exitCode: number | null
  signal: NodeJS.Signals | null
  containsInvalidEnum: boolean
}> {
  const closed = makeClosePromise(child)
  let output = ''
  let overflow = false
  const capture = (chunk: Buffer | string): void => {
    if (overflow) {
      return
    }
    const text = chunk.toString()
    if (Buffer.byteLength(output) + Buffer.byteLength(text) > 64 * 1024) {
      overflow = true
      return
    }
    output += text
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  child.stdin.end()
  let result: { code: number | null; signal: NodeJS.Signals | null }
  try {
    result = await withTimeout(closed, 15_000)
  } catch {
    await forceTerminateProcessTree(child)
    throw new Error(`${label} invalid-enum command did not exit`)
  }
  if (overflow) {
    throw new Error(`${label} invalid-enum output exceeded its bound`)
  }
  return {
    exitCode: result.code,
    signal: result.signal,
    containsInvalidEnum: output.includes(INVALID_ARG)
  }
}

function makeClosePromise(
  child: PipedChildProcess
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveClose, rejectClose) => {
    const onError = (error: Error): void => {
      child.removeListener('close', onClose)
      rejectClose(error)
    }
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      child.removeListener('error', onError)
      resolveClose({ code, signal })
    }
    child.once('error', onError)
    child.once('close', onClose)
  })
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out')), timeoutMs)
      })
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}
