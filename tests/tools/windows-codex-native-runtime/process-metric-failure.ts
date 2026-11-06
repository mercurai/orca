import type { ProcessIdentity } from './process-tree-identity'
import type { MetricsResponse, ProcessMetricOperation } from './process-metrics-protocol'

export class ProcessMetricsIncompleteError extends Error {
  #failedIdentities: ProcessIdentity[]
  readonly operation: ProcessMetricOperation
  readonly expectedCount: number
  readonly measuredCount: number
  readonly failedIdentityCount: number
  readonly errorCode: number | null

  constructor(input: {
    operation: ProcessMetricOperation
    failedIdentities: ProcessIdentity[]
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
    this.#failedIdentities = input.failedIdentities.map((identity) => ({ ...identity }))
    this.operation = input.operation
    this.expectedCount = input.expectedCount
    this.measuredCount = input.measuredCount
    this.failedIdentityCount = input.failedIdentities.length
    this.errorCode = input.errorCode
  }

  matchesFailedIdentity(identity: ProcessIdentity): boolean {
    return this.#failedIdentities.some((failed) => sameIdentity(failed, identity))
  }

  matchesFailedIdentities(identities: ProcessIdentity[]): boolean {
    if (identities.length !== this.#failedIdentities.length) {
      return false
    }
    const candidates = new Set(identities.map(identityKey))
    return (
      candidates.size === identities.length &&
      this.#failedIdentities.every((failed) => candidates.has(identityKey(failed)))
    )
  }
}

function identityKey(identity: ProcessIdentity): string {
  return `${identity.pid}:${identity.creationTimeMs}`
}

function sameIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.pid === right.pid && left.creationTimeMs === right.creationTimeMs
}

export function sampleFailure(
  response: Extract<MetricsResponse, { ok: false }>,
  requestedProcesses: ProcessIdentity[]
): Error {
  if (response.reason === 'process_metric_unavailable') {
    const operation = response.operation
    const failedIdentities = response.failedIdentities
    const errorCode = response.errorCode
    const expectedCount = response.expectedCount
    const measuredCount = response.measuredCount
    if (
      operation === undefined ||
      failedIdentities === undefined ||
      errorCode === undefined ||
      expectedCount !== requestedProcesses.length ||
      measuredCount === undefined ||
      expectedCount - measuredCount !== failedIdentities.length ||
      new Set(failedIdentities.map(({ pid }) => pid)).size !== failedIdentities.length ||
      failedIdentities.some(
        (failed) => !requestedProcesses.some((identity) => sameIdentity(identity, failed))
      )
    ) {
      return new Error('Windows process metrics returned invalid failure diagnostics')
    }
    return new ProcessMetricsIncompleteError({
      operation,
      failedIdentities,
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
