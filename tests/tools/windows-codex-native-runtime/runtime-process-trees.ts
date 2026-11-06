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
  processTable: WindowsProcessIdentityRow[]
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
    return { session, rows: owned, descendants, processTable: rows }
  })
}

export function validateTree(snapshot: TreeSnapshot): void {
  const codex = snapshot.descendants.filter((row) => row.name.toLowerCase() === 'codex.exe')
  if (codex.length === 0) {
    throw new Error(
      `${snapshot.session.shell.name} has no live Codex executable; ${missingCodexDiagnostic(snapshot)}`
    )
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

function missingCodexDiagnostic(snapshot: TreeSnapshot): string {
  const treeLabels = new Map(snapshot.rows.map((row, index) => [row.pid, `p${index}`]))
  const tableByPid = new Map(snapshot.processTable.map((row) => [row.pid, row]))
  const owned = snapshot.rows.slice(0, 8).map((row) => {
    const label = treeLabels.get(row.pid) ?? 'p?'
    const parentLabel = treeLabels.get(row.ppid) ?? 'outside'
    return `${label}:${safeProcessName(row.name)}<-${parentLabel}`
  })
  const outsideCodexRows = snapshot.processTable.filter(
    (row) => row.name.toLowerCase() === 'codex.exe' && !treeLabels.has(row.pid)
  )
  const outsideCodex = outsideCodexRows.slice(0, 4).map((row, index) => {
    const parent = tableByPid.get(row.ppid)
    const relation = processRelationToRoot(row, tableByPid, snapshot.session.pid)
    const parentName = parent ? safeProcessName(parent.name) : 'missing'
    return `x${index}:${safeProcessName(row.name)}<-${parentName}:${relation}`
  })
  const omittedOwned = Math.max(0, snapshot.rows.length - owned.length)
  const outsideCodexCount = outsideCodexRows.length
  return (
    `mode=${snapshot.session.mode} tree=${snapshot.rows.length}` +
    ` [${owned.join(',')}${omittedOwned ? ',+' + omittedOwned : ''}]` +
    ` outsideCodex=${outsideCodexCount}` +
    ` [${outsideCodex.join(',')}${outsideCodexCount > outsideCodex.length ? ',…' : ''}]`
  )
}

function processRelationToRoot(
  row: WindowsProcessIdentityRow,
  tableByPid: Map<number, WindowsProcessIdentityRow>,
  rootPid: number
): 'root-chain' | 'parent-missing' | 'outside-root' | 'cycle' {
  let current: WindowsProcessIdentityRow | undefined = row
  const seen = new Set<number>()
  while (current) {
    if (current.pid === rootPid) {
      return 'root-chain'
    }
    if (seen.has(current.pid)) {
      return 'cycle'
    }
    seen.add(current.pid)
    if (current.ppid === 0) {
      return 'outside-root'
    }
    current = tableByPid.get(current.ppid)
  }
  return 'parent-missing'
}

function safeProcessName(name: string): string {
  const basename = name.split(/[\\/]/u).at(-1) ?? ''
  return /^[A-Za-z0-9_.-]{1,64}$/u.test(basename) ? basename : 'other'
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
