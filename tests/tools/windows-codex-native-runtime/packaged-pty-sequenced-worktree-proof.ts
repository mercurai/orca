import { join } from 'node:path'
import { readWindowsProcessIdentityTableFresh } from '../../../src/main/windows/windows-process-table'
import {
  activateWorkspace,
  setWindowsShell,
  typeLine,
  visibleTerminalTabId,
  waitForTerminalReady,
  waitForWorkspaceSession,
  type SessionHandle
} from './packaged-pty-app-support'
import {
  assertCodexHomeSentinel,
  assertManagedEnvironmentRestored,
  assertNpmShimSentinel,
  assertResolverSentinel,
  processIdentity,
  processTreeForRoot,
  powershellStartupCommand,
  readShellIdentity,
  sendCtrlC,
  type ShellIdentity,
  waitForFile,
  waitForPackagedAppServer,
  waitForProcessTreeExit,
  writeManagedEnvironmentReportCommand
} from './packaged-pty-process-support'
import type { RuntimeSettings } from './runtime-environment'
import type { ProcessIdentity } from './process-tree-identity'

export type SequencedWorktreePty = {
  tabId: string
  shell: ShellIdentity
  shellTree: ProcessIdentity[]
}

export async function proveSequencedWorktreePty(
  session: SessionHandle,
  settings: RuntimeSettings,
  repoPath: string,
  codexHome: string,
  markerDir: string
): Promise<SequencedWorktreePty> {
  const powershell = settings.shells.find((shell) => shell.name === 'PowerShell 7')
  if (!powershell) {
    throw new Error('The runtime gate omitted PowerShell 7')
  }
  await setWindowsShell(session.page, powershell.executable)
  const repo = await session.page.evaluate(async (path) => {
    const repos = await window.api.repos.list()
    const match = repos.find((entry) => entry.path.toLowerCase() === path.toLowerCase())
    return match ? { id: match.id } : null
  }, repoPath)
  if (!repo) {
    throw new Error('The isolated packaged profile did not load its seeded Git worktree')
  }

  const files = {
    shellPid: join(markerDir, 'pwsh-shell.pid'),
    resolver: join(markerDir, 'pwsh-resolver.txt'),
    npmPath: join(markerDir, 'pwsh-npm-path.txt'),
    codexHome: join(markerDir, 'pwsh-codex-home.txt')
  }
  const startup = await session.page.evaluate(
    async ({ repoId, command }) =>
      window.api.worktrees.create({
        repoId,
        name: 'native-codex-pty-proof',
        setupDecision: 'skip',
        telemetrySource: 'unknown',
        startup: { command, startupCommandDelivery: 'shell-ready' }
      }),
    { repoId: repo.id, command: powershellStartupCommand(files) }
  )
  const worktreeId = startup.worktree.id
  const worktreePath = startup.worktree.path
  const ptyId = startup.startupTerminal?.ptyId
  if (
    typeof worktreeId !== 'string' ||
    typeof worktreePath !== 'string' ||
    startup.startupTerminal?.spawned !== true ||
    typeof ptyId !== 'string'
  ) {
    throw new Error('The sequenced worktree startup did not create its worktree PTY')
  }

  await activateWorkspace(session.page, worktreeId)
  const tabId = await visibleTerminalTabId(session.page)
  await waitForTerminalReady(session.page, 30_000, tabId)
  const worktreePty = await waitForWorkspaceSession(session.page, worktreeId, worktreePath)
  if (worktreePty.id !== ptyId) {
    throw new Error('The sequenced startup command did not attach to its worktree PTY')
  }

  await waitForFile(files.shellPid)
  await waitForFile(files.npmPath)
  await waitForFile(files.codexHome)
  assertNpmShimSentinel(files.npmPath, settings.npmBin)
  assertResolverSentinel(files.resolver, settings.resolver)
  assertCodexHomeSentinel(files.codexHome, codexHome)
  const shell = readShellIdentity(
    files.shellPid,
    await readWindowsProcessIdentityTableFresh(),
    'pwsh.exe'
  )
  const firstRuntime = await waitForPackagedAppServer(
    session.page,
    worktreePty.id,
    tabId,
    shell,
    722
  )
  await sendCtrlC(session.page, tabId)
  await waitForProcessTreeExit(
    firstRuntime.codex.pid,
    firstRuntime.codex.creationTimeMs,
    firstRuntime.tree,
    {
      timeoutMs: 15_000,
      intervalMs: 200,
      label: 'Ctrl+C in PowerShell 7'
    }
  )
  const reportPath = join(markerDir, 'pwsh-managed-env.txt')
  await typeLine(
    session.page,
    writeManagedEnvironmentReportCommand('powershell', reportPath),
    tabId
  )
  await waitForFile(reportPath)
  assertManagedEnvironmentRestored(reportPath)
  await typeLine(session.page, 'codex app-server', tabId)
  await waitForPackagedAppServer(session.page, worktreePty.id, tabId, shell, 725)
  const tree = processTreeForRoot(
    await readWindowsProcessIdentityTableFresh(),
    shell.pid,
    shell.creationTimeMs
  ).map(processIdentity)
  return { tabId, shell, shellTree: tree }
}
