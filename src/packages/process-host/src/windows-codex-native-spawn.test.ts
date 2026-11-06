import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createInstalledCodexFamily } from './__fixtures__/codex-native-launch-fixture'
import { resolveSpawn } from './spawn-resolution'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function createInstallation() {
  const root = mkdtempSync(join(tmpdir(), 'orca-native-spawn-'))
  roots.push(root)
  return createInstalledCodexFamily({ tempRoot: root })
}

describe.skipIf(process.platform !== 'win32')('native Codex spawn resolution', () => {
  it('starts the installed executable with unchanged arguments and child options', () => {
    const install = createInstallation()
    const args = ['exec', '-', '', 'line one\nline two', 'a"b', 'space and & pipe |']
    const env = {
      ...install.env,
      CODEX_HOME: join(install.packageRoot, 'test-home'),
      ORCA_AGENT_SESSION_ID: 'test-session',
      CODEX_MANAGED_BY_BUN: '1'
    }

    const resolved = resolveSpawn(
      {
        program: install.launcher,
        args,
        env,
        cwd: install.packageRoot,
        windowsVerbatimArguments: true
      },
      'win32'
    )

    expect(resolved.file).toBe(install.nativeExecutable)
    expect(resolved.args).toEqual(args)
    expect(resolved.options).toMatchObject({
      cwd: install.packageRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true
    })
    expect(resolved.options.windowsVerbatimArguments).toBeUndefined()
    const { CODEX_MANAGED_BY_BUN: _removed, ...unchangedEnv } = env
    expect(resolved.options.env).toEqual({
      ...unchangedEnv,
      CODEX_MANAGED_PACKAGE_ROOT: install.packageRoot,
      CODEX_MANAGED_BY_NPM: '1'
    })
    expect(env.CODEX_MANAGED_BY_BUN).toBe('1')
    expect(Object.hasOwn(env, 'CODEX_MANAGED_PACKAGE_ROOT')).toBe(false)
  })

  it('keeps the existing Node invocation when native launching is disabled', () => {
    const install = createInstallation()
    const args = ['resume', '--last']
    const env = { ...install.env, ORCA_DISABLE_CODEX_NATIVE_LAUNCH: '1' }

    const resolved = resolveSpawn({ program: install.launcher, args, env }, 'win32')

    expect(resolved.file).toBe(install.node)
    expect(resolved.args).toEqual([join(install.packageRoot, 'bin', 'codex.js'), ...args])
    expect(resolved.options.env).toEqual(env)
  })

  it('does not resolve a Windows installation for a non-Windows execution host', () => {
    const install = createInstallation()
    const args = ['app-server']

    const resolved = resolveSpawn({ program: install.launcher, args, env: install.env }, 'linux')

    expect(resolved.file).toBe(install.launcher)
    expect(resolved.args).toEqual(args)
    expect(resolved.options.env).toEqual(install.env)
  })
})
