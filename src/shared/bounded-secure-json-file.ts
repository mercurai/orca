import { stringifyJsonWithinByteLimit } from './node-bounded-json-stringify'
import { writeSecureFile } from './secure-file'
import { writeSecureFileAsync } from './secure-file-async-write'

export function writeSecureJsonFileWithinLimit(
  targetPath: string,
  value: unknown,
  maxBytes: number,
  options: { durable?: boolean } = {}
): void {
  writeSecureFile(targetPath, stringifyJsonWithinByteLimit(value, maxBytes).serialized, options)
}

/** Async lane; use it from anything an IPC handler can reach. See `writeSecureFileAsync`. */
export async function writeSecureJsonFileWithinLimitAsync(
  targetPath: string,
  value: unknown,
  maxBytes: number,
  options: { durable?: boolean } = {}
): Promise<void> {
  await writeSecureFileAsync(
    targetPath,
    stringifyJsonWithinByteLimit(value, maxBytes).serialized,
    options
  )
}
