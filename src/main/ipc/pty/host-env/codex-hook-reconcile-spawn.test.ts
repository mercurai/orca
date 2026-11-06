import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BuildPtyHostEnvOptions } from './types'

const fixture = vi.hoisted(() => ({
  userData: '',
  nativeResolverCommand: null as string | null,
  scheduleCodexHookReconcile: vi.fn()
}))
vi.mock('../../../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => fixture.userData, onWillQuit: vi.fn() })
}))
vi.mock('../../../agent-hooks/server', () => ({
  agentHookServer: { buildPtyEnv: () => ({ ORCA_AGENT_HOOK_PORT: '12345' }) }
}))
vi.mock('../../../agent-hooks/wsl-hook-relay-manager', () => ({
  wslHookRelayManager: {
    ensureForDistro: vi.fn(),
    getGuestEndpointFilePath: () => '/guest/endpoint.json',
    getOpenCodeOverlayDir: () => join(fixture.userData, 'guest-overlay'),
    getGuestAgentPath: () => null
  }
}))
vi.mock('../../../pi/titlebar-extension-service', () => ({
  piTitlebarExtensionService: { buildPtyEnv: () => ({}), buildFreshOmpEnv: () => ({}) }
}))
vi.mock('../../../cli/orca-cli-child-path', () => ({ prependOrcaCliDirToChildPath: () => {} }))
vi.mock('../../../cli/wsl-managed-cli', () => ({
  getManagedWslCliDir: () => undefined,
  getWslCliCommandName: () => 'orca-ide'
}))
vi.mock('../../../pty/codex-shell-native-resolver', () => ({
  resolveCodexShellNativeResolverCommand: ({
    isPackaged,
    isWsl
  }: {
    isPackaged: boolean
    isWsl?: boolean
  }) => (isPackaged && !isWsl ? fixture.nativeResolverCommand : null)
}))
vi.mock('../../../codex/codex-hook-reconcile', () => ({
  scheduleCodexHookReconcile: fixture.scheduleCodexHookReconcile
}))

import { buildPtyHostEnv } from './assembly'

// Why this file: a codex typed in a native pane reads ~/.codex, so each native
// spawn rechecks Orca's entry there; a WSL pane's Codex never reads it.

let root: string
let options: BuildPtyHostEnvOptions

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-codex-reconcile-spawn-'))
  fixture.userData = join(root, 'user-data')
  vi.stubEnv('HOME', join(root, 'home'))
  vi.stubEnv('USERPROFILE', join(root, 'home'))
  options = {
    isPackaged: true,
    userDataPath: fixture.userData,
    selectedCodexHomePath: null,
    agentStatusHooksEnabled: true
  }
  fixture.nativeResolverCommand = join(root, 'resources', 'bin', 'orca.exe')
  fixture.scheduleCodexHookReconcile.mockClear()
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe("a pane spawn rechecks Orca's entry in ~/.codex", () => {
  it('on a native spawn', () => {
    const env = buildPtyHostEnv(
      'native-pane',
      { oRcA_CoDeX_NaTiVe_ReSoLvEr: 'inherited-orca.exe' },
      options
    )

    expect(env.ORCA_CODEX_NATIVE_RESOLVER).toBe(fixture.nativeResolverCommand)
    expect(
      Object.keys(env).filter((key) => key.toLowerCase() === 'orca_codex_native_resolver')
    ).toEqual(['ORCA_CODEX_NATIVE_RESOLVER'])
    expect(fixture.scheduleCodexHookReconcile).toHaveBeenCalledTimes(1)
  })

  it('on a pane with a selected managed Codex home', () => {
    const env = buildPtyHostEnv(
      'managed-pane',
      {},
      {
        ...options,
        selectedCodexHomePath: join(root, 'managed codex home')
      }
    )

    expect(env.ORCA_CODEX_NATIVE_RESOLVER).toBe(fixture.nativeResolverCommand)
  })

  it('never on a WSL spawn', () => {
    const env = buildPtyHostEnv(
      'wsl-pane',
      { ORCA_CODEX_NATIVE_RESOLVER: 'inherited-orca.exe' },
      { ...options, isWsl: true, wslDistro: 'Ubuntu' }
    )

    expect(env.ORCA_CODEX_NATIVE_RESOLVER).toBeUndefined()
    expect(fixture.scheduleCodexHookReconcile).not.toHaveBeenCalled()
  })

  it('clears an inherited resolver in development panes', () => {
    const env = buildPtyHostEnv(
      'dev-pane',
      { oRcA_CoDeX_NaTiVe_ReSoLvEr: 'inherited-orca.exe' },
      { ...options, isPackaged: false }
    )

    expect(env.ORCA_CODEX_NATIVE_RESOLVER).toBeUndefined()
  })
})
