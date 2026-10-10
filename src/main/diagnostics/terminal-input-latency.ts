// Why: attributes slow terminal typing (IPC arrival lag vs. PTY round trip) before any fix.

const MAX_SAMPLES_PER_WINDOW = 2_000
const MAX_PLAUSIBLE_LAG_MS = 60_000
const ECHO_PENDING_EXPIRY_MS = 5_000

export type TerminalInputLatencyWindow = {
  inputCount: number
  ipcLagP50Ms: number
  ipcLagP95Ms: number
  ipcLagMaxMs: number
  echoCount: number
  echoP50Ms: number
  echoP95Ms: number
  echoMaxMs: number
}

type Clock = { wallNow: () => number; monoNow: () => number }

const defaultClock: Clock = { wallNow: () => Date.now(), monoNow: () => performance.now() }

export function createTerminalInputLatencyProbe(clock: Clock = defaultClock): {
  noteInput: (ptyId: string, sentAtWallMs: unknown) => void
  noteOutput: (ptyId: string) => void
  drain: () => TerminalInputLatencyWindow
} {
  let inputCount = 0
  let ipcLags: number[] = []
  let echoes: number[] = []
  const pendingEcho = new Map<string, number>()

  const noteInput = (ptyId: string, sentAtWallMs: unknown): void => {
    inputCount++
    if (typeof sentAtWallMs === 'number' && Number.isFinite(sentAtWallMs)) {
      const lag = clock.wallNow() - sentAtWallMs
      if (lag >= 0 && lag <= MAX_PLAUSIBLE_LAG_MS && ipcLags.length < MAX_SAMPLES_PER_WINDOW) {
        ipcLags.push(lag)
      }
    }
    // Why: the first output after the first unanswered keystroke is the echo; later keys share it.
    if (!pendingEcho.has(ptyId)) {
      pendingEcho.set(ptyId, clock.monoNow())
    }
  }

  const noteOutput = (ptyId: string): void => {
    const startedAt = pendingEcho.get(ptyId)
    if (startedAt === undefined) {
      return
    }
    pendingEcho.delete(ptyId)
    if (echoes.length < MAX_SAMPLES_PER_WINDOW) {
      echoes.push(clock.monoNow() - startedAt)
    }
  }

  const drain = (): TerminalInputLatencyWindow => {
    const now = clock.monoNow()
    for (const [ptyId, startedAt] of pendingEcho) {
      if (now - startedAt > ECHO_PENDING_EXPIRY_MS) {
        pendingEcho.delete(ptyId)
      }
    }
    const result: TerminalInputLatencyWindow = {
      inputCount,
      ipcLagP50Ms: percentile(ipcLags, 0.5),
      ipcLagP95Ms: percentile(ipcLags, 0.95),
      ipcLagMaxMs: percentile(ipcLags, 1),
      echoCount: echoes.length,
      echoP50Ms: percentile(echoes, 0.5),
      echoP95Ms: percentile(echoes, 0.95),
      echoMaxMs: percentile(echoes, 1)
    }
    inputCount = 0
    ipcLags = []
    echoes = []
    return result
  }

  return { noteInput, noteOutput, drain }
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) {
    return 0
  }
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)
  return Math.round(sorted[Math.max(0, index)])
}

export const terminalInputLatency = createTerminalInputLatencyProbe()
