import type { ProcessIdentity } from './process-tree-identity'
import type { MetricsResponse, ProcessMetricOperation } from './process-metrics-protocol'

export class ProcessMetricsIncompleteError extends Error {
  #failedIdentity: ProcessIdentity
  readonly operation: ProcessMetricOperation
  readonly expectedCount: number
  readonly measuredCount: number
  readonly errorCode: number | null

  constructor(input: {
    operation: ProcessMetricOperation
    failedIdentity: ProcessIdentity
    expectedCount: number
    measuredCount: number
    errorCode: number | null
  }) {
    super(
      `Windows process metrics incomplete (process_metric_unavailable, ` +
        `operation=${input.operation}, ${input.measuredCount}/${input.expectedCount}, ` +
        `error ${input.errorCode ?? 'n/a'})`
    )
    this.name = 'ProcessMetricsIncompleteError'
    this.#failedIdentity = {
      pid: input.failedIdentity.pid,
      creationTimeMs: input.failedIdentity.creationTimeMs
    }
    this.operation = input.operation
    this.expectedCount = input.expectedCount
    this.measuredCount = input.measuredCount
    this.errorCode = input.errorCode
  }

  matchesFailedIdentity(identity: ProcessIdentity): boolean {
    return (
      identity.pid === this.#failedIdentity.pid &&
      identity.creationTimeMs === this.#failedIdentity.creationTimeMs
    )
  }
}

export function sampleFailure(
  response: Extract<MetricsResponse, { ok: false }>,
  requestedProcesses: ProcessIdentity[]
): Error {
  if (response.reason === 'process_metric_unavailable') {
    const operation = response.operation
    const failedIdentity = response.failedIdentity
    const errorCode = response.errorCode
    const expectedCount = response.expectedCount
    const measuredCount = response.measuredCount
    if (
      operation === undefined ||
      failedIdentity === undefined ||
      errorCode === undefined ||
      expectedCount !== requestedProcesses.length ||
      measuredCount === undefined ||
      !requestedProcesses.some(
        (identity) =>
          identity.pid === failedIdentity.pid &&
          identity.creationTimeMs === failedIdentity.creationTimeMs
      )
    ) {
      return new Error('Windows process metrics returned invalid failure diagnostics')
    }
    return new ProcessMetricsIncompleteError({
      operation,
      failedIdentity,
      expectedCount,
      measuredCount,
      errorCode
    })
  }
  return new Error(
    `Windows process metrics incomplete (${response.reason}, ` +
      `${response.measuredCount ?? 0}/${response.expectedCount ?? requestedProcesses.length}, ` +
      `error ${response.errorCode ?? 'n/a'})`
  )
}
