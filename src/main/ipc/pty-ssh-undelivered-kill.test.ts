import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { TerminalIntentionalStops } from '../runtime/terminal-intentional-stops'
import {
  registerPtyHandlers,
  deletePtyOwnership,
  setPtyOwnership,
  restorePtyIncarnation
} from './pty'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

const SCOPED_PTY_ID = 'ssh:ssh-1@@pty-7'

function createKillStore() {
  return {
    markSshRemotePtyLease: vi.fn(),
    recordSshRemotePtyKillIntent: vi.fn(),
    clearSshRemotePtyKillIntent: vi.fn()
  }
}

function installController(handlers: Map<string, never>) {
  const runtime = {
    setPtyController: vi.fn(),
    markPtyStopRequested: vi.fn(),
    markPtyLivenessUnverifiable: vi.fn(),
    onPtyExit: vi.fn(),
    intentionalPtyStops: new TerminalIntentionalStops()
  }
  handlers.clear()
  return { runtime }
}

describe('undelivered SSH stops', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()

  function install(store: ReturnType<typeof createKillStore>): {
    kill: (ptyId: string) => boolean
    stopAndWait: (ptyId: string, opts?: { keepHistory?: boolean }) => Promise<boolean>
    recordUnconfirmedStop: (ptyId: string) => boolean
    runtime: ReturnType<typeof installController>['runtime']
  } {
    const { runtime } = installController(handlers as never)
    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      undefined,
      store as never
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registerPtyHandlers installs the runtime PTY controller, which implements these members.
    const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
      kill: (ptyId: string) => boolean
      stopAndWait: (ptyId: string, opts?: { keepHistory?: boolean }) => Promise<boolean>
      recordUnconfirmedStop: (ptyId: string) => boolean
    }
    return {
      kill: controller.kill,
      stopAndWait: controller.stopAndWait,
      recordUnconfirmedStop: controller.recordUnconfirmedStop,
      runtime
    }
  }

  // The offline close: no provider is registered, so the relay is never even asked. The lease is
  // tombstoned locally, and without the record the remote shell has nothing left to retire it.
  it('records the stop when no provider is registered to deliver it', async () => {
    const store = createKillStore()
    setPtyOwnership(SCOPED_PTY_ID, 'ssh:ssh-1')
    restorePtyIncarnation(SCOPED_PTY_ID, 'inc-b')
    const { kill } = install(store)

    try {
      expect(kill(SCOPED_PTY_ID)).toBe(false)
      expect(store.recordSshRemotePtyKillIntent).toHaveBeenCalledWith(
        'ssh-1',
        'pty-7',
        expect.objectContaining({ incarnationId: 'inc-b' })
      )
    } finally {
      deletePtyOwnership(SCOPED_PTY_ID)
    }
  })

  it('records the stop when renderer pty:kill finds no provider to deliver it', async () => {
    const store = createKillStore()
    setPtyOwnership(SCOPED_PTY_ID, 'ssh:ssh-1')
    restorePtyIncarnation(SCOPED_PTY_ID, 'inc-r2')
    install(store)

    try {
      await handlers.get('pty:kill')!(null, { id: SCOPED_PTY_ID })
      expect(store.recordSshRemotePtyKillIntent).toHaveBeenCalledWith(
        'ssh-1',
        'pty-7',
        expect.objectContaining({ incarnationId: 'inc-r2' })
      )
    } finally {
      deletePtyOwnership(SCOPED_PTY_ID)
    }
  })

  it('records nothing for a local PTY, which has no later host to ask', async () => {
    const store = createKillStore()
    setPtyOwnership('local-pty', 'local')
    restorePtyIncarnation('local-pty', 'inc-d')
    const { kill } = install(store)

    try {
      kill('local-pty')
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(store.recordSshRemotePtyKillIntent).not.toHaveBeenCalled()
    } finally {
      deletePtyOwnership('local-pty')
    }
  })

  // A `pty2:` id is epoch-scoped, so it names one process even when the incarnation was never
  // learned: an offline close across a relaunch still owes the kill.
  it('records the stop for an epoch-scoped id whose incarnation was never learned', () => {
    const store = createKillStore()
    const ptyId = 'ssh:ssh-1@@pty2:epoch-a:4'
    setPtyOwnership(ptyId, 'ssh:ssh-1')
    const { kill } = install(store)

    try {
      expect(kill(ptyId)).toBe(false)
      expect(store.recordSshRemotePtyKillIntent).toHaveBeenCalledWith('ssh-1', 'pty2:epoch-a:4', {
        requestedAt: expect.any(Number),
        attempts: 0
      })
    } finally {
      deletePtyOwnership(ptyId)
    }
  })

  // One recorder: the explicit-close receipt promises the retry for an epoch-scoped id too.
  it("records an explicit close's unconfirmed stop for an epoch-scoped id with no incarnation", () => {
    const store = createKillStore()
    const ptyId = 'ssh:ssh-1@@pty2:epoch-b:5'
    setPtyOwnership(ptyId, 'ssh:ssh-1')
    const { recordUnconfirmedStop } = install(store)

    try {
      expect(recordUnconfirmedStop(ptyId)).toBe(true)
      expect(store.recordSshRemotePtyKillIntent).toHaveBeenCalledTimes(1)
      expect(store.recordSshRemotePtyKillIntent).toHaveBeenCalledWith('ssh-1', 'pty2:epoch-b:5', {
        requestedAt: expect.any(Number),
        attempts: 0
      })
    } finally {
      deletePtyOwnership(ptyId)
    }
  })

  // An explicit close records its order when the stop goes unconfirmed, before the follow-up kill,
  // so its receipt can promise the reconnect retry from the record itself.
  it("records an explicit close's unconfirmed stop and says so", () => {
    const store = createKillStore()
    setPtyOwnership(SCOPED_PTY_ID, 'ssh:ssh-1')
    restorePtyIncarnation(SCOPED_PTY_ID, 'inc-g')
    const { recordUnconfirmedStop } = install(store)

    try {
      expect(recordUnconfirmedStop(SCOPED_PTY_ID)).toBe(true)
      expect(store.recordSshRemotePtyKillIntent).toHaveBeenCalledWith(
        'ssh-1',
        'pty-7',
        expect.objectContaining({ incarnationId: 'inc-g', attempts: 0 })
      )
    } finally {
      deletePtyOwnership(SCOPED_PTY_ID)
    }
  })

  it('reports no recorded order for a local or reversibly stopped PTY', () => {
    const store = createKillStore()
    setPtyOwnership('local-pty', 'local')
    restorePtyIncarnation('local-pty', 'inc-h')
    setPtyOwnership(SCOPED_PTY_ID, 'ssh:ssh-1')
    restorePtyIncarnation(SCOPED_PTY_ID, 'inc-i')
    const { recordUnconfirmedStop, runtime } = install(store)
    const settleStop = runtime.intentionalPtyStops.mark(SCOPED_PTY_ID, 'reversible', null)

    try {
      expect(recordUnconfirmedStop('local-pty')).toBe(false)
      expect(recordUnconfirmedStop(SCOPED_PTY_ID)).toBe(false)
      expect(store.recordSshRemotePtyKillIntent).not.toHaveBeenCalled()
    } finally {
      settleStop(false)
      deletePtyOwnership('local-pty')
      deletePtyOwnership(SCOPED_PTY_ID)
    }
  })
})
