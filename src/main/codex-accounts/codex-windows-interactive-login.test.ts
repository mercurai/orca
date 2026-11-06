import { afterAll, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as NodeOs from 'node:os'
import { getCmdExePath } from '../../shared/windows-batch-spawn'
import { CODEX_LOGIN_CANCELLED_MESSAGE } from '../../shared/codex-auth-errors'
import { createInstalledCodexFamily } from '../../packages/process-host/src/__fixtures__/codex-native-launch-fixture'
import type { CodexLoginSpawnRequest } from './codex-login-session'
import {
  createRateLimits,
  createRuntimeHome,
  createSettings,
  createStore,
  registerCodexAccountsTestHomes,
  testState
} from './service-test-harness'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

const codexFixtureRoots: string[] = []
afterAll(() => {
  for (const root of codexFixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function createInstalledCodex() {
  const root = mkdtempSync(join(tmpdir(), 'orca-codex-login-'))
  codexFixtureRoots.push(root)
  return createInstalledCodexFamily({
    tempRoot: root,
    nodeMachine: process.arch === 'arm64' ? 'arm64' : 'x64'
  })
}

function createLoginChild(): EventEmitter & {
  stdout: null
  stderr: null
  kill: () => boolean
  pid: number
  exitCode: number | null
  signalCode: string | null
} {
  const exitCode: number | null = null
  const signalCode: string | null = null
  return Object.assign(new EventEmitter(), {
    stdout: null,
    stderr: null,
    kill: () => true,
    pid: 4242,
    exitCode,
    signalCode
  })
}

function decodeLoginScript(args: string[]): string {
  const encodedCommandIndex = args.indexOf('-EncodedCommand')
  const encodedCommand = args[encodedCommandIndex + 1]
  if (!encodedCommand) {
    throw new Error('The PowerShell login relay did not include an encoded command.')
  }
  return Buffer.from(encodedCommand, 'base64').toString('utf16le')
}

function encodeLoginValue(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

async function getRejectedMessage(promise: Promise<void>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('Expected the Codex login to reject.')
}

describe('Codex Windows host interactive login', () => {
  registerCodexAccountsTestHomes()

  it('resolves a Windows login whose child has no piped streams', async () => {
    vi.resetModules()
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const child = new EventEmitter() as EventEmitter & {
      stdout: null
      stderr: null
      kill: ReturnType<typeof vi.fn>
      pid: number
    }
    child.stdout = null
    child.stderr = null
    child.kill = vi.fn()
    child.pid = 4242
    const spawnMock = vi.fn(() => {
      queueMicrotask(() => child.emit('close', 0))
      return child
    })
    const buildInteractiveLoginSpawn = vi.fn(() => ({
      command: getCmdExePath(),
      args: ['/d', '/c', 'start', '', '/wait', 'C:\\Tools\\codex.cmd', 'login'],
      stdio: 'ignore' as const,
      windowsHide: true
    }))
    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn(),
      spawn: spawnMock
    }))
    vi.doMock('../codex-cli/command', () => ({
      resolveCodexCommand: () => 'C:\\Tools\\codex.cmd'
    }))
    vi.doMock('../../shared/windows-interactive-login-spawn', () => ({
      buildWindowsHostInteractiveLoginSpawn: buildInteractiveLoginSpawn
    }))

    try {
      const { CodexAccountService } = await import('./service')
      const service = new CodexAccountService(
        createStore(createSettings()) as never,
        createRateLimits() as never,
        createRuntimeHome() as never
      )
      await (
        service as unknown as {
          runCodexLogin(managedHomePath: string): Promise<void>
        }
      ).runCodexLogin(testState.fakeHomeDir)

      expect(buildInteractiveLoginSpawn).toHaveBeenCalledWith('C:\\Tools\\codex.cmd', ['login'])
      expect(spawnMock).toHaveBeenCalledWith(
        getCmdExePath(),
        expect.arrayContaining(['start', '', '/wait']),
        expect.objectContaining({
          stdio: 'ignore',
          windowsHide: true
        })
      )
      expect(child.kill).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform)
      vi.doUnmock('node:child_process')
      vi.doUnmock('../codex-cli/command')
      vi.doUnmock('../../shared/windows-interactive-login-spawn')
    }
  })
})

describe.skipIf(process.platform !== 'win32')('Codex Windows native login launch', () => {
  it('resolves the inner Codex command before the console wrapper and preserves cancellation', async () => {
    const install = createInstalledCodex()
    const managedHomePath = join(install.packageRoot, 'account-home')
    const child = createLoginChild()
    const spawnRequests: CodexLoginSpawnRequest[] = []
    let cancelLogin: (() => boolean) | null = null
    const killProcessTree = vi.fn()
    vi.stubEnv('PATH', install.env.PATH ?? '')
    vi.stubEnv('npm_config_user_agent', install.env.npm_config_user_agent ?? '')
    vi.stubEnv('ORCA_DISABLE_CODEX_NATIVE_LAUNCH', '')
    vi.stubEnv('CODEX_HOME', 'inherited-user-home')
    vi.stubEnv('CODEX_MANAGED_BY_BUN', '1')
    vi.stubEnv('ORCA_AGENT_SESSION_ID', 'account-login-session')
    vi.resetModules()
    vi.doMock('../codex-cli/command', () => ({
      resolveCodexCommand: () => install.launcher
    }))

    try {
      const { runCodexLoginSession } = await import('./codex-login-session')
      const loginPromise = runCodexLoginSession(managedHomePath, {
        wslCommand: 'wsl.exe',
        spawn: (request) => {
          spawnRequests.push(request)
          return child
        },
        killProcessTree,
        setCancel: (cancel) => {
          cancelLogin = cancel
        },
        onAuthUrl: vi.fn()
      })

      expect(spawnRequests).toHaveLength(1)
      const request = spawnRequests[0]
      if (!request) {
        throw new Error('Codex login did not request a process.')
      }
      expect(request.command).toBe(getCmdExePath())
      expect(request.args.slice(0, 5)).toEqual(['/d', '/c', 'start', '', '/wait'])
      expect(request.args[5]).toMatch(/WindowsPowerShell\\v1\.0\\powershell\.exe$/i)
      const script = decodeLoginScript(request.args)
      expect(script).toContain(encodeLoginValue(install.nativeExecutable))
      expect(script).toContain(encodeLoginValue('login'))
      expect(script).toContain('[string]$PID')
      expect(request.stdio).toBe('ignore')
      expect(request.env).toMatchObject({
        CODEX_HOME: managedHomePath,
        ORCA_AGENT_SESSION_ID: 'account-login-session',
        CODEX_MANAGED_PACKAGE_ROOT: install.packageRoot,
        CODEX_MANAGED_BY_NPM: '1'
      })
      expect(request.env.PATH ?? request.env.Path).toBe(install.env.PATH)
      expect(request.env).not.toHaveProperty('CODEX_MANAGED_BY_BUN')
      expect(process.env.CODEX_MANAGED_BY_BUN).toBe('1')

      if (!cancelLogin) {
        throw new Error('Codex login cancellation was not registered.')
      }
      expect(cancelLogin()).toBe(true)
      await expect(loginPromise).rejects.toThrow(CODEX_LOGIN_CANCELLED_MESSAGE)
      expect(killProcessTree).toHaveBeenCalledWith(
        child,
        expect.objectContaining({
          cleanup: expect.any(Function),
          getTerminationPid: expect.any(Function),
          waitForTerminationPid: expect.any(Function)
        })
      )
      expect(child.listenerCount('error')).toBe(0)
      expect(child.listenerCount('close')).toBe(0)
    } finally {
      vi.doUnmock('../codex-cli/command')
      vi.unstubAllEnvs()
    }
  })

  it('keeps the wrapped launcher when native launching is disabled', async () => {
    const install = createInstalledCodex()
    const managedHomePath = join(install.packageRoot, 'fallback-account-home')
    const child = createLoginChild()
    const spawnRequests: CodexLoginSpawnRequest[] = []
    vi.stubEnv('PATH', install.env.PATH ?? '')
    vi.stubEnv('npm_config_user_agent', install.env.npm_config_user_agent ?? '')
    vi.stubEnv('ORCA_DISABLE_CODEX_NATIVE_LAUNCH', '1')
    vi.stubEnv('CODEX_HOME', 'inherited-user-home')
    vi.stubEnv('CODEX_MANAGED_BY_BUN', '1')
    vi.resetModules()
    vi.doMock('../codex-cli/command', () => ({
      resolveCodexCommand: () => install.launcher
    }))

    try {
      const { runCodexLoginSession } = await import('./codex-login-session')
      await runCodexLoginSession(managedHomePath, {
        wslCommand: 'wsl.exe',
        spawn: (request) => {
          spawnRequests.push(request)
          queueMicrotask(() => child.emit('close', 0))
          return child
        },
        killProcessTree: vi.fn(),
        setCancel: vi.fn(),
        onAuthUrl: vi.fn()
      })

      const request = spawnRequests[0]
      if (!request) {
        throw new Error('Codex login did not request a process.')
      }
      expect(request.command).toBe(getCmdExePath())
      const script = decodeLoginScript(request.args)
      expect(script).toContain(encodeLoginValue(install.launcher))
      expect(script).not.toContain(encodeLoginValue(install.nativeExecutable))
      expect(request.env).toMatchObject({ CODEX_HOME: managedHomePath })
      expect(request.env.PATH ?? request.env.Path).toBe(install.env.PATH)
      expect(request.env.CODEX_MANAGED_BY_BUN).toBe('1')
      expect(child.listenerCount('error')).toBe(0)
      expect(child.listenerCount('close')).toBe(0)
    } finally {
      vi.doUnmock('../codex-cli/command')
      vi.unstubAllEnvs()
    }
  })
})

describe.skipIf(process.platform !== 'win32')('Codex Windows native login errors', () => {
  it('does not diagnose a native launch ENOENT as missing Node.js', async () => {
    const install = createInstalledCodex()
    const managedHomePath = join(install.packageRoot, 'missing-executable-account-home')
    const child = createLoginChild()
    const spawnRequests: CodexLoginSpawnRequest[] = []
    const buildInteractiveLoginSpawn = vi.fn((_command: string, args: string[]) => ({
      command: install.nativeExecutable,
      args,
      stdio: 'ignore' as const,
      windowsHide: true,
      cleanup: vi.fn(),
      getTerminationPid: () => null,
      waitForTerminationPid: async () => null
    }))
    vi.stubEnv('PATH', install.env.PATH ?? '')
    vi.stubEnv('npm_config_user_agent', install.env.npm_config_user_agent ?? '')
    vi.stubEnv('ORCA_DISABLE_CODEX_NATIVE_LAUNCH', '')
    vi.resetModules()
    vi.doMock('../codex-cli/command', () => ({
      resolveCodexCommand: () => install.launcher
    }))
    vi.doMock('../../shared/windows-interactive-login-spawn', () => ({
      buildWindowsHostInteractiveLoginSpawn: buildInteractiveLoginSpawn
    }))

    try {
      const { runCodexLoginSession } = await import('./codex-login-session')
      const loginPromise = runCodexLoginSession(managedHomePath, {
        wslCommand: 'wsl.exe',
        spawn: (request) => {
          spawnRequests.push(request)
          const error = Object.assign(new Error('native executable missing'), { code: 'ENOENT' })
          queueMicrotask(() => child.emit('error', error))
          return child
        },
        killProcessTree: vi.fn(),
        setCancel: vi.fn(),
        onAuthUrl: vi.fn()
      })

      const message = await getRejectedMessage(loginPromise)
      expect(buildInteractiveLoginSpawn).toHaveBeenCalledWith(install.nativeExecutable, ['login'])
      expect(spawnRequests[0]?.command).toBe(install.nativeExecutable)
      expect(message).toContain('required executable was not found')
      expect(message).not.toContain('Node.js')
    } finally {
      vi.doUnmock('../codex-cli/command')
      vi.doUnmock('../../shared/windows-interactive-login-spawn')
      vi.unstubAllEnvs()
    }
  })
})

describe('Codex login ENOENT diagnostics', () => {
  it.each([
    ['a bare command', 'codex', 'Codex CLI not found.'],
    [
      'a full-path wrapper',
      'C:/Tools/codex.cmd',
      'Node.js may not be in your PATH.'
    ],
    ['an explicit executable', 'C:/Tools/codex.exe', 'required executable was not found']
  ])('uses the right error guidance for %s', async (_, codexCommand, expectedMessage) => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const child = createLoginChild()
    const buildInteractiveLoginSpawn = vi.fn(() => ({
      command: 'C:/Windows/System32/cmd.exe',
      args: ['/d', '/c', 'start', '', '/wait', 'C:/Tools/codex.cmd', 'login'],
      stdio: 'ignore' as const,
      windowsHide: true,
      cleanup: vi.fn(),
      getTerminationPid: () => null,
      waitForTerminationPid: async () => null
    }))
    vi.stubEnv('ORCA_DISABLE_CODEX_NATIVE_LAUNCH', '1')
    vi.resetModules()
    vi.doMock('../codex-cli/command', () => ({ resolveCodexCommand: () => codexCommand }))
    vi.doMock('../../shared/windows-interactive-login-spawn', () => ({
      buildWindowsHostInteractiveLoginSpawn: buildInteractiveLoginSpawn
    }))

    try {
      const { runCodexLoginSession } = await import('./codex-login-session')
      const loginPromise = runCodexLoginSession(join(tmpdir(), 'codex-login-error-home'), {
        wslCommand: 'wsl.exe',
        spawn: () => {
          const error = Object.assign(new Error('host wrapper missing'), { code: 'ENOENT' })
          queueMicrotask(() => child.emit('error', error))
          return child
        },
        killProcessTree: vi.fn(),
        setCancel: vi.fn(),
        onAuthUrl: vi.fn()
      })
      const message = await getRejectedMessage(loginPromise)

      expect(message).toContain(expectedMessage)
      expect(buildInteractiveLoginSpawn).toHaveBeenCalledWith(codexCommand, ['login'])
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform)
      vi.doUnmock('../codex-cli/command')
      vi.doUnmock('../../shared/windows-interactive-login-spawn')
      vi.unstubAllEnvs()
    }
  })
})
