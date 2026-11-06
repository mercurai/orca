import { join } from 'node:path'
import { readWindowsProcessIdentityTableFresh } from '../../../src/main/windows/windows-process-table'
import {
  activateWorkspace,
  createTerminalTab,
  listPtySessions,
  typeLine,
  visibleTerminalTabId,
  waitForNewSession,
  waitForTerminalReady,
  type SessionHandle
} from './packaged-pty-app-support'
import {
  assertCodexHomeSentinel,
  assertManagedEnvironmentRestored,
  assertNpmShimSentinel,
  assertResolverSentinel,
  clickCloseTab,
  processIdentity,
  processTreeForRoot,
  powershellStartupCommand,
  readShellIdentity,
  sendCtrlC,
  waitForFile,
  waitForPackagedAppServer,
  waitForProcessTreeExit,
  writeManagedEnvironmentReportCommand,
  writeShellReturnMarker
} from './packaged-pty-process-support'
import type { RuntimeSettings } from './runtime-environment'

export async function proveWindowsPowerShell51ManagedRestore(
  session: SessionHandle,
  workspaceId: string,
  settings: RuntimeSettings,
  codexHome: string,
  markerDir: string
): Promise<void> {
  await activateWorkspace(session.page, workspaceId)
  const previousIds = new Set((await listPtySessions(session.page)).map((pty) => pty.id))
  await createTerminalTab(session.page)
  const tabId = await visibleTerminalTabId(session.page)
  await waitForTerminalReady(session.page, 30_000, tabId)
  const pty = await waitForNewSession(session.page, workspaceId, previousIds)
  const markerFiles = {
    shellPid: join(markerDir, 'powershell51-shell.pid'),
    resolver: join(markerDir, 'powershell51-resolver.txt'),
    npmPath: join(markerDir, 'powershell51-npm-path.txt'),
    codexHome: join(markerDir, 'powershell51-codex-home.txt')
  }
  const envReport = join(markerDir, 'powershell51-managed-env.txt')
  const returnMarker = join(markerDir, 'powershell51-shell-returned.txt')

  await typeLine(session.page, powershellStartupCommand(markerFiles), tabId)
  await waitForFile(markerFiles.shellPid)
  await waitForFile(markerFiles.npmPath)
  await waitForFile(markerFiles.codexHome)
  assertNpmShimSentinel(markerFiles.npmPath, settings.npmBin)
  assertResolverSentinel(markerFiles.resolver, settings.resolver)
  assertCodexHomeSentinel(markerFiles.codexHome, codexHome)
  const shell = readShellIdentity(
    markerFiles.shellPid,
    await readWindowsProcessIdentityTableFresh(),
    'powershell.exe'
  )
  const runtime = await waitForPackagedAppServer(session.page, pty.id, tabId, shell, 731)
  await sendCtrlC(session.page, tabId)
  await waitForProcessTreeExit(runtime.codex.pid, runtime.codex.creationTimeMs, runtime.tree, {
    timeoutMs: 15_000,
    intervalMs: 200,
    label: 'Ctrl+C in Windows PowerShell 5.1'
  })
  await typeLine(session.page, writeManagedEnvironmentReportCommand('powershell', envReport), tabId)
  await waitForFile(envReport)
  assertManagedEnvironmentRestored(envReport)
  await writeShellReturnMarker(session.page, 'powershell', tabId, returnMarker)
  const paneTree = processTreeForRoot(
    await readWindowsProcessIdentityTableFresh(),
    shell.pid,
    shell.creationTimeMs
  ).map(processIdentity)
  await clickCloseTab(session.page, tabId, false)
  await waitForProcessTreeExit(shell.pid, shell.creationTimeMs, paneTree, {
    timeoutMs: 15_000,
    intervalMs: 200,
    label: 'Closing the Windows PowerShell 5.1 pane'
  })
}
