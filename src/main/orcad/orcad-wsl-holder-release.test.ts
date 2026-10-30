import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../shared/app-environment'
import { ORCAD_MANAGED_ACTIVATION_ROOT_ENV } from '../../shared/orcad-managed-launch-env'
import { RELAY_INSTALL_LOCK_NAME } from '../../shared/relay-install-lock-name'
import { createAdapter } from '../daemon/daemon-pty-router-test-fixture'
import { DaemonPtyRouter } from '../daemon/daemon-pty-router'
import { installDaemonProvider } from '../daemon/daemon-provider-state'
import type { DaemonIdleRetirementResult } from '../daemon/daemon-pty-runtime-state'
import { PROTOCOL_VERSION } from '../daemon/types'
import {
  beginOrcadIdleExit,
  bindOrcadIdleShutdown,
  createIdleStopRecordOwnership
} from './orcad-managed-idle-exit-host'
import { installOrcadManagedIdleExit } from './orcad-managed-idle-exit'
import type * as ManagedIdleExit from './orcad-managed-idle-exit'
import { orcadWslHolderReleasePath } from './orcad-wsl-holder-release'
import { ORCAD_WSL_HOST_ENV } from '../ipc/wsl-guest-windows-drive-path'
import { serializePathWrite } from '../../shared/path-write-serializer'
import { SecureWriteDiscardedError } from '../../shared/secure-file-async-write'

vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({ hasLoadedProviders: () => false })
}))
vi.mock('./orcad-managed-idle-exit', async (importOriginal) => ({
  ...(await importOriginal<typeof ManagedIdleExit>()),
  installOrcadManagedIdleExit: vi.fn(() => () => {})
}))

let root: string

