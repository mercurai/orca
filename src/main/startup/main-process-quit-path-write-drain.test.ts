import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'

// Modules the quit handlers import; each export is a stub that resolves, so teardown can run.
const stubbed: [string, string[]][] = [
  ['../ipc/filesystem/watchers/filesystem-watcher-shutdown', ['closeAllWatchers']],
  ['../ipc/worktree-base-directory-watcher', ['disposeWorktreeBaseDirectoryWatchers']],
  ['../ipc/folder-repo-git-upgrade', ['stopFolderRepoGitUpgradeWatch']],
  ['../ipc/pty/kill-all', ['killAllPty']],
  ['../daemon/daemon-provider-state', ['disconnectDaemon', 'shutdownDaemon']],
  ['../ipc/ssh/ssh-shutdown-drain', ['beginSshShutdown']],
  ['../agent-hooks/managed-agent-hook-controls', ['removeManagedAgentHooksAsync']],
  ['../runtime/structured-agent-session-runtime', ['stopStructuredAgentSessionRuntime']],
  [
    '../runtime/agent-session/structured-agent-session-runtime-teardown',
    ['setStructuredAgentSessionTeardownTrigger']
  ],
  ['../runtime/files/watch/file-watcher-leases', ['awaitRuntimeFileWatcherUnsubscribes']],
  ['../runtime/runtime-metadata', ['clearRuntimeMetadataIfOwned']],
  [
    '../browser/paired-runtime-browser-client-host-runtime',
    ['shutdownPairedRuntimeBrowserClientHosts']
  ],
  ['../codex/codex-state-db-backfill-recovery', ['stopCodexStateDbBackfillRecoveries']],
  ['../codex/codex-account-session-bridge', ['stopCodexAccountSessionBridges']],
  ['../git/local-repo-ref-maintenance', ['awaitPackedRefsLockRelease']],
  ['../worktree-background-removal', ['stopBackgroundWorktreeRemovals']],
  ['../ipc/desktop-browser-bridge-wiring', ['disposeDesktopBrowserBridge']],
  ['../orca-profiles/profile-cloud-session-owner', ['flushUnsavedCloudSessions']],
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
  vi.doUnmock('../quit-teardown-start-gate')
  vi.doUnmock('../agent-hooks/server')
  vi.doUnmock('../agent-hooks/wsl-hook-relay-manager')
  vi.doUnmock('../browser/browser-manager')
  vi.doUnmock('../browser/local-ssh-browser-route')
  for (const [moduleName] of stubbed) {
    vi.doUnmock(moduleName)
  }
  vi.resetModules()
  vi.useRealTimers()
})

// Real teardown and serializer on a fake clock; only the quit's other members are stubbed.
it('holds app.quit until a secure write in flight at will-quit has published', async () => {
  vi.resetModules()
  vi.useFakeTimers()
  let publishedAtQuit: boolean | null = null
  let published = false
  const app = Object.assign(new EventEmitter(), {
    quit: vi.fn(() => {
      publishedAtQuit = published
    })
  })
  vi.doMock('electron', () => ({ app }))
  vi.doMock('./main-process-state', () => ({ mainProcessState: { isQuitting: true } }))
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
  // Why false: a resolved promise is truthy, which would steer teardown down the update/dev paths.
  const predicates = new Set([
    'isQuittingForUpdate',
    'isDevParentShutdownRequested',
    'shouldQuitWhenAllWindowsClosed'
  ])
  for (const [moduleName, exports] of stubbed) {
    vi.doMock(moduleName, () =>
      Object.fromEntries(
        exports.map((name) => [
          name,
          predicates.has(name) ? vi.fn(() => false) : vi.fn(async () => [])
        ])
      )
    )
  }
  vi.doMock('../browser/local-ssh-browser-route', () => ({
    closeAllLocalSshBrowserRoutes: vi.fn(() => Promise.resolve())
  }))
  const { serializePathWrite } = await import('../../shared/path-write-serializer')
  let publish!: () => void
  const write = serializePathWrite('/profile/session.json', async () => {
    await new Promise<void>((resolve) => {
      publish = resolve
    })
    published = true
  })
  const exitListenersBefore = process.listeners('exit')
  const { installMainProcessQuitHandlers } = await import('./main-process-quit')
  installMainProcessQuitHandlers()

  app.emit('will-quit', { defaultPrevented: false, preventDefault: vi.fn() })
  await vi.advanceTimersByTimeAsync(50)
  expect(app.quit).not.toHaveBeenCalled()

  publish()
  await write
  await vi.waitFor(() => expect(app.quit).toHaveBeenCalled())
  expect(publishedAtQuit).toBe(true)
  for (const listener of process.listeners('exit')) {
    if (!exitListenersBefore.includes(listener)) {
      process.removeListener('exit', listener)
    }
  }
})
