import { win32 } from 'node:path'
import type { WindowsCodexNativeFallbackReason } from '@orca/process-host/windows-codex-native-resolution'
import { RuntimeClientError } from './runtime/types'

export type CodexNativeOutputFormat = 'json' | 'records'

type NativeResponse = {
  schemaVersion: 1
  outcome: 'native'
  nativeExecutable: string
  environmentDelta: { managedPackageRoot: string; manager: 'npm' }
}

type FallbackResponse = {
  schemaVersion: 1
  outcome: 'fallback'
  reason: CodexNativeFallbackReason
}

type CodexNativeFallbackReason = WindowsCodexNativeFallbackReason

const FALLBACK_REASONS = [
  'unsupported_context',
  'unrecognized_launcher',
  'unverified_install',
  'native_unavailable',
  'resolver_failure'
] as const
const MAX_PROTOCOL_BYTES = 16 * 1024

export function hasProtocolControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true
    }
  }
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(record: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(record).sort()
  const expected = keys.slice().sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isFallbackReason(value: unknown): value is CodexNativeFallbackReason {
  return typeof value === 'string' && FALLBACK_REASONS.some((reason) => reason === value)
}

function hasCleanWindowsPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    win32.isAbsolute(value) &&
    win32.parse(value).root.length > 1 &&
    !hasProtocolControlCharacters(value)
  )
}

function invalidResolution(): never {
  throw new RuntimeClientError(
    'runtime_error',
    'The native Codex resolver returned invalid protocol data.'
  )
}

function toResponse(resolution: unknown): NativeResponse | FallbackResponse {
  if (!isRecord(resolution) || typeof resolution.outcome !== 'string') {
    return invalidResolution()
  }

  if (resolution.outcome === 'fallback') {
    if (!hasExactKeys(resolution, ['outcome', 'reason']) || !isFallbackReason(resolution.reason)) {
      return invalidResolution()
    }
    return { schemaVersion: 1, outcome: 'fallback', reason: resolution.reason }
  }

  if (
    resolution.outcome !== 'native' ||
    !hasExactKeys(resolution, ['outcome', 'nativeExecutable', 'environmentDelta'])
  ) {
    return invalidResolution()
  }
  if (!hasCleanWindowsPath(resolution.nativeExecutable) || !isRecord(resolution.environmentDelta)) {
    return invalidResolution()
  }

  const environmentDelta = resolution.environmentDelta
  if (
    !hasExactKeys(environmentDelta, ['managedPackageRoot', 'manager']) ||
    !hasCleanWindowsPath(environmentDelta.managedPackageRoot) ||
    environmentDelta.manager !== 'npm'
  ) {
    return invalidResolution()
  }

  return {
    schemaVersion: 1,
    outcome: 'native',
    nativeExecutable: resolution.nativeExecutable,
    environmentDelta: {
      managedPackageRoot: environmentDelta.managedPackageRoot,
      manager: 'npm'
    }
  }
}

function formatResponse(
  response: NativeResponse | FallbackResponse,
  format: CodexNativeOutputFormat
): string {
  if (format === 'json') {
    return `${JSON.stringify(response)}\n`
  }

  const records =
    response.outcome === 'native'
      ? [
          'ORCA_CODEX_NATIVE_V1',
          'native',
          response.nativeExecutable,
          response.environmentDelta.managedPackageRoot,
          response.environmentDelta.manager,
          'END_ORCA_CODEX_NATIVE_V1'
        ]
      : ['ORCA_CODEX_NATIVE_V1', 'fallback', response.reason, 'END_ORCA_CODEX_NATIVE_V1']
  return `${records.join('\n')}\n`
}

export function serializeCodexNativeResolution(
  resolution: unknown,
  format: CodexNativeOutputFormat
): string {
  const output = formatResponse(toResponse(resolution), format)
  if (Buffer.byteLength(output, 'utf8') > MAX_PROTOCOL_BYTES) {
    throw new RuntimeClientError(
      'runtime_error',
      'The native Codex resolver output exceeds 16 KiB.'
    )
  }
  return output
}
