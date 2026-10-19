import { statSync } from 'node:fs'
import { getEnvironmentStorePath } from './runtime-environment-store-records'
import { serializePathWrite } from './path-write-serializer'

let environmentWriteGeneration = 0

/** One profile transaction, before reads and through every ordered file publication. */
export function withRuntimeEnvironmentMutation<T>(
  userDataPath: string,
  mutate: () => Promise<T>
): Promise<T> {
  return serializePathWrite(`${getEnvironmentStorePath(userDataPath)}#mutation`, mutate)
}

export function bumpEnvironmentWriteGeneration(): void {
  environmentWriteGeneration += 1
}

export function getEnvironmentWriteGeneration(): number {
  return environmentWriteGeneration
}

function fileSignature(path: string): string {
  try {
    const stats = statSync(path)
    return `${stats.size}:${stats.mtimeMs}`
  } catch {
    return 'absent'
  }
}

/** Capture before reading; other processes and writers void a stale snapshot. */
export function captureEnvironmentStoreVersion(userDataPath: string): () => boolean {
  const generation = environmentWriteGeneration
  const signature = fileSignature(getEnvironmentStorePath(userDataPath))
  return () => environmentWriteGeneration === generation &&
    fileSignature(getEnvironmentStorePath(userDataPath)) === signature
}

/** Guard opaque records read before an asynchronous secure write. */
export function captureRuntimeEnvironmentFileVersion(path: string): () => boolean {
  const signature = fileSignature(path)
  return () => fileSignature(path) === signature
}
