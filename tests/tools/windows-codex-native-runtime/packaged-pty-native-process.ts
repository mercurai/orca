import type { WindowsProcessIdentityRow } from '../../../src/main/windows/windows-process-table'
import {
  isWindowsProcessStartTimeAvailable,
  isWindowsProcessTableAvailable,
  readWindowsProcessIdentityTableFresh
} from '../../../src/main/windows/windows-process-table'
import { delay } from './packaged-pty-app-support'
import { processIdentity, processTreeForRoot, type ProcessIdentity } from './process-tree-identity'

export type ShellIdentity = ProcessIdentity & { name: string }
export type NativeCodexIdentity = ProcessIdentity & { name: string }

export async function assertNativeProcessTableReady(): Promise<void> {
  if (!isWindowsProcessTableAvailable() || !isWindowsProcessStartTimeAvailable()) {
    throw new Error('The packaged PTY proof requires native process identities with creation times')
  }
  const ownRows = await readWindowsProcessIdentityTableFresh()
  if (!ownRows.some((row) => row.pid === process.pid && typeof row.creationTimeMs === 'number')) {
    throw new Error('The native process table did not identify the packaged PTY test runner')
  }
}

function nativeCodexFromShell(
  rows: WindowsProcessIdentityRow[],
  shell: ShellIdentity
): NativeCodexIdentity {
  const tree = processTreeForRoot(rows, shell.pid, shell.creationTimeMs)
  const codexRows = tree.slice(1).filter((row) => row.name.toLowerCase() === 'codex.exe')
  if (codexRows.length === 0) {
    throw new Error('The packaged PTY did not launch native codex.exe')
  }
  if (tree.some((row) => row.name.toLowerCase() === 'orca.exe')) {
    throw new Error('The offline resolver remained alive after native Codex started')
  }

  const byPid = new Map(tree.map((row) => [row.pid, row]))
  for (const codex of codexRows) {
    let parentPid = codex.ppid
    const seen = new Set<number>()
    while (parentPid !== shell.pid) {
      if (seen.has(parentPid)) {
        throw new Error('The packaged Codex ancestry contains a PID cycle')
      }
      seen.add(parentPid)
      const parent = byPid.get(parentPid)
      if (!parent) {
        throw new Error('The packaged Codex ancestry is incomplete')
      }
      if (['node.exe', 'cmd.exe', 'orca.exe'].includes(parent.name.toLowerCase())) {
        throw new Error('The packaged native Codex process retained a Node, cmd, or Orca parent')
      }
      parentPid = parent.ppid
    }
  }

  const selected = codexRows[0]
  if (!selected || typeof selected.creationTimeMs !== 'number') {
    throw new Error('The native Codex process had no creation-time identity')
  }
  return { ...processIdentity(selected), name: selected.name }
}

export async function waitForNativeCodex(
  shell: ShellIdentity
): Promise<{ codex: NativeCodexIdentity; tree: ProcessIdentity[] }> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const rows = await readWindowsProcessIdentityTableFresh()
    const root = rows.find((row) => row.pid === shell.pid)
    if (!root || root.creationTimeMs !== shell.creationTimeMs) {
      throw new Error('The PTY shell exited before Codex app-server became ready')
    }
    const tree = processTreeForRoot(rows, shell.pid, shell.creationTimeMs)
    if (tree.some((row) => row.name.toLowerCase() === 'codex.exe')) {
      const codex = nativeCodexFromShell(rows, shell)
      const codexTree = processTreeForRoot(rows, codex.pid, codex.creationTimeMs)
      return { codex, tree: codexTree.map(processIdentity) }
    }
    await delay(100)
  }
  throw new Error('Native Codex app-server did not appear under the packaged PTY shell')
}
