import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import type { PipedChildProcess } from '@orca/process-host/process-spec'
import { spawnProcess } from '@orca/process-host'
import type { ProcessIdentity } from './process-tree-identity'

export type ProcessMetrics = ProcessIdentity & {
  imagePath: string
  privateBytes: number
  workingSetBytes: number
  handleCount: number
  kernel100ns: number
  user100ns: number
}

type MetricsResponse =
  | { ok: true; processes: ProcessMetrics[] }
  | {
      ok: false
      reason: string
      errorCode?: number | null
      expectedCount?: number
      measuredCount?: number
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function metricResponse(value: unknown): MetricsResponse {
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    throw new Error('invalid sampler response')
  }
  if (value.ok) {
    if (!Array.isArray(value.processes)) {
      throw new Error('invalid sampler process list')
    }
    const processes: ProcessMetrics[] = value.processes.map((entry) => {
      if (
        !isRecord(entry) ||
        !isSafeInteger(entry.pid) ||
        !isSafeInteger(entry.creationTimeMs) ||
        typeof entry.imagePath !== 'string' ||
        entry.imagePath.length === 0 ||
        !isSafeInteger(entry.privateBytes) ||
        !isSafeInteger(entry.workingSetBytes) ||
        !isSafeInteger(entry.handleCount) ||
        !isSafeInteger(entry.kernel100ns) ||
        !isSafeInteger(entry.user100ns)
      ) {
        throw new Error('invalid sampler process metrics')
      }
      return {
        pid: entry.pid,
        creationTimeMs: entry.creationTimeMs,
        imagePath: entry.imagePath,
        privateBytes: entry.privateBytes,
        workingSetBytes: entry.workingSetBytes,
        handleCount: entry.handleCount,
        kernel100ns: entry.kernel100ns,
        user100ns: entry.user100ns
      }
    })
    return { ok: true, processes }
  }
  if (typeof value.reason !== 'string') {
    throw new Error('invalid sampler failure reason')
  }
  return {
    ok: false,
    reason: value.reason,
    ...(typeof value.errorCode === 'number' ? { errorCode: value.errorCode } : {}),
    ...(typeof value.expectedCount === 'number' ? { expectedCount: value.expectedCount } : {}),
    ...(typeof value.measuredCount === 'number' ? { measuredCount: value.measuredCount } : {})
  }
}

export class ProcessMetricsClient {
  private readonly child: PipedChildProcess
  private readonly responses: {
    resolve: (response: MetricsResponse) => void
    reject: (error: Error) => void
  }[] = []
  private failure: Error | null = null
  private readonly closed: Promise<void>

  constructor(pythonExecutable: string, scriptPath: string) {
    this.child = spawnProcess({
      program: pythonExecutable,
      args: ['-u', resolve(scriptPath)],
      stdio: 'pipe',
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP
      }
    })
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => this.acceptLine(line))
    this.child.stdout.on('error', (error) => this.fail(error))
    this.child.stderr.on('data', () => {})
    this.child.stdin.on('error', (error) => this.fail(error))
    this.closed = new Promise<void>((resolveClosed, rejectClosed) => {
      this.child.once('error', rejectClosed)
      this.child.once('close', (code) => {
        if (code === 0) {
          resolveClosed()
        } else {
          rejectClosed(new Error('Python metrics sampler exited unexpectedly'))
        }
      })
    }).catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error('Python metrics sampler failed')
      this.fail(failure)
      throw failure
    })
    void this.closed.catch(() => {})
  }

  sample(processes: ProcessIdentity[]): Promise<ProcessMetrics[]> {
    if (this.failure) {
      return Promise.reject(this.failure)
    }
    if (processes.length === 0) {
      return Promise.reject(new Error('Cannot sample an empty process tree'))
    }
    return new Promise<ProcessMetrics[]>((resolveResponse, rejectResponse) => {
      this.responses.push({
        resolve: (response) => {
          if (!response.ok) {
            rejectResponse(
              new Error(
                `Windows process metrics incomplete (${response.reason}, ${response.measuredCount ?? 0}/${response.expectedCount ?? processes.length}, error ${response.errorCode ?? 'n/a'})`
              )
            )
            return
          }
          resolveResponse(response.processes)
        },
        reject: rejectResponse
      })
      this.child.stdin.write(`${JSON.stringify({ processes })}\n`, (error) => {
        if (error) {
          this.fail(error)
        }
      })
    })
  }

  async close(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.stdin.end()
    }
    await this.closed
  }

  private acceptLine(line: string): void {
    const pending = this.responses.shift()
    if (!pending) {
      this.fail(new Error('Python metrics sampler returned an unsolicited response'))
      return
    }
    try {
      pending.resolve(metricResponse(JSON.parse(line)))
    } catch {
      pending.reject(new Error('Python metrics sampler returned invalid data'))
      this.fail(new Error('Python metrics sampler returned invalid data'))
    }
  }

  private fail(error: Error): void {
    this.failure ??= error
    for (const pending of this.responses.splice(0)) {
      pending.reject(this.failure)
    }
  }
}
