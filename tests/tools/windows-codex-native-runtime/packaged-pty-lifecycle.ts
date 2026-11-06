import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readWindowsProcessIdentityTableFresh } from '../../../src/main/windows/windows-process-table'
import { cleanupE2EDaemons } from '../../e2e/helpers/electron-process-shutdown'
import { closeApp } from '../win-update-e2e/app-driver.mjs'
import {
  activateWorkspace,
  assertPrerequisites,
  createFolderWorkspace,
  createSeedProfile,
  isPathWithin,
  launchPackaged,
  setWindowsShell,
  typeLine,
  waitForTerminalReady,
  type SessionHandle
} from './packaged-pty-app-support'
import { createBoundTerminalTab, waitForTerminalTabSession } from './packaged-pty-terminal-bindings'
import { typeBashProbe } from './packaged-pty-bash-input'
import { createBashProbeFiles } from './packaged-pty-bash-probe'
import { proveColdRestoredFolderPane } from './packaged-pty-cold-restore-proof'
import { proveWindowsPowerShell51ManagedRestore } from './packaged-pty-powershell51-proof'
import { proveSequencedWorktreePty } from './packaged-pty-sequenced-worktree-proof'
import { finishPackagedPtyLifecycle } from './packaged-pty-lifecycle-cleanup'
import { assertNativeProcessTableReady } from './packaged-pty-native-process'
import {
  reportPackagedPtyWorkspaceSnapshot,
  type PackagedPtyWorkspaceStage
} from './packaged-pty-workspace-diagnostic'
import {
  assertIdentityAlive,
  assertBashProbeWindowsPid,
  assertCodexHomeSentinel,
  assertManagedEnvironmentRestored,
  assertNpmShimSentinel,
  assertResolverSentinel,
  clickCloseTab,
  processIdentity,
  processTreeForRoot,
  readShellIdentity,
  sendCtrlC,
  seedManagedEnvironmentCommand,
  waitForFile,
  waitForPackagedAppServer,
  waitForProcessTreeExit,
  waitForBashProbeDiagnostic,
  writeManagedEnvironmentReportCommand,
  writeShellReturnMarker
} from './packaged-pty-process-support'

