import { join } from 'node:path'
import { readWindowsProcessIdentityTableFresh } from '../../../src/main/windows/windows-process-table'
import {
  activateWorkspace,
  typeLine,
  waitForTerminalReady,
  type SessionHandle
} from './packaged-pty-app-support'
import { waitForTerminalTabSession } from './packaged-pty-terminal-bindings'
import { typeBashProbe } from './packaged-pty-bash-input'
import { createBashProbeFiles } from './packaged-pty-bash-probe'
import {
  assertBashProbeWindowsPid,
  assertCodexHomeSentinel,
  assertNpmShimSentinel,
  assertResolverSentinel,
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
  await activateWorkspace(session.page, workspaceId, tabId)
  await waitForTerminalReady(session.page, 30_000, tabId)
  const restoredPty = await waitForTerminalTabSession(session.page, workspaceId, folderPath, tabId)
  const files = createBashProbeFiles(markerDir, 'cold-bash')
  await typeBashProbe(session.page, restoredPty.id, tabId, files)
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
