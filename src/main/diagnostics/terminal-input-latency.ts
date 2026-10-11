// Why: attributes slow terminal typing (IPC arrival lag vs. local PTY round trip) before any fix.

const MAX_SAMPLES_PER_WINDOW = 2_000
const MAX_PLAUSIBLE_LAG_MS = 60_000
const ECHO_PENDING_EXPIRY_MS = 5_000
const BUSY_OUTPUT_WINDOW_MS = 250
const OUTPUT_HISTORY_EXPIRY_MS = 60_000

export type TerminalInputLatencyWindow = {
  inputCount: number
  ipcLagP50Ms: number
  ipcLagP95Ms: number
  ipcLagMaxMs: number
  echoCount: number
  echoP50Ms: number
  echoP95Ms: number
  echoMaxMs: number
  echoSkippedBusy: number
  echoSkippedRemote: number
}

export type TerminalInputNote = { inputKind: unknown; isLocalPty: boolean }

type Clock = { wallNow: () => number; monoNow: () => number }

const defaultClock: Clock = { wallNow: () => Date.now(), monoNow: () => performance.now() }

export function createTerminalInputLatencyProbe(clock: Clock = defaultClock): {
  noteInput: (ptyId: string, sentAtWallMs: unknown, note: TerminalInputNote) => void
  noteOutput: (ptyId: string) => void
  drain: () => TerminalInputLatencyWindow
} {
  let inputCount = 0
  let ipcLags: number[] = []
  let echoes: number[] = []
  let skippedBusy = 0
  let skippedRemote = 0
  const pendingEcho = new Map<string, number>()
  const lastOutputAt = new Map<string, number>()

  const noteInput = (ptyId: string, sentAtWallMs: unknown, note: TerminalInputNote): void => {
    // Why: launch commands and terminal query replies are not keystrokes.
    if (note.inputKind !== 'driving') {
      return
    }
    inputCount++
    if (typeof sentAtWallMs === 'number' && Number.isFinite(sentAtWallMs)) {
      const lag = clock.wallNow() - sentAtWallMs
      if (lag >= 0 && lag <= MAX_PLAUSIBLE_LAG_MS && ipcLags.length < MAX_SAMPLES_PER_WINDOW) {
        ipcLags.push(lag)
      }
    }
    const now = clock.monoNow()
    const pending = pendingEcho.get(ptyId)
    if (pending !== undefined && now - pending <= ECHO_PENDING_EXPIRY_MS) {
      return
    }
    pendingEcho.delete(ptyId)
    if (!note.isLocalPty) {
      skippedRemote++
      return
    }
    // Why: a streaming TUI's next frame would read as an echo far shorter than the real one.
    const lastOutput = lastOutputAt.get(ptyId)
    if (lastOutput !== undefined && now - lastOutput < BUSY_OUTPUT_WINDOW_MS) {
      skippedBusy++
      return
    }
    pendingEcho.set(ptyId, now)
  }

  const noteOutput = (ptyId: string): void => {
    const now = clock.monoNow()
    const startedAt = pendingEcho.get(ptyId)
    if (startedAt === undefined) {
      lastOutputAt.set(ptyId, now)
      return
    }
    // Why: the echo itself is not streaming; stamping it would mark every fast keystroke busy.
    pendingEcho.delete(ptyId)
    if (now - startedAt <= ECHO_PENDING_EXPIRY_MS && echoes.length < MAX_SAMPLES_PER_WINDOW) {
      echoes.push(now - startedAt)
    }
  }

  const drain = (): TerminalInputLatencyWindow => {
    const now = clock.monoNow()
    for (const [ptyId, startedAt] of pendingEcho) {
      if (now - startedAt > ECHO_PENDING_EXPIRY_MS) {
        pendingEcho.delete(ptyId)
      }
    }
    for (const [ptyId, at] of lastOutputAt) {
      if (now - at > OUTPUT_HISTORY_EXPIRY_MS) {
        lastOutputAt.delete(ptyId)
      }
    }
    const lags = [...ipcLags].sort((a, b) => a - b)
    const echoTimes = [...echoes].sort((a, b) => a - b)
    const result: TerminalInputLatencyWindow = {
      inputCount,
      ipcLagP50Ms: percentile(lags, 0.5),
      ipcLagP95Ms: percentile(lags, 0.95),
      ipcLagMaxMs: percentile(lags, 1),
      echoCount: echoTimes.length,
      echoP50Ms: percentile(echoTimes, 0.5),
      echoP95Ms: percentile(echoTimes, 0.95),
      echoMaxMs: percentile(echoTimes, 1),
      echoSkippedBusy: skippedBusy,
      echoSkippedRemote: skippedRemote
    }
    inputCount = 0
    ipcLags = []
    echoes = []
    skippedBusy = 0
    skippedRemote = 0
    return result
  }

  return { noteInput, noteOutput, drain }
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) {
    return 0
  }
  const index = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)
  return Math.round(sorted[Math.max(0, index)])
}

export const terminalInputLatency = createTerminalInputLatencyProbe()