export async function runPackagedCodexPtyLifecycle(): Promise<void> {
  if (process.env.ORCA_CODEX_NATIVE_RUNTIME_TEST !== '1') {
    throw new Error(
      'Set ORCA_CODEX_NATIVE_RUNTIME_TEST=1 to request the packaged Codex PTY lifecycle proof'
    )
  }
  const { appExe, settings, powershell51 } = assertPrerequisites()
  await assertNativeProcessTableReady()

  const runRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'orca-codex-packaged-pty-')))
  const userDataDir = join(runRoot, 'userData')
  const appEnvRoot = join(runRoot, 'app-env')
  const repoPath = join(runRoot, 'repo')
  const folderPath = join(runRoot, 'folder-workspace')
  const markerDir = join(runRoot, 'shell markers')
  if (!isPathWithin(realpathSync.native(tmpdir()), runRoot)) {
    throw new Error('The packaged PTY proof temp directory escaped the runner temp directory')
  }
  let session: SessionHandle | null = null
  const report = {
    gate: 'packaged-windows-codex-pty',
    requested: true,
    packagedApp: false,
    folderTypedNativeLaunch: false,
    worktreeSequencedNativeLaunch: false,
    managedEnvironmentRestored: { gitBash: false, powershell7: false, powershell51: false },
    paneCloseRemovedOwnedTree: false,
    warmReattachPreservedIdentity: false,
    coldRestoreRecreatedShell: false,
    postRestoreTypedNativeLaunch: false,
    ctrlCReturnedToShell: false
  }

  let lifecycleFailure: { error: unknown } | null = null
  try {
    const isolatedCodexHome = join(userDataDir, 'home', '.codex')
    mkdirSync(isolatedCodexHome, { recursive: true })
    const canonicalCodexHome = realpathSync.native(isolatedCodexHome)
    const profile = createSeedProfile(repoPath)
    const canonicalRepoPath = realpathSync.native(repoPath)
    mkdirSync(markerDir, { recursive: true })
    mkdirSync(folderPath, { recursive: true })
    session = await launchPackaged(appExe, userDataDir, appEnvRoot, settings.npmBin, profile)
    report.packagedApp = await session.app.evaluate(({ app }) => app.isPackaged)
    if (!report.packagedApp) {
      throw new Error('The runtime PTY proof launched an unpackaged Orca app')
    }
    if (existsSync(join(userDataDir, 'home', '.codex', 'auth.json'))) {
      throw new Error('The isolated packaged PTY home unexpectedly contains Codex authentication')
    }

    await setWindowsShell(session.page, 'git-bash')
    const folderId = await createFolderWorkspace(session.page, realpathSync.native(folderPath))
    await activateWorkspace(session.page, folderId)
    const { tabId: folderTabId, session: folderPty } = await createBoundTerminalTab(
      session.page,
      folderId,
      realpathSync.native(folderPath)
    )
    const folderPage = session.page
    const reportFolderSnapshot = (stage: PackagedPtyWorkspaceStage): Promise<void> =>
      reportPackagedPtyWorkspaceSnapshot(folderPage, stage, folderId, folderTabId, folderPty.id)
    const bashFiles = createBashProbeFiles(markerDir, 'bash')
    await typeBashProbe(session.page, folderPty.id, folderTabId, bashFiles)
    const bashDiagnostic = await waitForBashProbeDiagnostic(bashFiles)
    assertBashProbeWindowsPid(bashDiagnostic)
    assertNpmShimSentinel(bashFiles.npmPath, settings.npmBin, bashDiagnostic)
    await waitForFile(bashFiles.resolver)
    await waitForFile(bashFiles.codexHome)
    assertResolverSentinel(bashFiles.resolver, settings.resolver)
    assertCodexHomeSentinel(bashFiles.codexHome, canonicalCodexHome)
    const bashShell = readShellIdentity(
      bashFiles.shellPid,
      await readWindowsProcessIdentityTableFresh(),
      'bash.exe'
    )
    await typeLine(session.page, 'codex app-server', folderTabId)
    const folderRuntime = await waitForPackagedAppServer(
      session.page,
      folderPty.id,
      folderTabId,
      bashShell,
      721
    )
    report.folderTypedNativeLaunch = true

    await reportFolderSnapshot('before-worktree-proof')
    const worktree = await proveSequencedWorktreePty(
      session,
      settings,
      canonicalRepoPath,
      canonicalCodexHome,
      {
        markerDir,
        afterShellSettingsChange: () => reportFolderSnapshot('after-ps7-settings-change')
      }
    )
    report.worktreeSequencedNativeLaunch = true
    report.managedEnvironmentRestored.powershell7 = true
    await clickCloseTab(session.page, worktree.tabId, true)
    await waitForProcessTreeExit(
      worktree.shell.pid,
      worktree.shell.creationTimeMs,
      worktree.shellTree,
      {
        timeoutMs: 15_000,
        intervalMs: 200,
        label: 'Closing the sequenced worktree pane'
      }
    )
    report.paneCloseRemovedOwnedTree = true

    await reportFolderSnapshot('after-worktree-close-before-ps5-settings-change')
    await setWindowsShell(folderPage, powershell51.executable, () =>
      reportFolderSnapshot('after-ps5-settings-change')
    )
    await proveWindowsPowerShell51ManagedRestore(
      session,
      folderId,
      realpathSync.native(folderPath),
      settings,
      canonicalCodexHome,
      markerDir
    )
    report.managedEnvironmentRestored.powershell51 = true
    await reportFolderSnapshot('after-ps5-proof')

    await activateWorkspace(session.page, folderId, folderTabId, folderPty.id)
    await waitForTerminalReady(session.page, 30_000, folderTabId)
    const folderAfterShellTests = await waitForTerminalTabSession(
      session.page,
      folderId,
      realpathSync.native(folderPath),
      folderTabId
    )
    if (folderAfterShellTests.id !== folderPty.id) {
      throw new Error('Folder activation did not preserve its original local PTY session')
    }
    await closeApp(session.app, 45_000, { allowForceKill: false })
    session = null
    await assertIdentityAlive(bashShell, 'The folder shell')
    await assertIdentityAlive(folderRuntime.codex, 'The folder Codex app-server')

    session = await launchPackaged(appExe, userDataDir, appEnvRoot, settings.npmBin)
    await activateWorkspace(session.page, folderId, folderTabId, folderPty.id)
    await waitForTerminalReady(session.page, 30_000, folderTabId)
    const warmPty = await waitForTerminalTabSession(
      session.page,
      folderId,
      realpathSync.native(folderPath),
      folderTabId
    )
    if (warmPty.id !== folderPty.id) {
      throw new Error('Warm reattach changed the folder PTY identity')
    }
    await assertIdentityAlive(bashShell, 'The folder shell')
    await assertIdentityAlive(folderRuntime.codex, 'The folder Codex app-server')
    report.warmReattachPreservedIdentity = true

    await sendCtrlC(session.page, folderTabId)
    await waitForProcessTreeExit(
      folderRuntime.codex.pid,
      folderRuntime.codex.creationTimeMs,
      folderRuntime.tree,
      {
        timeoutMs: 15_000,
        intervalMs: 200,
        label: 'Stopping the warm-reattached folder Codex app-server'
      }
    )
    await writeShellReturnMarker(
      session.page,
      'bash',
      folderTabId,
      join(markerDir, 'warm-server-stopped.txt')
    )

    const bashManagedReport = join(markerDir, 'bash-managed-env.txt')
    await typeLine(
      session.page,
      `${seedManagedEnvironmentCommand('bash')}; codex app-server`,
      folderTabId
    )
    const bashInterruptRuntime = await waitForPackagedAppServer(
      session.page,
      warmPty.id,
      folderTabId,
      bashShell,
      723
    )
    await sendCtrlC(session.page, folderTabId)
    await waitForProcessTreeExit(
      bashInterruptRuntime.codex.pid,
      bashInterruptRuntime.codex.creationTimeMs,
      bashInterruptRuntime.tree,
      { timeoutMs: 15_000, intervalMs: 200, label: 'Ctrl+C in Git Bash' }
    )
    await typeLine(
      session.page,
      writeManagedEnvironmentReportCommand('bash', bashManagedReport),
      folderTabId
    )
    await waitForFile(bashManagedReport)
    assertManagedEnvironmentRestored(bashManagedReport)
    report.managedEnvironmentRestored.gitBash = true
    await writeShellReturnMarker(
      session.page,
      'bash',
      folderTabId,
      join(markerDir, 'warm-shell-returned.txt')
    )
    report.ctrlCReturnedToShell = true

    await typeLine(session.page, 'codex app-server', folderTabId)
    const finalRuntime = await waitForPackagedAppServer(
      session.page,
      warmPty.id,
      folderTabId,
      bashShell,
      726
    )
    const finalTree = processTreeForRoot(
      await readWindowsProcessIdentityTableFresh(),
      bashShell.pid,
      bashShell.creationTimeMs
    ).map(processIdentity)
    await closeApp(session.app, 45_000, { allowForceKill: false })
    session = null
    await assertIdentityAlive(bashShell, 'The folder shell before cold restore')
    await assertIdentityAlive(finalRuntime.codex, 'The folder Codex app-server before cold restore')
    await cleanupE2EDaemons(userDataDir)
    await waitForProcessTreeExit(bashShell.pid, bashShell.creationTimeMs, finalTree, {
      timeoutMs: 20_000,
      intervalMs: 200,
      label: 'Stopping the isolated terminal daemon for cold restore'
    })

    session = await launchPackaged(appExe, userDataDir, appEnvRoot, settings.npmBin)
    await proveColdRestoredFolderPane(
      session,
      settings,
      folderId,
      folderTabId,
      realpathSync.native(folderPath),
      bashShell,
      canonicalCodexHome,
      markerDir
    )
    report.coldRestoreRecreatedShell = true
    report.postRestoreTypedNativeLaunch = true
  } catch (error) {
    lifecycleFailure = { error }
  }

  const activeSession = session
  const shutdownActions = activeSession ? [() => closeApp(activeSession.app, 15_000)] : []
  shutdownActions.push(() => cleanupE2EDaemons(userDataDir))
  await finishPackagedPtyLifecycle(lifecycleFailure, shutdownActions, () =>
    rmSync(runRoot, { recursive: true, force: true })
  )
  console.log(JSON.stringify(report))
}
