import type { ProcessIdentity } from './process-tree-identity'

export type ProcessMetrics = ProcessIdentity & {
  imagePath: string
  privateBytes: number
  workingSetBytes: number
  handleCount: number
  kernel100ns: number
  user100ns: number
}

export const MAX_JOB_PROCESS_IDS = 4096
const MAX_PROCESS_ID = 0xffff_ffff

export const PROCESS_METRIC_OPERATIONS = [
  'open_process',
  'get_process_times',
  'query_full_process_image_name',
  'get_process_memory_info',
  'get_process_handle_count'
] as const
export type ProcessMetricOperation = (typeof PROCESS_METRIC_OPERATIONS)[number]

export type MetricsRequest =
  | { processes: ProcessIdentity[] }
  | { op: 'createJob'; root: ProcessIdentity }
  | { op: 'listJobProcessIds' | 'terminateJob' | 'releaseJob'; jobId: number }

export type MetricsResponse =
  | { ok: true; processes: ProcessMetrics[] }
  | { ok: true; op: 'createJob'; jobId: number }
  | { ok: true; op: 'listJobProcessIds'; processIds: number[] }
  | { ok: true; op: 'terminateJob' | 'releaseJob' }
  | {
      ok: false
      reason: string
      operation?: ProcessMetricOperation
      errorCode?: number | null
      expectedCount?: number
      measuredCount?: number
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0
}

function isWin32ErrorCode(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value <= 0xffff_ffff
}

function isProcessMetricOperation(value: unknown): value is ProcessMetricOperation {
  return PROCESS_METRIC_OPERATIONS.some((operation) => operation === value)
}

function isProcessCount(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value <= MAX_JOB_PROCESS_IDS
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value > 0
}

function isProcessId(value: unknown): value is number {
  return isPositiveSafeInteger(value) && value <= MAX_PROCESS_ID
}

export function isProcessIdentity(value: unknown): value is ProcessIdentity {
  return isRecord(value) && isProcessId(value.pid) && isPositiveSafeInteger(value.creationTimeMs)
}

function processMetrics(value: unknown): ProcessMetrics[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_JOB_PROCESS_IDS) {
    throw new Error('invalid sampler process list')
  }
  const seen = new Set<number>()
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      !isProcessId(entry.pid) ||
      !isPositiveSafeInteger(entry.creationTimeMs) ||
      typeof entry.imagePath !== 'string' ||
      entry.imagePath.length === 0 ||
      entry.imagePath.length > 32768 ||
      !isNonNegativeSafeInteger(entry.privateBytes) ||
      !isNonNegativeSafeInteger(entry.workingSetBytes) ||
      !isNonNegativeSafeInteger(entry.handleCount) ||
      !isNonNegativeSafeInteger(entry.kernel100ns) ||
      !isNonNegativeSafeInteger(entry.user100ns) ||
      seen.has(entry.pid)
    ) {
      throw new Error('invalid sampler process metrics')
    }
    seen.add(entry.pid)
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
}

function processIds(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > MAX_JOB_PROCESS_IDS) {
    throw new Error('invalid sampler job process list')
  }
  const seen = new Set<number>()
  return value.map((pid) => {
    if (!isProcessId(pid) || seen.has(pid)) {
      throw new Error('invalid sampler job process ID')
    }
    seen.add(pid)
    return pid
  })
}

