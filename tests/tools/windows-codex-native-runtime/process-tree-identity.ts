import {
  readWindowsProcessIdentityTableFresh,
  type WindowsProcessIdentityRow
} from '../../../src/main/windows/windows-process-table'

export type ProcessIdentity = { pid: number; creationTimeMs: number }

export function processIdentity(row: WindowsProcessIdentityRow): ProcessIdentity {
  if (typeof row.creationTimeMs !== 'number') {
    throw new Error('A measured process has no creation time')
  }
  return { pid: row.pid, creationTimeMs: row.creationTimeMs }
}

export function descendantsForRoot(
  rows: WindowsProcessIdentityRow[],
  rootPid: number,
  rootCreationTimeMs: number,
  beforeCreationTimeMs?: number
): WindowsProcessIdentityRow[] {
  const childrenByParent = new Map<number, WindowsProcessIdentityRow[]>()
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid) ?? []
    children.push(row)
    childrenByParent.set(row.ppid, children)
  }
  const descendants: WindowsProcessIdentityRow[] = []
  const pending = [rootPid]
  const seen = new Set<number>([rootPid])
  while (pending.length > 0) {
    const parentPid = pending.pop()
    if (parentPid === undefined) {
      continue
    }
    for (const child of childrenByParent.get(parentPid) ?? []) {
      if (typeof child.creationTimeMs !== 'number') {
        throw new Error('The native process table omitted a descendant creation time')
      }
      if (child.creationTimeMs < rootCreationTimeMs) {
        continue
      }
      if (beforeCreationTimeMs !== undefined && child.creationTimeMs >= beforeCreationTimeMs) {
        continue
      }
      if (seen.has(child.pid)) {
        throw new Error('Native process tree contains a PID cycle')
      }
      seen.add(child.pid)
      descendants.push(child)
      pending.push(child.pid)
    }
  }
  return descendants
}

export function processTreeForRoot(
  rows: WindowsProcessIdentityRow[],
  rootPid: number,
  rootCreationTimeMs: number
): WindowsProcessIdentityRow[] {
  const root = rows.find((row) => row.pid === rootPid)
  if (!root || root.creationTimeMs !== rootCreationTimeMs) {
    throw new Error('Native process root identity changed during the session')
  }
  return [root, ...descendantsForRoot(rows, rootPid, rootCreationTimeMs)]
}

export async function waitForProcessTreeExit(
  rootPid: number,
  rootCreationTimeMs: number,
  observed: ProcessIdentity[],
  options: { timeoutMs: number; intervalMs: number; label: string }
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs
  while (Date.now() < deadline) {
    const rows = await readWindowsProcessIdentityTableFresh()
    const root = rows.find((row) => row.pid === rootPid)
    const rootReused = Boolean(
      root && typeof root.creationTimeMs === 'number' && root.creationTimeMs !== rootCreationTimeMs
    )
    const beforeCreationTimeMs = rootReused ? root?.creationTimeMs : undefined
    const observedKeys = new Set(
      observed.map((identity) => `${identity.pid}:${identity.creationTimeMs}`)
    )
    const liveObserved = rows.some((row) => observedKeys.has(`${row.pid}:${row.creationTimeMs}`))
    const descendants = descendantsForRoot(rows, rootPid, rootCreationTimeMs, beforeCreationTimeMs)
    if ((!root || rootReused) && !liveObserved && descendants.length === 0) {
      return
    }
    await delay(options.intervalMs)
  }
  throw new Error(`${options.label} left live descendants after close`)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}
