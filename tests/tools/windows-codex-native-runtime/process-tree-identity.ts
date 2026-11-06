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
  const result = descendantsForExitCheck(rows, rootPid, rootCreationTimeMs, beforeCreationTimeMs)
  if (result.incomplete) {
    throw new Error('The native process table omitted a descendant creation time')
  }
  return result.descendants
}

function descendantsForExitCheck(
  rows: WindowsProcessIdentityRow[],
  rootPid: number,
  rootCreationTimeMs: number,
  beforeCreationTimeMs?: number
): { descendants: WindowsProcessIdentityRow[]; incomplete: boolean } {
  const childrenByParent = new Map<number, WindowsProcessIdentityRow[]>()
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid) ?? []
    children.push(row)
    childrenByParent.set(row.ppid, children)
  }
  const descendants: WindowsProcessIdentityRow[] = []
  const pending = [rootPid]
  const seen = new Set<number>([rootPid])
  let incomplete = false
  while (pending.length > 0) {
    const parentPid = pending.pop()
    if (parentPid === undefined) {
      continue
    }
    for (const child of childrenByParent.get(parentPid) ?? []) {
      if (typeof child.creationTimeMs !== 'number') {
        incomplete = true
        continue
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
  return { descendants, incomplete }
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
  options: {
    timeoutMs: number
    intervalMs: number
    label: string
    readRows?: () => Promise<WindowsProcessIdentityRow[]>
    now?: () => number
    pause?: (milliseconds: number) => Promise<void>
  }
): Promise<void> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(`${options.label} process identity deadline was empty`)
  }
  if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error(`${options.label} process identity poll interval was empty`)
  }
  const now = options.now ?? Date.now
  const pause = options.pause ?? delay
  const readRows = options.readRows ?? readWindowsProcessIdentityTableFresh
  const deadline = now() + options.timeoutMs
  let lastState: 'live' | 'incomplete' | 'deadline' = 'live'
  while (now() < deadline) {
    const state = processTreeExitState(await readRows(), rootPid, rootCreationTimeMs, observed)
    if (now() >= deadline) {
      lastState = 'deadline'
      break
    }
    if (state === 'clear') {
      return
    }
    lastState = state
    const remainingMs = deadline - now()
    if (remainingMs > 0) {
      await pause(Math.min(options.intervalMs, remainingMs))
    }
  }
  if (lastState === 'incomplete') {
    throw new Error(`${options.label} process identity remained incomplete at close`)
  }
  if (lastState === 'deadline') {
    throw new Error(`${options.label} process identity check exceeded its close deadline`)
  }
  throw new Error(`${options.label} left live descendants after close`)
}

function processTreeExitState(
  rows: WindowsProcessIdentityRow[],
  rootPid: number,
  rootCreationTimeMs: number,
  observed: ProcessIdentity[]
): 'clear' | 'live' | 'incomplete' {
  const root = rows.find((row) => row.pid === rootPid)
  if (root && typeof root.creationTimeMs !== 'number') {
    return 'incomplete'
  }
  const rootReused = Boolean(root && root.creationTimeMs !== rootCreationTimeMs)
  if (root && !rootReused) {
    return 'live'
  }

  const observedByPid = new Map<number, Set<number>>()
  for (const identity of observed) {
    const generations = observedByPid.get(identity.pid) ?? new Set<number>()
    generations.add(identity.creationTimeMs)
    observedByPid.set(identity.pid, generations)
  }
  let incomplete = false
  for (const row of rows) {
    const generations = observedByPid.get(row.pid)
    if (!generations) {
      continue
    }
    if (typeof row.creationTimeMs !== 'number') {
      incomplete = true
    } else if (generations.has(row.creationTimeMs)) {
      return 'live'
    }
  }

  const beforeCreationTimeMs = rootReused ? root?.creationTimeMs : undefined
  const descendants = descendantsForExitCheck(
    rows,
    rootPid,
    rootCreationTimeMs,
    beforeCreationTimeMs
  )
  if (descendants.incomplete || incomplete) {
    return 'incomplete'
  }
  return descendants.descendants.length > 0 ? 'live' : 'clear'
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}
