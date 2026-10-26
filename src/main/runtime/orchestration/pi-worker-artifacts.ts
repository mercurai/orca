import { createHash } from 'node:crypto'
import { lstat, open, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { OrchestrationError } from './orchestration-error'

function invalid(message = 'Pi artifact validation failed.'): never {
  throw new OrchestrationError('pi_package_invalid', message)
}
/** Normalize Windows separators/8.3 names while refusing symbolic links and junctions. */
export async function exactPath(path: string): Promise<string> {
  if (!isAbsolute(path)) invalid('Pi artifacts require absolute paths.')
  const normalized = resolve(path)
  let cursor = normalized
  for (;;) {
    if ((await lstat(cursor)).isSymbolicLink()) invalid('Pi artifact reparse paths are not admitted.')
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return realpath(normalized)
}

export async function fileHash(path: string, maxBytes: number): Promise<string> {
  try {
    const canonicalPath = await exactPath(path)
    const file = await open(canonicalPath, 'r')
    try {
      const before = await file.stat()
      if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) invalid()
      const digest = createHash('sha256')
      const buffer = Buffer.alloc(65536)
      let total = 0
      for (;;) {
        const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
        if (bytesRead === 0) break
        total += bytesRead
        if (total > maxBytes) invalid()
        digest.update(buffer.subarray(0, bytesRead))
      }
      const after = await file.stat()
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || total !== before.size) invalid()
      return digest.digest('hex')
    } finally {
      await file.close()
    }
  } catch {
    return invalid('Pi artifact bytes could not be verified.')
  }
}

export async function pinnedObject(path: string, expectedHash: string): Promise<Record<string, unknown>> {
  if (await fileHash(path, 1024 * 1024) !== expectedHash) invalid()
  const bytes = await readFile(await exactPath(path))
  if (bytes.length > 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== expectedHash) invalid()
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
    return { ...value }
  } catch {
    return invalid('Pi artifact JSON is invalid.')
  }
}

export async function writeExclusive(path: string, content: string): Promise<void> {
  const file = await open(path, 'wx', 0o600)
  try {
    await file.writeFile(content)
    await file.sync()
  } finally {
    await file.close()
  }
}
