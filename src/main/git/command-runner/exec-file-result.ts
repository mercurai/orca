export function isExecFileResultObject(
  value: unknown
): value is { stdout: string | Buffer; stderr: string | Buffer } {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Buffer.isBuffer(value) &&
    'stdout' in value &&
    'stderr' in value
  )
}
