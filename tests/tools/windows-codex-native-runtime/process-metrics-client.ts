import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { PipedChildProcess } from '@orca/process-host/process-spec'
import { spawnProcess } from '@orca/process-host'
import {
  jobFailure,
  isPositiveSafeInteger,
  isProcessIdentity,
  MAX_JOB_PROCESS_IDS,
  metricResponse,
  type MetricsRequest,
  type MetricsResponse,
  type ProcessMetrics
} from './process-metrics-protocol'
import { sampleFailure } from './process-metric-failure'
import type { ProcessIdentity } from './process-tree-identity'

export type { ProcessMetrics } from './process-metrics-protocol'

export const MAX_METRICS_REQUEST_TIMEOUT_MS = 10_000
export const METRICS_CLOSE_TIMEOUT_MS = MAX_METRICS_REQUEST_TIMEOUT_MS

type PendingResponse = {
  resolve: (response: MetricsResponse) => void
  reject: (error: Error) => void
  deadlineAt: number
  timeout: NodeJS.Timeout
}

export class ProcessMetricsClient {
  private readonly child: PipedChildProcess
  private readonly responses: PendingResponse[] = []
  private failure: Error | null = null
  private closing = false
  private processExited = false
  private closePromise: Promise<void> | null = null
  private closeDeadline: NodeJS.Timeout | null = null
  private rejectCloseDeadline: ((error: Error) => void) | null = null
  private readonly processClosed: Promise<void>

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
    this.processClosed = new Promise<void>((resolveClosed) => {
      this.child.once('close', (code) => {
        this.processExited = true
        this.clearResponseTimeouts()
        this.clearCloseDeadline()
        if (code !== 0 || this.child.signalCode !== null || this.responses.length > 0) {
          const failure =
            this.failure ??
            new Error(
              this.responses.length > 0
                ? 'Python metrics sampler closed with pending requests'
                : 'Python metrics sampler exited unexpectedly'
            )
          this.fail(failure)
        }
        resolveClosed()
      })
    })
    this.child.once('error', (error) => this.fail(error))
  }

  get isUnavailable(): boolean {
    return this.failure !== null || this.closing || this.processExited
  }

  sample(
    processes: ProcessIdentity[],
    timeoutMs = MAX_METRICS_REQUEST_TIMEOUT_MS
  ): Promise<ProcessMetrics[]> {
    if (this.failure) {
      return Promise.reject(this.failure)
    }
    if (processes.length === 0) {
      return Promise.reject(new Error('Cannot sample an empty process tree'))
    }
    if (processes.length > MAX_JOB_PROCESS_IDS) {
      return Promise.reject(new Error('Cannot sample an oversized process tree'))
    }
    const seen = new Set<number>()
    for (const identity of processes) {
      if (!isProcessIdentity(identity) || seen.has(identity.pid)) {
        return Promise.reject(new Error('Cannot sample invalid process identities'))
      }
      seen.add(identity.pid)
    }
    return this.request({ processes }, timeoutMs).then((response) => {
      if (!response.ok) {
        throw sampleFailure(response, processes)
      }
      if (
        !('processes' in response) ||
        response.processes.length !== processes.length ||
        response.processes.some(
          (entry, index) =>
            entry.pid !== processes[index].pid ||
            entry.creationTimeMs !== processes[index].creationTimeMs
        )
      ) {
        throw new Error('Windows process metrics returned mismatched identities')
      }
      return response.processes
    })
  }

  createJob(root: ProcessIdentity, timeoutMs = MAX_METRICS_REQUEST_TIMEOUT_MS): Promise<number> {
    if (!isProcessIdentity(root)) {
      return Promise.reject(new Error('Cannot create a job for an invalid process identity'))
    }
    return this.request(
      {
        op: 'createJob',
        root: { pid: root.pid, creationTimeMs: root.creationTimeMs }
      },
      timeoutMs
    ).then((response) => {
      if (!response.ok) {
        throw jobFailure(response)
      }
      if (!('op' in response) || response.op !== 'createJob') {
        throw new Error('Python metrics sampler returned an invalid job response')
      }
      return response.jobId
    })
  }

  listJobProcessIds(jobId: number, timeoutMs = MAX_METRICS_REQUEST_TIMEOUT_MS): Promise<number[]> {
    if (!isPositiveSafeInteger(jobId)) {
      return Promise.reject(new Error('Cannot list an invalid job ID'))
    }
    return this.request({ op: 'listJobProcessIds', jobId }, timeoutMs).then((response) => {
      if (!response.ok) {
        throw jobFailure(response)
      }
      if (!('op' in response) || response.op !== 'listJobProcessIds') {
        throw new Error('Python metrics sampler returned an invalid job process list')
      }
      return response.processIds
    })
  }

  terminateJob(jobId: number, timeoutMs = MAX_METRICS_REQUEST_TIMEOUT_MS): Promise<void> {
    return this.jobControl('terminateJob', jobId, timeoutMs)
  }

  releaseJob(jobId: number, timeoutMs = MAX_METRICS_REQUEST_TIMEOUT_MS): Promise<void> {
    return this.jobControl('releaseJob', jobId, timeoutMs)
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise
    }
    this.closing = true
    if (!this.processExited && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.stdin.end()
    }
    const closeDeadline = new Promise<void>((_resolve, reject) => {
      this.rejectCloseDeadline = reject
      this.closeDeadline = setTimeout(
        () => this.fail(new Error('Python metrics sampler close timed out')),
        METRICS_CLOSE_TIMEOUT_MS
      )
    })
    this.closePromise = Promise.race([
      this.processClosed.then(() => {
        if (this.failure) {
          throw this.failure
        }
      }),
      closeDeadline
    ]).finally(() => this.clearCloseDeadline())
    return this.closePromise
  }

  waitForExit(): Promise<void> {
    return this.processClosed
  }

  private async jobControl(
    operation: 'terminateJob' | 'releaseJob',
    jobId: number,
    timeoutMs: number
  ): Promise<void> {
    if (!isPositiveSafeInteger(jobId)) {
      throw new Error('Cannot operate on an invalid job ID')
    }
    const response = await this.request({ op: operation, jobId }, timeoutMs)
    if (!response.ok) {
      throw jobFailure(response)
    }
    if (!('op' in response) || response.op !== operation) {
      throw new Error('Python metrics sampler returned an invalid job control response')
    }
  }

  private request(request: MetricsRequest, timeoutMs: number): Promise<MetricsResponse> {
    if (this.failure) {
      return Promise.reject(this.failure)
    }
    if (this.closing || this.processExited) {
      return Promise.reject(new Error('Python metrics sampler is unavailable'))
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new Error('Python metrics sampler timeout budget is invalid'))
    }
    const boundedTimeoutMs = Math.max(
      1,
      Math.floor(Math.min(timeoutMs, MAX_METRICS_REQUEST_TIMEOUT_MS))
    )
    return new Promise<MetricsResponse>((resolveResponse, rejectResponse) => {
      const pending: PendingResponse = {
        resolve: resolveResponse,
        reject: rejectResponse,
        deadlineAt: performance.now() + boundedTimeoutMs,
        timeout: setTimeout(
          () => this.fail(new Error('Python metrics sampler request timed out')),
          boundedTimeoutMs
        )
      }
      this.responses.push(pending)
      try {
        this.child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
          if (error) {
            this.fail(error)
          }
        })
      } catch {
        this.fail(new Error('Python metrics sampler request failed'))
      }
    })
  }

  private acceptLine(line: string): void {
    if (this.failure || this.processExited) {
      return
    }
    const pending = this.responses.shift()
    if (!pending) {
      this.fail(new Error('Python metrics sampler returned an unsolicited response'))
      return
    }
    clearTimeout(pending.timeout)
    if (pending.deadlineAt <= performance.now()) {
      const failure = new Error('Python metrics sampler request timed out')
      pending.reject(failure)
      this.fail(failure)
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
    const firstFailure = this.failure === null
    this.failure ??= error
    this.clearResponseTimeouts()
    for (const pending of this.responses.splice(0)) {
      pending.reject(this.failure)
    }
    this.clearCloseDeadline(this.failure)
    if (
      firstFailure &&
      !this.processExited &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    ) {
      try {
        this.child.kill()
      } catch {
        // Cleanup must rely on the close event and process table, not a retry by PID.
      }
    }
  }

  private clearResponseTimeouts(): void {
    for (const pending of this.responses) {
      clearTimeout(pending.timeout)
    }
  }

  private clearCloseDeadline(error?: Error): void {
    const reject = this.rejectCloseDeadline
    if (this.closeDeadline) {
      clearTimeout(this.closeDeadline)
      this.closeDeadline = null
    }
    this.rejectCloseDeadline = null
    if (error) {
      reject?.(error)
    }
  }
}