export function metricResponse(value: unknown): MetricsResponse {
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    throw new Error('invalid sampler response')
  }
  if (value.ok) {
    if (value.op === 'createJob') {
      if (!hasOnlyKeys(value, ['ok', 'op', 'jobId']) || !isPositiveSafeInteger(value.jobId)) {
        throw new Error('invalid sampler job ID')
      }
      return { ok: true, op: value.op, jobId: value.jobId }
    }
    if (value.op === 'listJobProcessIds') {
      if (!hasOnlyKeys(value, ['ok', 'op', 'processIds'])) {
        throw new Error('invalid sampler job process list')
      }
      return { ok: true, op: value.op, processIds: processIds(value.processIds) }
    }
    if (value.op === 'terminateJob' || value.op === 'releaseJob') {
      if (!hasOnlyKeys(value, ['ok', 'op'])) {
        throw new Error('invalid sampler job control response')
      }
      return { ok: true, op: value.op }
    }
    if (value.op !== undefined) {
      throw new Error('invalid sampler operation response')
    }
    if (!hasOnlyKeys(value, ['ok', 'processes'])) {
      throw new Error('invalid sampler metric response')
    }
    return { ok: true, processes: processMetrics(value.processes) }
  }

  if (
    !hasOnlyKeys(value, [
      'ok',
      'reason',
      'operation',
      'errorCode',
      'expectedCount',
      'measuredCount'
    ]) ||
    typeof value.reason !== 'string' ||
    value.reason.length === 0 ||
    value.reason.length > 128
  ) {
    throw new Error('invalid sampler failure response')
  }
  const response: Extract<MetricsResponse, { ok: false }> = {
    ok: false,
    reason: value.reason
  }
  if ('operation' in value) {
    if (
      response.reason !== 'process_metric_unavailable' ||
      !isProcessMetricOperation(value.operation)
    ) {
      throw new Error('invalid sampler metric operation')
    }
    response.operation = value.operation
  }
  if ('errorCode' in value) {
    const errorCode = value.errorCode
    if (errorCode === null) {
      response.errorCode = null
    } else if (isWin32ErrorCode(errorCode)) {
      response.errorCode = errorCode
    } else {
      throw new Error('invalid sampler error code')
    }
  }
  if ('expectedCount' in value) {
    if (!isProcessCount(value.expectedCount)) {
      throw new Error('invalid sampler expected count')
    }
    response.expectedCount = value.expectedCount
  }
  if ('measuredCount' in value) {
    if (!isProcessCount(value.measuredCount)) {
      throw new Error('invalid sampler measured count')
    }
    response.measuredCount = value.measuredCount
  }
  if (
    response.expectedCount !== undefined &&
    response.measuredCount !== undefined &&
    response.measuredCount > response.expectedCount
  ) {
    throw new Error('invalid sampler process counts')
  }
  if (
    response.reason === 'process_metric_unavailable' &&
    (response.operation === undefined ||
      response.errorCode === undefined ||
      response.expectedCount === undefined ||
      response.measuredCount === undefined)
  ) {
    throw new Error('invalid sampler metric diagnostic')
  }
  return response
}

export class ProcessMetricsIncompleteError extends Error {
  readonly operation: ProcessMetricOperation
  readonly expectedCount: number
  readonly measuredCount: number
  readonly errorCode: number | null

  constructor(input: {
    operation: ProcessMetricOperation
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
    this.operation = input.operation
    this.expectedCount = input.expectedCount
    this.measuredCount = input.measuredCount
    this.errorCode = input.errorCode
  }
}

export function sampleFailure(
  response: Extract<MetricsResponse, { ok: false }>,
  fallbackCount: number
): Error {
  if (response.reason === 'process_metric_unavailable' && response.operation !== undefined) {
    return new ProcessMetricsIncompleteError({
      operation: response.operation,
      expectedCount: response.expectedCount ?? fallbackCount,
      measuredCount: response.measuredCount ?? 0,
      errorCode: response.errorCode ?? null
    })
  }
  return new Error(
    `Windows process metrics incomplete (${response.reason}, ` +
      `${response.measuredCount ?? 0}/${response.expectedCount ?? fallbackCount}, ` +
      `error ${response.errorCode ?? 'n/a'})`
  )
}

export function jobFailure(response: Extract<MetricsResponse, { ok: false }>): Error {
  return new Error(
    `Windows process job operation failed (${response.reason}, error ${response.errorCode ?? 'n/a'})`
  )
}
