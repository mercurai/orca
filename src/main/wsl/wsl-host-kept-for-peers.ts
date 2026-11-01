/**
 * R39: a Remove that kept a WSL host's server for another Orca leaves that server, and anything a
 * move put on it, running. Undo of such a move must not read the removed host as stopped.
 */
import { join } from 'node:path'
import { z } from 'zod'
import { writeSecureJsonFileWithinLimitAsync } from '../../shared/bounded-secure-json-file'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { serializePathWrite } from '../../shared/path-write-serializer'

const KEPT_FILE = 'orca-wsl-hosts-kept-for-peers.json'
const MAX_KEPT_FILE_BYTES = 64 * 1024

const KeptListSchema = z.object({
  version: z.literal(1),
  environmentIds: z.array(z.string().min(1).max(256))
})

function keptFile(userDataPath: string): string {
  return join(userDataPath, KEPT_FILE)
}

function readKeptList(userDataPath: string): string[] {
  try {
    const { buffer } = readNodeFileSyncWithinLimit(keptFile(userDataPath), MAX_KEPT_FILE_BYTES)
    return KeptListSchema.parse(JSON.parse(buffer.toString('utf8'))).environmentIds
  } catch {
    return []
  }
}

function mutateKeptList(
  userDataPath: string,
  update: (current: string[]) => string[]
): Promise<void> {
  const path = keptFile(userDataPath)
  return serializePathWrite(`${path}#kept-for-peers-mutation`, async () => {
    const current = readKeptList(userDataPath)
    const next = update(current)
    if (next === current) {
      return
    }
    await writeSecureJsonFileWithinLimitAsync(
      path,
      { version: 1, environmentIds: next },
      MAX_KEPT_FILE_BYTES,
      { durable: true }
    )
  })
}

/** Rejects when it can't be saved, so the caller doesn't report a plain stop. */
export function recordWslHostKeptForPeers(
  userDataPath: string,
  environmentId: string
): Promise<void> {
  return mutateKeptList(userDataPath, (current) =>
    current.includes(environmentId) ? current : [...current, environmentId]
  )
}

export function wasWslHostKeptForPeers(userDataPath: string, environmentId: string): boolean {
  return readKeptList(userDataPath).includes(environmentId)
}

/** A later Remove proved the server stopped: nothing of the host runs on. */
export function forgetWslHostKeptForPeers(
  userDataPath: string,
  environmentId: string
): Promise<void> {
  return mutateKeptList(userDataPath, (current) =>
    current.includes(environmentId) ? current.filter((id) => id !== environmentId) : current
  )
}
