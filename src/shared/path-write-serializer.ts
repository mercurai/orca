// Why: an atomic publish is write-tmp → fsync → rename, three awaits wide once it is async. Two
// concurrent writers on one destination can interleave those steps and publish a payload that is
// neither writer's — the one hazard the sync→async conversion introduces. Writes to a given final
// path therefore run one at a time, in call order.
// ponytail: keyed on the literal path string, so two spellings of one file (symlink, `..`) do not
// share a lane; every caller here builds the path from the same resolver, and realpath() would add
// a syscall to the fast path it exists to protect.
const pendingByPath = new Map<string, Promise<void>>()
const discardEpochByPath = new Map<string, number>()

/** Why: a delete must beat every write already queued for the path, or a cleared secret comes back. */
export function discardPendingPathWrites(finalPath: string): void {
  discardEpochByPath.set(finalPath, (discardEpochByPath.get(finalPath) ?? 0) + 1)
}

export function pathDiscardEpoch(finalPath: string): number {
  return discardEpochByPath.get(finalPath) ?? 0
}

export async function serializePathWrite<T>(
  finalPath: string,
  write: () => Promise<T>
): Promise<T> {
  const previous = pendingByPath.get(finalPath) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  pendingByPath.set(finalPath, current)

  await previous
  try {
    return await write()
  } finally {
    release()
    if (pendingByPath.get(finalPath) === current) {
      pendingByPath.delete(finalPath)
    }
  }
}

/** Why exposed: map deletion is the only thing keeping this from being a per-path leak. */
export function pendingPathWriteCountForTests(): number {
  return pendingByPath.size
}

/** Paths with a write queued or running; for the quit-deadline warning (paths only, never contents). */
export function pendingPathWritePaths(): string[] {
  return [...pendingByPath.keys()]
}

/** Why: the sync writers always finished before quit; quit must wait for the async ones too. Also the
 *  seam for fire-and-forget callers (`markEnvironmentUsedDetached`) that have no handle to await. */
export async function drainPendingPathWrites(): Promise<void> {
  while (pendingByPath.size > 0) {
    await Promise.all(pendingByPath.values())
  }
}
