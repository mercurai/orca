import { join } from 'node:path'
import { readWindowsProcessIdentityTableFresh } from '../../../src/main/windows/windows-process-table'
import {
  activateWorkspace,
  typeLine,
  waitForTerminalReady,
  waitForWorkspaceSession,
  type SessionHandle
} from './packaged-pty-app-support'
import {
  assertBashProbeWindowsPid,
  assertCodexHomeSentinel,
  assertNpmShimSentinel,
  assertResolverSentinel,
  bashProbeCommand,
  clickCloseTab,
  processIdentity,
  processTreeForRoot,
  readShellIdentity,
  sendCtrlC,
  type ShellIdentity,
  waitForFile,
  waitForBashProbeDiagnostic,
  waitForPackagedAppServer,
  waitForProcessTreeExit,
  writeShellReturnMarker
} from './packaged-pty-process-support'
import type { RuntimeSettings } from './runtime-environment'

export async function proveColdRestoredFolderPane(
  session: SessionHandle,
  settings: RuntimeSettings,
  workspaceId: string,
  tabId: string,
  folderPath: string,
  previousShell: ShellIdentity,
  codexHome: string,
  markerDir: string
): Promise<void> {
  await activateWorkspace(session.page, workspaceId)
  await waitForTerminalReady(session.page, 30_000, tabId)
  const restoredPty = await waitForWorkspaceSession(session.page, workspaceId, folderPath)
  const files = {
    shellPid: join(markerDir, 'cold-bash-shell.pid'),
    resolver: join(markerDir, 'cold-bash-resolver.txt'),
    npmPath: join(markerDir, 'cold-bash-npm-path.txt'),
    codexHome: join(markerDir, 'cold-bash-codex-home.txt'),
    diagnostic: join(markerDir, 'cold-bash-probe-diagnostic.txt')
  }
  await typeLine(session.page, bashProbeCommand(files), tabId)
  const bashDiagnostic = await waitForBashProbeDiagnostic(files)
  assertBashProbeWindowsPid(bashDiagnostic)
  assertNpmShimSentinel(files.npmPath, settings.npmBin, bashDiagnostic)
  await waitForFile(files.resolver)
  await waitForFile(files.codexHome)
  assertResolverSentinel(files.resolver, settings.resolver)
  assertCodexHomeSentinel(files.codexHome, codexHome)
  const shell = readShellIdentity(
    files.shellPid,
    await readWindowsProcessIdentityTableFresh(),
    'bash.exe'
  )
  if (shell.pid === previousShell.pid && shell.creationTimeMs === previousShell.creationTimeMs) {
    throw new Error('Cold restore reused the old shell process identity')
  }
  await typeLine(session.page, 'codex app-server', tabId)
  const runtime = await waitForPackagedAppServer(session.page, restoredPty.id, tabId, shell, 724)
  await sendCtrlC(session.page, tabId)
  await waitForProcessTreeExit(runtime.codex.pid, runtime.codex.creationTimeMs, runtime.tree, {
    timeoutMs: 15_000,
    intervalMs: 200,
    label: 'Ctrl+C after cold restore'
  })
  await writeShellReturnMarker(
    session.page,
    'bash',
    tabId,
    join(markerDir, 'cold-shell-returned.txt')
  )
  const paneTree = processTreeForRoot(
    await readWindowsProcessIdentityTableFresh(),
    shell.pid,
    shell.creationTimeMs
  ).map(processIdentity)
  await clickCloseTab(session.page, tabId, false)
  await waitForProcessTreeExit(shell.pid, shell.creationTimeMs, paneTree, {
    timeoutMs: 15_000,
    intervalMs: 200,
    label: 'Closing the cold-restored folder pane'
  })
}
