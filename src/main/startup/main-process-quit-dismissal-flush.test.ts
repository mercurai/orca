import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'

// Modules the quit handlers import; each export is a stub that resolves, so teardown can run.
const stubbed: [string, string[]][] = [
  ['../ipc/filesystem-watcher', ['closeAllWatchers']],
  ['../ipc/worktree-base-directory-watcher', ['disposeWorktreeBaseDirectoryWatchers']],
  ['../ipc/folder-repo-git-upgrade', ['stopFolderRepoGitUpgradeWatch']],
  ['../ipc/pty', ['killAllPty']],
  ['../daemon/daemon-init', ['disconnectDaemon', 'shutdownDaemon']],
  ['../ipc/ssh-shutdown-drain', ['beginSshShutdown']],
  ['../agent-hooks/managed-agent-hook-controls', ['removeManagedAgentHooksAsync']],
  ['../runtime/structured-agent-session-runtime', ['stopStructuredAgentSessionRuntime']],
  [
    '../runtime/structured-agent-session-runtime-teardown',
    ['setStructuredAgentSessionTeardownTrigger']
  ],
  ['../runtime/orca-runtime-files', ['awaitRuntimeFileWatcherUnsubscribes']],
  ['../runtime/runtime-metadata', ['clearRuntimeMetadataIfOwned']],
  [
    '../browser/paired-runtime-browser-client-host-runtime',
    ['shutdownPairedRuntimeBrowserClientHosts']
  ],
  ['../codex/codex-state-db-backfill-recovery', ['stopCodexStateDbBackfillRecoveries']],
  ['../codex/codex-account-session-bridge', ['stopCodexAccountSessionBridges']],
  ['../git/local-repo-ref-maintenance', ['awaitPackedRefsLockRelease']],
  ['../worktree-background-removal', ['stopBackgroundWorktreeRemovals']],
  ['../dock/unread-badge', ['setUnreadDockBadgeCount']],
  ['../tray/system-tray', ['destroySystemTray']],
  ['../telemetry/client', ['shutdownTelemetry']],
  ['../observability', ['shutdownObservability']],
  ['../updater', ['isQuittingForUpdate']],
  ['../updater-lifecycle-diagnostics', ['recordUpdaterLifecycle']],
  ['../macos-tcc-prompt-notice', ['stopTccPromptNotice']],
  ['../terminal-history-gc', ['cancelHistoryGc']],
  ['./window-all-closed-quit-policy', ['shouldQuitWhenAllWindowsClosed']],
  ['./configure-process', ['isDevParentShutdownRequested']],
  ['../persistence', ['getCanonicalUserDataPath']]
]

afterEach(() => {
  vi.doUnmock('electron')
  vi.doUnmock('./main-process-state')
  vi.doUnmock('../quit-teardown-deadline')
  vi.doUnmock('../quit-teardown-start-gate')
  vi.doUnmock('../agent-hooks/server')
  vi.doUnmock('../agent-hooks/wsl-hook-relay-manager')
  vi.doUnmock('../browser/browser-manager')
  for (const [moduleName] of stubbed) {
    vi.doUnmock(moduleName)
  }
  vi.resetModules()
})

it('awaits the mobile dismissal flush inside the will-quit teardown barrier', async () => {
  vi.resetModules()
  const app = Object.assign(new EventEmitter(), { quit: vi.fn() })
  const flushNotificationDismissals = vi.fn(() => Promise.resolve())
  const settleTeardownWithinDeadline = vi.fn(
    (_members: { name: string; promise: Promise<unknown> }[]) => Promise.resolve([])
  )
  const state = {
    isQuitting: true,
    runtime: {
      getRuntimeId: () => 'runtime-1',
      getOffscreenBrowserBackend: () => null,
      getAgentBrowserBridge: () => null,
      getEmulatorBridge: () => null,
      disposeSkillUploadSessions: () => Promise.resolve(),
      flushNotificationDismissals
    }
  }
  vi.doMock('electron', () => ({ app }))
  vi.doMock('./main-process-state', () => ({ mainProcessState: state }))
  vi.doMock('../quit-teardown-deadline', () => ({
    settleTeardownWithinDeadline,
    settleWithinMs: () => Promise.resolve({ outcome: 'ok', value: [] })
  }))
  vi.doMock('../quit-teardown-start-gate', () => ({
    quitTeardownStartGate: { tryStart: () => true }
  }))
  vi.doMock('../agent-hooks/server', () => ({ agentHookServer: { stop: vi.fn() } }))
  vi.doMock('../agent-hooks/wsl-hook-relay-manager', () => ({
    wslHookRelayManager: { disposeAll: vi.fn() }
  }))
  vi.doMock('../browser/browser-manager', () => ({
    browserManager: { setBrowserGuestStateChangedListener: vi.fn() }
  }))
  for (const [moduleName, exports] of stubbed) {
    vi.doMock(moduleName, () =>
      Object.fromEntries(exports.map((name) => [name, vi.fn(() => Promise.resolve())]))
    )
  }
  const exitListenersBefore = process.listeners('exit')
  const { installMainProcessQuitHandlers } = await import('./main-process-quit')
  installMainProcessQuitHandlers()

  app.emit('will-quit', { defaultPrevented: false, preventDefault: vi.fn() })

  expect(flushNotificationDismissals).toHaveBeenCalledOnce()
  const [barrier] = settleTeardownWithinDeadline.mock.calls[0] ?? []
  expect(barrier?.map((member) => member.name)).toContain('mobile-dismissals')
  await vi.waitFor(() => expect(app.quit).toHaveBeenCalled())
  for (const listener of process.listeners('exit')) {
    if (!exitListenersBefore.includes(listener)) {
      process.removeListener('exit', listener)
    }
  }
})
