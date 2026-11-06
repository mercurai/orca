import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { PipedChildProcess } from '@orca/process-host/process-spec'
import { spawnProcess } from '@orca/process-host'
import {
  getPosixCodexShellLaunchPreflight,
  getPowerShellCodexShellLaunchPreflight
} from '../../../src/shared/codex-shell-function'
import { initializeCodexAppServerConnection } from '../../../src/main/codex/codex-app-server-handshake'
import type { CodexAppServerConnection } from '../../../src/main/codex/codex-app-server-connection-types'
import { readWindowsProcessIdentityTableFresh } from '../../../src/main/windows/windows-process-table'
import { forceTerminateProcessTree } from '@orca/process-host/process-tree-termination'
import { processIdentity, waitForProcessTreeExit } from './process-tree-identity'
import type { ProcessIdentity } from './process-tree-identity'
import {
  createRuntimeEnvironment,
  type RuntimeMode,
  type RuntimeSettings,
  type RuntimeShell
} from './runtime-environment'

const TREE_WAIT_MS = 15_000
const TREE_POLL_MS = 200
const CLOSE_WAIT_MS = 8_000

export type CloseResult = { code: number | null; signal: NodeJS.Signals | null }
type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}
export type Session = {
  shell: RuntimeShell
  mode: RuntimeMode
  child: PipedChildProcess
  pid: number
  creationTimeMs: number
  startedAt: number
  closePromise: Promise<CloseResult>
  pending: Map<number, PendingRequest>
  nextRequestId: number
  protocolFailure: Error | null
  closeObserved: boolean
  readyAt?: number
  observedProcessIdentities: ProcessIdentity[]
}

export function shellScript(shell: RuntimeShell, npmBin: string, invalidEnum = false): string {
  const template =
    shell.kind === 'bash'
      ? getPosixCodexShellLaunchPreflight()
      : getPowerShellCodexShellLaunchPreflight()
  const invalid = '__orca_native_runtime_invalid_sandbox__'
  const body = invalidEnum
    ? shell.kind === 'bash'
      ? `codex --sandbox ${invalid} app-server\nexit $?`
      : `codex --sandbox '${invalid}' app-server\nexit $LASTEXITCODE`
    : 'codex app-server'
  const guard =
    shell.kind === 'bash'
      ? `case "$(command -v codex 2>/dev/null)" in "${toBashPath(npmBin)}"/codex*) ;; *) exit 96 ;; esac`
      : `$orcaSelectedCodex = Get-Command codex -ErrorAction SilentlyContinue | Select-Object -First 1\nif (-not $orcaSelectedCodex -or -not $orcaSelectedCodex.Source.StartsWith($env:ORCA_CODEX_RUNTIME_NPM_BIN, [System.StringComparison]::OrdinalIgnoreCase)) { exit 96 }`
  return [guard, template, body].join('\n')
}

export function shellArgs(shell: RuntimeShell, script: string, homeRoot: string): string[] {
  return shell.kind === 'bash'
    ? ['--noprofile', '--norc', writeBashScript(homeRoot, script)]
    : ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]
}

function writeBashScript(homeRoot: string, script: string): string {
  const scriptDirectory = mkdtempSync(join(homeRoot, 'bash-script-'))
  const scriptPath = join(scriptDirectory, 'runtime.sh')
  writeFileSync(scriptPath, script, { encoding: 'utf8', flag: 'wx' })
  return toBashPath(scriptPath)
}

