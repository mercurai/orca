import {
  readWindowsProcessIdentityTableFresh,
  type WindowsProcessIdentityRow
} from '../../../src/main/windows/windows-process-table'
import { processIdentity } from './process-tree-identity'
import type { ProcessMetricsClient } from './process-metrics-client'
import type { Session } from './runtime-shell-session'

const TREE_SETTLE_COUNT = 3
const TREE_POLL_MS = 200
const TREE_WAIT_MS = 15_000
const JOB_IDENTITY_RETRIES = 3

export type TreeSnapshot = {
  session: Session
  rows: WindowsProcessIdentityRow[]
  descendants: WindowsProcessIdentityRow[]
  jobRows: WindowsProcessIdentityRow[]
  processTable: WindowsProcessIdentityRow[]
}

export async function readTrees(
  sessions: Session[],
  sampler: ProcessMetricsClient
): Promise<TreeSnapshot[]> {
  const snapshots: TreeSnapshot[] = []
  for (const session of sessions) {
    const jobId = session.jobId
    if (jobId === null) {
      throw new Error(`${session.shell.name} has no assigned runtime process job`)
    }
    const { processTable, jobRows } = await readJobRows(session, jobId, sampler)
    const tableByPid = new Map(processTable.map((row) => [row.pid, row]))
    const root = jobRows.find((row) => row.pid === session.pid)
    if (!root) {
      throw new Error(`${session.shell.name} process root was absent from its assigned job`)
    }
    const jobRowsByPid = new Map(jobRows.map((row) => [row.pid, row]))
    const preGateRows = session.preGateProcessIdentities.flatMap((identity) => {
      const row = tableByPid.get(identity.pid)
      return row?.creationTimeMs === identity.creationTimeMs ? [row] : []
    })
    const includedRows = new Map<number, WindowsProcessIdentityRow>(jobRowsByPid)
    for (const row of preGateRows) {
      if (!includedRows.has(row.pid)) {
        includedRows.set(row.pid, row)
      }
    }
    const owned = [root, ...[...includedRows.values()].filter((row) => row.pid !== session.pid)]
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
    snapshots.push({ session, rows: owned, descendants, jobRows, processTable })
  }
  return snapshots
}

async function readJobRows(
  session: Session,
  jobId: number,
  sampler: ProcessMetricsClient
): Promise<{ processTable: WindowsProcessIdentityRow[]; jobRows: WindowsProcessIdentityRow[] }> {
  for (let attempt = 0; attempt < JOB_IDENTITY_RETRIES; attempt++) {
    const processTable = await readWindowsProcessIdentityTableFresh()
    const memberPids = await sampler.listJobProcessIds(jobId)
    if (new Set(memberPids).size !== memberPids.length) {
      throw new Error(`${session.shell.name} process job returned duplicate identities`)
    }
    if (!memberPids.includes(session.pid)) {
      throw new Error(`${session.shell.name} root is absent from its assigned process job`)
    }
    const tableByPid = new Map(processTable.map((row) => [row.pid, row]))
    const missing = memberPids.filter((pid) => !tableByPid.has(pid))
    if (missing.length > 0) {
      if (attempt + 1 < JOB_IDENTITY_RETRIES) {
        await delay(TREE_POLL_MS)
        continue
      }
      throw new Error(`${session.shell.name} process job member is absent from the native table`)
    }
    const jobRows = memberPids.map((pid) => {
      const row = tableByPid.get(pid)
      if (!row) {
        throw new Error(`${session.shell.name} process job membership changed during its snapshot`)
      }
      const identity = processIdentity(row)
      if (pid === session.pid && identity.creationTimeMs !== session.creationTimeMs) {
        throw new Error(`${session.shell.name} root identity changed while the job was live`)
      }
      return row
    })
    return { processTable, jobRows }
  }
  throw new Error(`${session.shell.name} job identity snapshot was not complete`)
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
  if (
    snapshot.session.mode === 'native' &&
    snapshot.descendants.some((row) => row.name.toLowerCase() === 'node.exe')
  ) {
    throw new Error('Native Codex left a persistent Node.js process in its owned job')
  }

  const byPid = new Map(snapshot.rows.map((row) => [row.pid, row]))
  const jobPids = new Set(snapshot.jobRows.map((row) => row.pid))
  let nodeParentCount = 0
  let ownedNodeParentCount = 0
  for (const process of codex) {
    let parentPid = process.ppid
    const seen = new Set<number>()
    let hasNodeParent = false
    let hasOwnedNodeParent = false
    while (parentPid !== snapshot.session.pid) {
      if (seen.has(parentPid)) {
        throw new Error('Native process ancestry contains a PID cycle')
      }
      seen.add(parentPid)
      const parent = byPid.get(parentPid)
      if (!parent) {
        if (snapshot.session.mode === 'optout' && hasNodeParent && hasOwnedNodeParent) {
          break
        }
        throw new Error('Codex ancestry is incomplete in the owned process identities')
      }
      if (parent.name.toLowerCase() === 'node.exe') {
        hasNodeParent = true
        if (jobPids.has(parent.pid)) {
          hasOwnedNodeParent = true
        }
      }
      parentPid = parent.ppid
    }
    if (hasNodeParent) {
      nodeParentCount++
    }
    if (hasOwnedNodeParent) {
      ownedNodeParentCount++
    }
  }
  if (snapshot.session.mode === 'native' && nodeParentCount !== 0) {
    throw new Error('Native Codex still has a persistent Node.js launcher parent')
  }
  if (snapshot.session.mode === 'optout' && ownedNodeParentCount === 0) {
    throw new Error('The opt-out launch did not retain its npm Node.js parent in the owned job')
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

export async function waitForStableTrees(
  sessions: Session[],
  sampler: ProcessMetricsClient,
  timeoutMs = TREE_WAIT_MS
): Promise<TreeSnapshot[]> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Codex process tree settle deadline was empty')
  }
  const deadline = Date.now() + Math.min(TREE_WAIT_MS, timeoutMs)
  let previous = ''
  let stable = 0
  let latest: TreeSnapshot[] = []
  while (Date.now() < deadline) {
    latest = await readTrees(sessions, sampler)
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
