import {
  readWindowsProcessIdentityTableFresh,
  type WindowsProcessIdentityRow
} from '../../../src/main/windows/windows-process-table'
import { processIdentity, processTreeForRoot } from './process-tree-identity'
import type { Session } from './runtime-shell-session'

const TREE_SETTLE_COUNT = 3
const TREE_POLL_MS = 200
const TREE_WAIT_MS = 15_000

export type TreeSnapshot = {
  session: Session
  rows: WindowsProcessIdentityRow[]
  descendants: WindowsProcessIdentityRow[]
}

export async function readTrees(sessions: Session[]): Promise<TreeSnapshot[]> {
  const rows = await readWindowsProcessIdentityTableFresh()
  return sessions.map((session) => {
    const owned = processTreeForRoot(rows, session.pid, session.creationTimeMs)
    const root = owned[0]
    if (!root) {
      throw new Error(`${session.shell.name} process root was absent from the native table`)
    }
    const descendants = owned.slice(1)
    const observed = new Map(
      session.observedProcessIdentities.map((identity) => [
        `${identity.pid}:${identity.creationTimeMs}`,
        identity
      ])
    )
    for (const row of owned) {
      const identity = processIdentity(row)
      observed.set(`${identity.pid}:${identity.creationTimeMs}`, identity)
    }
    session.observedProcessIdentities = [...observed.values()]
    return { session, rows: owned, descendants }
  })
}

export function validateTree(snapshot: TreeSnapshot): void {
  const codex = snapshot.descendants.filter((row) => row.name.toLowerCase() === 'codex.exe')
  if (codex.length === 0) {
    throw new Error(`${snapshot.session.shell.name} has no live Codex executable`)
  }
  if (snapshot.descendants.some((row) => row.name.toLowerCase() === 'orca.exe')) {
    throw new Error('The offline resolver remained alive after native Codex started')
  }

  const byPid = new Map(snapshot.rows.map((row) => [row.pid, row]))
  let nodeParentCount = 0
  for (const process of codex) {
    let parentPid = process.ppid
    const seen = new Set<number>()
    let hasNodeParent = false
    while (parentPid !== snapshot.session.pid) {
      if (seen.has(parentPid)) {
        throw new Error('Native process ancestry contains a PID cycle')
      }
      seen.add(parentPid)
      const parent = byPid.get(parentPid)
      if (!parent) {
        throw new Error('Codex ancestry is incomplete in the native process table')
      }
      if (parent.name.toLowerCase() === 'node.exe') {
        hasNodeParent = true
      }
      parentPid = parent.ppid
    }
    if (hasNodeParent) {
      nodeParentCount++
    }
  }
  if (snapshot.session.mode === 'native' && nodeParentCount !== 0) {
    throw new Error('Native Codex still has a persistent Node.js launcher parent')
  }
  if (snapshot.session.mode === 'optout' && nodeParentCount === 0) {
    throw new Error('The opt-out launch did not retain the npm Node.js launcher parent')
  }
}

export function treeSignature(snapshots: TreeSnapshot[]): string {
  return snapshots
    .map(
      ({ session, rows }) =>
        `${session.pid}:${rows
          .map((row) => `${row.pid}:${row.creationTimeMs}`)
          .sort()
          .join(',')}`
    )
    .join('|')
}

export async function waitForStableTrees(sessions: Session[]): Promise<TreeSnapshot[]> {
  const deadline = Date.now() + TREE_WAIT_MS
  let previous = ''
  let stable = 0
  let latest: TreeSnapshot[] = []
  while (Date.now() < deadline) {
    latest = await readTrees(sessions)
    for (const snapshot of latest) {
      validateTree(snapshot)
    }
    const signature = treeSignature(latest)
    stable = signature === previous ? stable + 1 : 1
    if (stable >= TREE_SETTLE_COUNT) {
      return latest
    }
    previous = signature
    await delay(TREE_POLL_MS)
  }
  throw new Error('Codex process trees did not reach a settled state')
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}