function makeClosePromise(child: PipedChildProcess): Promise<CloseResult> {
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

export function launchSession(
  settings: RuntimeSettings,
  shell: RuntimeShell,
  mode: RuntimeMode,
  homeRoot: string
): Session {
  const startedAt = performance.now()
  const child = spawnProcess({
    program: shell.executable,
    args: shellArgs(shell, shellScript(shell, settings.npmBin), homeRoot),
    cwd: process.cwd(),
    env: createRuntimeEnvironment(settings, shell, mode, homeRoot),
    stdio: 'pipe'
  })
  if (!child.pid) {
    throw new Error(`${shell.name} did not return a process ID`)
  }
  const closePromise = makeClosePromise(child)
  void closePromise.catch(() => {})
  const session: Session = {
    shell,
    mode,
    child,
    pid: child.pid,
    creationTimeMs: 0,
    startedAt,
    closePromise,
    pending: new Map(),
    nextRequestId: 1,
    protocolFailure: null,
    closeObserved: false,
    observedProcessIdentities: []
  }
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  lines.on('line', (line) => receiveProtocolLine(session, line))
  child.stdout.on('error', (error) => failSession(session, error))
  child.stderr.on('data', () => {})
  child.stdin.on('error', (error) => failSession(session, error))
  void closePromise
    .then(() => {
      session.closeObserved = true
    })
    .catch((error: unknown) => {
      failSession(session, error instanceof Error ? error : new Error('Shell process failed'))
    })
  return session
}

function receiveProtocolLine(session: Session, line: string): void {
  if (Buffer.byteLength(line, 'utf8') > 64 * 1024) {
    failSession(session, new Error('Codex initialize response exceeded the protocol line limit'))
    return
  }
  let frame: unknown
  try {
    frame = JSON.parse(line)
  } catch {
    failSession(session, new Error('Codex app-server emitted invalid JSONL'))
    return
  }
  if (typeof frame !== 'object' || frame === null || !('id' in frame)) {
    return
  }
  const id = frame.id
  if (typeof id !== 'number') {
    return
  }
  const pending = session.pending.get(id)
  if (!pending) {
    return
  }
  clearTimeout(pending.timer)
  session.pending.delete(id)
  if ('error' in frame) {
    pending.reject(new Error('Codex app-server rejected initialize'))
  } else {
    pending.resolve('result' in frame ? frame.result : null)
  }
}

function failSession(session: Session, error: Error): void {
  session.protocolFailure ??= error
  for (const pending of session.pending.values()) {
    clearTimeout(pending.timer)
    pending.reject(session.protocolFailure)
  }
  session.pending.clear()
}

function appServerConnection(session: Session): CodexAppServerConnection {
  return {
    pid: session.pid,
    closed: false,
    processTreeUnproven: false,
    request: (method, params = {}, options = {}) => {
      if (session.protocolFailure) {
        return Promise.reject(session.protocolFailure)
      }
      const id = session.nextRequestId++
      return new Promise<unknown>((resolveRequest, rejectRequest) => {
        const timer = setTimeout(() => {
          session.pending.delete(id)
          rejectRequest(new Error('Codex app-server initialize timed out'))
        }, options.timeoutMs ?? 15_000)
        session.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer })
        session.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
          if (error) {
            failSession(session, error)
          }
        })
      })
    },
    notify: (method, params) => {
      const message = params === undefined ? { method } : { method, params }
      session.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          failSession(session, error)
        }
      })
    },
    respond: () => {},
    respondWithError: () => {},
    close: async () => session.closeObserved
  }
}

export async function initializeSession(session: Session): Promise<void> {
  await initializeCodexAppServerConnection(appServerConnection(session))
  session.readyAt = performance.now()
  if (session.protocolFailure) {
    throw session.protocolFailure
  }
}

export async function waitForRootIdentity(session: Session): Promise<void> {
  const deadline = Date.now() + TREE_WAIT_MS
  while (Date.now() < deadline) {
    const rows = await readWindowsProcessIdentityTableFresh()
    const root = rows.find((row) => row.pid === session.pid)
    if (root && typeof root.creationTimeMs === 'number') {
      const expectedName =
        session.shell.kind === 'bash'
          ? 'bash.exe'
          : session.shell.name === 'PowerShell 7'
            ? 'pwsh.exe'
            : 'powershell.exe'
      if (root.name.toLowerCase() !== expectedName) {
        throw new Error(
          `${session.shell.name} process identity did not match the selected executable`
        )
      }
      session.creationTimeMs = root.creationTimeMs
      session.observedProcessIdentities = [processIdentity(root)]
      return
    }
    await delay(TREE_POLL_MS)
  }
  throw new Error(`${session.shell.name} process identity was unavailable`)
}

export async function stopSession(session: Session): Promise<number> {
  const startedAt = performance.now()
  if (session.child.exitCode === null && session.child.signalCode === null) {
    session.child.stdin.end()
  }
  let close: CloseResult
  try {
    close = await withTimeout(session.closePromise, CLOSE_WAIT_MS)
  } catch (error) {
    if (session.child.exitCode === null && session.child.signalCode === null) {
      await forceTerminateProcessTree(session.child)
      close = await withTimeout(session.closePromise, CLOSE_WAIT_MS)
    } else {
      throw error
    }
  }
  await waitForProcessTreeExit(
    session.pid,
    session.creationTimeMs,
    session.observedProcessIdentities,
    { timeoutMs: CLOSE_WAIT_MS, intervalMs: TREE_POLL_MS, label: session.shell.name }
  )
  if (close.code !== 0 || close.signal !== null) {
    throw new Error(`${session.shell.name} did not exit normally after app-server EOF`)
  }
  return performance.now() - startedAt
}

function toBashPath(value: string): string {
  const slashed = value.replace(/\\/g, '/')
  return slashed.replace(/^([a-z]):\//i, (_match, drive: string) => `/${drive.toLowerCase()}/`)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
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
