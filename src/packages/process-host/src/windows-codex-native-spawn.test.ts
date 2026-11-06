import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createInstalledCodexFamily } from './__fixtures__/codex-native-launch-fixture'
import {
  WINDOWS_ARGUMENT_CORPUS,
  WINDOWS_ARGUMENT_CORPUS_ENV
} from './__fixtures__/windows-argument-corpus'
import { runProcess } from './run-process'
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
  return createInstalledCodexFamily({
    tempRoot: root,
    nodeMachine: process.arch === 'arm64' ? 'arm64' : 'x64'
  })
}

describe.skipIf(process.platform !== 'win32')('native Codex spawn resolution', () => {
  it('starts the installed executable with unchanged arguments and child options', () => {
    const install = createInstallation()
    const args = ['exec', '-', '', 'line one\nline two', 'a"b', 'space and & pipe |']
    const env: NodeJS.ProcessEnv = {
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

  it('delivers argv, stdin and environment to a real direct Windows child', async () => {
    const install = createInstallation()
    // A renamed Node binary reports exactly what CreateProcess delivered without starting an agent.
    copyFileSync(process.execPath, install.nativeExecutable)
    const values = [...WINDOWS_ARGUMENT_CORPUS.map(({ value }) => value), 'line one\nline two']
    const input = 'piped input\nwith a second line'
    const childProgram = [
      "const fs = require('node:fs')",
      'process.stdout.write(JSON.stringify({',
      'argv: process.argv.slice(1), stdin: fs.readFileSync(0, "utf8"),',
      'cwd: process.cwd(), parentPid: process.ppid,',
      'home: process.env.CODEX_HOME, session: process.env.ORCA_AGENT_SESSION_ID,',
      'packageRoot: process.env.CODEX_MANAGED_PACKAGE_ROOT, npm: process.env.CODEX_MANAGED_BY_NPM,',
      'bun: process.env.CODEX_MANAGED_BY_BUN ?? null, path: process.env.PATH',
      '}))',
      'process.exitCode = 23'
    ].join('\n')
    const env = {
      ...install.env,
      ...WINDOWS_ARGUMENT_CORPUS_ENV,
      SystemRoot: process.env.SystemRoot,
      CODEX_HOME: join(install.packageRoot, 'account-home'),
      ORCA_AGENT_SESSION_ID: 'native-child-session',
      CODEX_MANAGED_BY_BUN: '1'
    }

    const result = await runProcess({
      program: install.launcher,
      args: ['-e', childProgram, '--', ...values],
      env,
      cwd: install.packageRoot,
      input,
      timeoutMs: 15_000
    })

    expect(result.code).toBe(23)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({
      argv: values,
      stdin: input,
      cwd: install.packageRoot,
      parentPid: process.pid,
      home: env.CODEX_HOME,
      session: env.ORCA_AGENT_SESSION_ID,
      packageRoot: install.packageRoot,
      npm: '1',
      bun: null,
      path: env.PATH
    })
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
