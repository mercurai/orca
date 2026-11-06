import { createInterface } from 'node:readline'
import type { PipedChildProcess } from '@orca/process-host/process-spec'
import { spawnProcess } from '@orca/process-host'
import { initializeCodexAppServerConnection } from '../../../src/main/codex/codex-app-server-handshake'
import type { CodexAppServerConnection } from '../../../src/main/codex/codex-app-server-connection-types'
import { readWindowsProcessIdentityTableFresh } from '../../../src/main/windows/windows-process-table'
import { processIdentity } from './process-tree-identity'
import type { ProcessIdentity } from './process-tree-identity'
import { RuntimeShellMilestoneCapture } from './runtime-shell-milestones'
import type { RuntimeShellMilestone } from './runtime-shell-milestones'
import { shellArgs, shellScript } from './runtime-shell-script'
import {
  createRuntimeEnvironment,
  type RuntimeMode,
  type RuntimeSettings,
  type RuntimeShell
} from './runtime-environment'

export { shellArgs, shellScript }

const TREE_WAIT_MS = 15_000
const TREE_POLL_MS = 200
const MAX_DIAGNOSTIC_COUNT = 1_000_000_000

export type CloseResult = { code: number | null; signal: NodeJS.Signals | null }
type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}
export type Session = {
  shell: RuntimeShell
  mode: RuntimeMode
  runtimeSessionIndex?: number
  latestMilestone: RuntimeShellMilestone | null
  child: PipedChildProcess
  pid: number
  creationTimeMs: number
  startedAt: number
  closePromise: Promise<CloseResult>
  pending: Map<number, PendingRequest>
  nextRequestId: number
  protocolFailure: Error | null
  closeObserved: boolean
  closeResult?: CloseResult
  stdoutBytes: number
  stdoutFrames: number
  stderrBytes: number
  readyAt?: number
  observedProcessIdentities: ProcessIdentity[]
  preGateProcessIdentities: ProcessIdentity[]
  jobId: number | null
  jobReleased: boolean
  cleanupMode?: 'normal' | 'forced'
  launchGateReleasedAt?: number
  cleanupComplete: boolean
  cleanupMs?: number
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
  homeRoot: string,
  runtimeSessionIndex?: number
): Session {
  const startedAt = performance.now()
  const child = spawnProcess({
    program: shell.executable,
    args: shellArgs(shell, shellScript(shell, settings.npmBin, false, true, true), homeRoot),
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
    ...(runtimeSessionIndex === undefined ? {} : { runtimeSessionIndex }),
    latestMilestone: null,
    child,
    pid: child.pid,
    creationTimeMs: 0,
    startedAt,
    closePromise,
    pending: new Map(),
    nextRequestId: 1,
    protocolFailure: null,
    closeObserved: false,
    stdoutBytes: 0,
    stdoutFrames: 0,
    stderrBytes: 0,
    observedProcessIdentities: [],
    preGateProcessIdentities: [],
    jobId: null,
    jobReleased: false,
    cleanupComplete: false
  }
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const milestones = new RuntimeShellMilestoneCapture((milestone) => {
    session.latestMilestone = milestone
  })
  child.stdout.on('data', (chunk: Buffer) => {
    session.stdoutBytes = Math.min(session.stdoutBytes + chunk.length, MAX_DIAGNOSTIC_COUNT)
  })
  lines.on('line', (line) => {
    session.stdoutFrames = Math.min(session.stdoutFrames + 1, MAX_DIAGNOSTIC_COUNT)
    receiveProtocolLine(session, line)
  })
  child.stdout.on('error', (error) => failSession(session, error))
  child.stderr.on('data', (chunk: Buffer) => {
    session.stderrBytes = Math.min(session.stderrBytes + chunk.length, MAX_DIAGNOSTIC_COUNT)
    milestones.consume(chunk)
  })
  child.stdin.on('error', (error) => failSession(session, error))
  void closePromise
    .then((close) => {
      session.closeObserved = true
      session.closeResult = close
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

export { stopSession } from './runtime-shell-job-cleanup'