beforeEach(() => {
  vi.clearAllMocks()
  root = mkdtempSync(join(tmpdir(), 'orcad-wsl-holder-release-'))
  vi.stubEnv(ORCAD_MANAGED_ACTIVATION_ROOT_ENV, join(root, 'fence'))
  vi.stubEnv(ORCAD_WSL_HOST_ENV, '1')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  setAppEnvironment({
    getPath: () => root,
    getAppPath: () => root,
    getVersion: () => '0.0.0-test',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

async function idleStop(
  retirement: DaemonIdleRetirementResult,
  options: {
    clientReturns?: boolean
    shutdownAccepted?: boolean
    agentStates?: () => readonly { state: string }[]
    hasStagedMigration?: () => boolean
    automationsBusy?: () => boolean
    emulatorsBusy?: () => Promise<boolean>
    onReady?: (
      activity: { openConnections: number; requestsInFlight: number; lastRequestAt: number },
      shutdown: () => boolean
    ) => void
  } = {}
) {
  const current = createAdapter('current', [], undefined, PROTOCOL_VERSION)
  vi.mocked(current.requestIdleRetirement).mockResolvedValue(retirement)
  installDaemonProvider(null, new DaemonPtyRouter({ current, legacy: [] }))
  const activity = { openConnections: 0, requestsInFlight: 0, lastRequestAt: 0 }
  const shutdown = vi.fn(() => options.shutdownAccepted ?? true)
  bindOrcadIdleShutdown(shutdown)
  await beginOrcadIdleExit(root).start({
    rpc: { readClientActivity: () => activity },
    agentStates: options.agentStates ?? (() => []),
    hasStagedMigration: options.hasStagedMigration ?? (() => false),
    automationsBusy: options.automationsBusy ?? (() => false),
    emulatorsBusy: options.emulatorsBusy ?? (async () => false),
    registerCleanup: () => {}
  })
  const installed = vi.mocked(installOrcadManagedIdleExit).mock.calls.at(-1)?.[0]
  if (!installed) {
    throw new Error('idle monitor was not installed')
  }
  if (options.clientReturns) {
    activity.openConnections = 1
  }
  options.onReady?.(activity, shutdown)
  const stopped = await installed.stop({ quietSince: 0, stoppedAt: 900_000, timeoutMs: 900_000 })
  return { stopped, shutdown }
}

it('asks the WSL holder to let go once an idle stop retired the terminal daemon', async () => {
  const { stopped } = await idleStop({ state: 'retiring' })

  expect(stopped).toBe(true)
  expect(readFileSync(orcadWslHolderReleasePath(root), 'utf8')).toBe(`${process.pid}\n`)
})

it.each([
  ['live terminals keep the daemon', { state: 'busy', liveSessions: 2 } as const],
  ['the daemon could not be proven idle', { state: 'unverifiable' } as const]
])('keeps the distro held when %s', async (_name, retirement) => {
  await idleStop(retirement)

  expect(existsSync(orcadWslHolderReleasePath(root))).toBe(false)
})

it('keeps the distro held when a client returned during the stop', async () => {
  await idleStop({ state: 'retiring' }, { clientReturns: true })

  expect(existsSync(orcadWslHolderReleasePath(root))).toBe(false)
})

it('never writes the request for an orcad no WSL host launched', async () => {
  vi.stubEnv(ORCAD_WSL_HOST_ENV, '')
  await idleStop({ state: 'retiring' })

  expect(existsSync(orcadWslHolderReleasePath(root))).toBe(false)
})

it('withdraws the request when another stop took the shutdown over', async () => {
  await idleStop({ state: 'retiring' }, { shutdownAccepted: false })

  expect(existsSync(orcadWslHolderReleasePath(root))).toBe(false)
})

it('withdraws the request when a stop it asked for ends some other way', () => {
  writeFileSync(orcadWslHolderReleasePath(root), '123\n')
  createIdleStopRecordOwnership(root).onShutdown()

  expect(existsSync(orcadWslHolderReleasePath(root))).toBe(false)
})

it('withdraws an earlier request when a new orcad starts', () => {
  writeFileSync(orcadWslHolderReleasePath(root), '123\n')
  beginOrcadIdleExit(root)

  expect(existsSync(orcadWslHolderReleasePath(root))).toBe(false)
})

it('never touches the request path for an orcad no WSL host launched', () => {
  vi.stubEnv(ORCAD_WSL_HOST_ENV, '')
  writeFileSync(orcadWslHolderReleasePath(root), '123\n')
  beginOrcadIdleExit(root)

  expect(existsSync(orcadWslHolderReleasePath(root))).toBe(true)
})

it('never throws at start when the request cannot be removed', () => {
  // A directory in its place fails the removal like a locked or unwritable file would.
  mkdirSync(join(orcadWslHolderReleasePath(root), 'stuck'), { recursive: true })

  expect(() => beginOrcadIdleExit(root)).not.toThrow()
})

async function holdHolderReleaseWrite() {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const requested = Promise.withResolvers<void>()
  const blocked = serializePathWrite(orcadWslHolderReleasePath(root), async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const holder = await import('./orcad-wsl-holder-release')
  const request = holder.requestOrcadWslHolderRelease
  vi.spyOn(holder, 'requestOrcadWslHolderRelease').mockImplementation((...args) => {
    const writing = request(...args)
    requested.resolve()
    return writing
  })
  return { blocked, release, requested, holder }
}

it('does not request shutdown until the holder release write settles', async () => {
  const held = await holdHolderReleaseWrite()
  const shutdowns: (() => boolean)[] = []
  const stopping = idleStop({ state: 'retiring' }, {
    onReady: (_activity, shutdown) => { shutdowns.push(shutdown) }
  })
  await held.requested.promise
  try {
    expect(shutdowns[0]).not.toHaveBeenCalled()
    expect(existsSync(orcadWslHolderReleasePath(root))).toBe(false)
  } finally {
    held.release.resolve()
    await Promise.allSettled([held.blocked, stopping])
  }
  await expect(stopping).resolves.toMatchObject({ stopped: true })
  expect(readFileSync(orcadWslHolderReleasePath(root), 'utf8')).toBe(`${process.pid}\n`)
})

it('rechecks returning clients after the holder release write settles', async () => {
  const held = await holdHolderReleaseWrite()
  let returnClient = () => {}
  const stopping = idleStop({ state: 'retiring' }, {
    onReady: (activity) => { returnClient = () => { activity.openConnections = 1 } }
  })
  await held.requested.promise
  returnClient()
  held.release.resolve()
  await held.blocked
  const result = await stopping
  expect(result.stopped).toBe(false)
  expect(result.shutdown).not.toHaveBeenCalled()
  expect(existsSync(orcadWslHolderReleasePath(root))).toBe(false)
})

it('does not restore a holder release withdrawn while its write is queued', async () => {
  const held = await holdHolderReleaseWrite()
  const writing = held.holder.requestOrcadWslHolderRelease(root)
  const rejected = expect(writing).rejects.toBeInstanceOf(SecureWriteDiscardedError)
  await held.requested.promise
  held.holder.withdrawOrcadWslHolderRelease(root)
  held.release.resolve()
  await held.blocked
  await rejected
  expect(existsSync(orcadWslHolderReleasePath(root))).toBe(false)
})

it.each(['agent', 'migration', 'automation', 'emulator', 'activation'] as const)(
  'keeps the host alive when %s work returns during holder publication without RPC activity',
  async (kind) => {
    const held = await holdHolderReleaseWrite()
    let busy = false
    const stopping = idleStop({ state: 'retiring' }, {
      agentStates: () => busy && kind === 'agent' ? [{ state: 'working' }] : [],
      hasStagedMigration: () => busy && kind === 'migration',
      automationsBusy: () => busy && kind === 'automation',
      emulatorsBusy: async () => busy && kind === 'emulator'
    })
    await held.requested.promise
    try {
      busy = true
      if (kind === 'activation') {
        mkdirSync(join(root, 'fence'), { recursive: true })
        writeFileSync(join(root, 'fence', RELAY_INSTALL_LOCK_NAME), 'held')
      }
    } finally {
      held.release.resolve()
      await held.blocked
    }
    const result = await stopping
    expect(result.stopped).toBe(false)
    expect(result.shutdown).not.toHaveBeenCalled()
    expect(existsSync(orcadWslHolderReleasePath(root))).toBe(false)
  }
)
