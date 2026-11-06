import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import type { PipedChildProcess } from '@orca/process-host/process-spec'
import { spawnProcess } from '@orca/process-host'
import {
  jobFailure,
  isPositiveSafeInteger,
  isProcessIdentity,
  MAX_JOB_PROCESS_IDS,
  metricResponse,
  sampleFailure,
  type MetricsResponse,
  type ProcessMetrics
} from './process-metrics-protocol'
import type { ProcessIdentity } from './process-tree-identity'

export type { ProcessMetrics } from './process-metrics-protocol'

export class ProcessMetricsClient {
  private readonly child: PipedChildProcess
  private readonly responses: {
    resolve: (response: MetricsResponse) => void
    reject: (error: Error) => void
  }[] = []
  private failure: Error | null = null
  private closing = false
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
          if (this.responses.length > 0) {
            this.fail(new Error('Python metrics sampler closed with pending requests'))
          }
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
    return this.request({ processes }).then((response) => {
      if (!response.ok) {
        throw sampleFailure(response, processes.length)
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

  createJob(root: ProcessIdentity): Promise<number> {
    if (!isProcessIdentity(root)) {
      return Promise.reject(new Error('Cannot create a job for an invalid process identity'))
    }
    return this.request({
      op: 'createJob',
      root: { pid: root.pid, creationTimeMs: root.creationTimeMs }
    }).then((response) => {
      if (!response.ok) {
        throw jobFailure(response)
      }
      if (response.op !== 'createJob') {
        throw new Error('Python metrics sampler returned an invalid job response')
      }
      return response.jobId
    })
  }

  listJobProcessIds(jobId: number): Promise<number[]> {
    if (!isPositiveSafeInteger(jobId)) {
      return Promise.reject(new Error('Cannot list an invalid job ID'))
    }
    return this.request({ op: 'listJobProcessIds', jobId }).then((response) => {
      if (!response.ok) {
        throw jobFailure(response)
      }
      if (response.op !== 'listJobProcessIds') {
        throw new Error('Python metrics sampler returned an invalid job process list')
      }
      return response.processIds
    })
  }

  terminateJob(jobId: number): Promise<void> {
    return this.jobControl('terminateJob', jobId)
  }

  releaseJob(jobId: number): Promise<void> {
    return this.jobControl('releaseJob', jobId)
  }

  async close(): Promise<void> {
    if (!this.closing) {
      this.closing = true
      if (this.child.exitCode === null && this.child.signalCode === null) {
        this.child.stdin.end()
      }
    }
    await this.closed
  }

  private async jobControl(operation: 'terminateJob' | 'releaseJob', jobId: number): Promise<void> {
    if (!isPositiveSafeInteger(jobId)) {
      throw new Error('Cannot operate on an invalid job ID')
    }
    const response = await this.request({ op: operation, jobId })
    if (!response.ok) {
      throw jobFailure(response)
    }
    if (response.op !== operation) {
      throw new Error('Python metrics sampler returned an invalid job control response')
    }
  }

  private request(request: object): Promise<MetricsResponse> {
    if (this.failure) {
      return Promise.reject(this.failure)
    }
    if (this.closing) {
      return Promise.reject(new Error('Python metrics sampler is closing'))
    }
    return new Promise<MetricsResponse>((resolveResponse, rejectResponse) => {
      this.responses.push({ resolve: resolveResponse, reject: rejectResponse })
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
