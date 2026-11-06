import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyWindowsCodexNativeEnvironment,
  resolveWindowsCodexNativeLaunch
} from './windows-codex-native-resolution'
import {
  createInstalledCodexFamily,
  type CodexLauncherKind,
  type CodexWindowsMachine,
  type InstalledCodexFamily
} from './__fixtures__/codex-native-launch-fixture'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function createFamily(
  nodeMachine: CodexWindowsMachine = 'x64',
  launcherKind: CodexLauncherKind = 'cmd',
  shadowShellNode = false,
  includeSiblingNodeExe = true
): InstalledCodexFamily {
  const tempRoot = mkdtempSync(join(tmpdir(), 'orca-codex-native-'))
  roots.push(tempRoot)
  return createInstalledCodexFamily({
    tempRoot,
    nodeMachine,
    launcherKind,
    shadowShellNode,
    includeSiblingNodeExe
  })
}

function resolveFamily(
  family: InstalledCodexFamily,
  env: NodeJS.ProcessEnv = family.env,
  options: { platform?: NodeJS.Platform; customNodeEnv?: boolean } = {}
) {
  return resolveWindowsCodexNativeLaunch({
    launcher: family.launcher,
    node: family.node,
    env,
    platform: 'win32',
    ...options
  })
}

describe('Windows Codex child environment', () => {
  it('applies the environment delta to a case-insensitive clone', () => {
    const original = {
      CODEX_MANAGED_PACKAGE_ROOT: 'old-root',
      CODEX_MANAGED_BY_NPM: 'old',
      codex_managed_by_bun: '1',
      CODEX_MANAGED_BY_PNPM: '1',
      CODEX_MANAGED_BY_VITE_PLUS: '1',
      PATH: 'user-path',
      ORCA_AGENT_SESSION_ID: 'session-1'
    }

    const childEnv = applyWindowsCodexNativeEnvironment(original, {
      managedPackageRoot: 'fixture-codex-root',
      manager: 'npm'
    })

    expect(childEnv).not.toBe(original)
    expect(childEnv.CODEX_MANAGED_PACKAGE_ROOT).toBe('fixture-codex-root')
    expect(childEnv.CODEX_MANAGED_BY_NPM).toBe('1')
    expect(
      Object.keys(childEnv).filter((key) => key.toLowerCase().startsWith('codex_managed_by_'))
    ).toEqual(['CODEX_MANAGED_BY_NPM'])
    expect(childEnv.PATH).toBe('user-path')
    expect(childEnv.ORCA_AGENT_SESSION_ID).toBe('session-1')
    expect(original.CODEX_MANAGED_BY_NPM).toBe('old')
    expect(original.codex_managed_by_bun).toBe('1')
  })
})

describe('Windows Codex native resolver platform gate', () => {
  it('returns the fixed unsupported-context reason off Windows', () => {
    expect(
      resolveWindowsCodexNativeLaunch({ launcher: 'codex.cmd', env: {}, platform: 'linux' })
    ).toEqual({ outcome: 'fallback', reason: 'unsupported_context' })
  })
})

describe.skipIf(process.platform !== 'win32')('Windows Codex native launch resolution', () => {
  it('admits the approved npm alias layout and derives only its manager metadata', () => {
    const family = createFamily()

    expect(resolveFamily(family)).toEqual({
      outcome: 'native',
      nativeExecutable: family.nativeExecutable,
      environmentDelta: { managedPackageRoot: family.packageRoot, manager: 'npm' }
    })
  })

  it('selects the platform package from the actual Node PE machine', () => {
    const family = createFamily('arm64')

    expect(resolveFamily(family)).toMatchObject({
      outcome: 'native',
      nativeExecutable: family.nativeExecutable
    })
  })

  it('uses the launcher default npm manager when no user-agent is present', () => {
    const family = createFamily()
    const env = { ...family.env }
    delete env.npm_config_user_agent

    expect(resolveFamily(family, env)).toMatchObject({
      outcome: 'native',
      environmentDelta: { manager: 'npm' }
    })
  })

  it('does not treat a pnpm user-agent as install ownership by itself', () => {
    const family = createFamily()

    expect(
      resolveFamily(family, {
        ...family.env,
        npm_config_user_agent: 'pnpm/10.0.0 node/v26.13.0 win32 x64'
      })
    ).toMatchObject({ outcome: 'native', environmentDelta: { manager: 'npm' } })
  })

  it.each(['shell', 'powershell'] as const)(
    'recognizes the selected %s source without consulting a neighboring .cmd',
    (launcherKind) => {
      const family = createFamily('x64', launcherKind)

      expect(existsSync(join(dirname(family.launcher), 'codex.cmd'))).toBe(false)
      expect(resolveFamily(family)).toMatchObject({
        outcome: 'native',
        nativeExecutable: family.nativeExecutable
      })
    }
  )

  it.each(['shell', 'powershell'] as const)(
    'derives the sibling Node for %s without an explicit Node argument',
    (launcherKind) => {
      const family = createFamily('x64', launcherKind)

      expect(
        resolveWindowsCodexNativeLaunch({
          launcher: family.launcher,
          env: family.env,
          platform: 'win32'
        })
      ).toMatchObject({ outcome: 'native', nativeExecutable: family.nativeExecutable })
    }
  )

  it('requires the shell-selected Node executable for extensionless launchers', () => {
    const family = createFamily('x64', 'shell', false, false)

    expect(
      resolveWindowsCodexNativeLaunch({ launcher: family.launcher, env: family.env, platform: 'win32' })
    ).toMatchObject({ outcome: 'fallback' })
  })

  it('accepts the explicitly selected Node when the shell launcher has no sibling', () => {
    const family = createFamily('x64', 'shell', false, false)
    const pathNode = createFamily('x64').node

    expect(
      resolveWindowsCodexNativeLaunch({
        launcher: family.launcher,
        node: pathNode,
        env: { ...family.env, PATH: dirname(pathNode) },
        platform: 'win32'
      })
    ).toMatchObject({ outcome: 'native', nativeExecutable: family.nativeExecutable })
  })

  it('keeps a PowerShell launcher on its sibling Node executable', () => {
    const family = createFamily('x64', 'powershell')
    const otherNode = createFamily('arm64').node

    expect(
      resolveWindowsCodexNativeLaunch({
        launcher: family.launcher,
        node: otherNode,
        env: family.env,
        platform: 'win32'
      })
    ).toMatchObject({ outcome: 'fallback' })
  })

  it('rejects a shell-selected sibling node that shadows node.exe', () => {
    const family = createFamily('x64', 'shell', true)

    expect(
      resolveWindowsCodexNativeLaunch({
        launcher: family.launcher,
        node: family.node,
        env: family.env,
        platform: 'win32'
      })
    ).toMatchObject({ outcome: 'fallback', reason: 'unverified_install' })
  })

  it.each([
    ['.cmd', 'cmd'],
    ['Bash', 'shell'],
    ['PowerShell', 'powershell']
  ] as const)(
    'rejects empty and relative supplied Node paths for %s launchers',
    (_label, launcherKind) => {
      const family = createFamily('x64', launcherKind)
      for (const node of ['', 'node.exe']) {
        expect(
          resolveWindowsCodexNativeLaunch({
            launcher: family.launcher,
            node,
            env: family.env,
            platform: 'win32'
          })
        ).toMatchObject({ outcome: 'fallback', reason: 'unverified_install' })
      }
    }
  )

  it.each([
    ['NODE_OPTIONS', { NODE_OPTIONS: '--trace-warnings' }],
    ['mixed-case NODE_OPTIONS', { node_options: '--trace-warnings' }],
    ['NODE_PATH', { NODE_PATH: 'C:\\fixture\\node_modules' }],
    ['mixed-case NODE_PATH', { node_path: 'C:\\fixture\\node_modules' }],
    ['ORCA_NODE_OPTIONS', { ORCA_NODE_OPTIONS: '--trace-warnings' }],
    ['the native-launch opt-out', { ORCA_DISABLE_CODEX_NATIVE_LAUNCH: '1' }],
    ['the existing shim-resolution opt-out', { ORCA_DISABLE_CMD_SHIM_RESOLUTION: '1' }]
  ])('keeps the fallback route when %s is active', (_case, envDelta) => {
    const family = createFamily()

    expect(resolveFamily(family, { ...family.env, ...envDelta })).toMatchObject({
      outcome: 'fallback'
    })
  })

  it('falls back when custom NODE_OPTIONS were removed before resolution', () => {
    const family = createFamily()

    expect(resolveFamily(family, family.env, { customNodeEnv: true })).toMatchObject({
      outcome: 'fallback'
    })
  })

  it('rejects an npm package version outside the reviewed allowlist', () => {
    const family = createFamily()
    const manifestPath = join(family.packageRoot, 'package.json')
    const manifest = readFileSync(manifestPath, 'utf8')
    writeFileSync(manifestPath, manifest.replace('"version": "0.166.0"', '"version": "0.167.0"'))

    expect(resolveFamily(family)).toMatchObject({
      outcome: 'fallback',
      reason: 'unverified_install'
    })
  })

  it('rejects pnpm ownership when its marker and canonical package path match', () => {
    const family = createFamily()
    const nodeModules = join(dirname(family.launcher), 'node_modules')
    mkdirSync(nodeModules, { recursive: true })
    writeFileSync(join(nodeModules, '.modules.yaml'), 'storeDir: fixture-store\n')

    expect(resolveFamily(family)).toMatchObject({ outcome: 'fallback', reason: 'unverified_install' })
  })

  it('does not infer pnpm installation ownership from publishing metadata', () => {
    const family = createFamily()
    const manifestPath = join(family.packageRoot, 'package.json')
    const manifest = readFileSync(manifestPath, 'utf8')
    writeFileSync(
      manifestPath,
      manifest.replace('"type": "module",', '"type": "module",\n  "packageManager": "pnpm@10.34.5",')
    )

    expect(resolveFamily(family).outcome).toBe('native')
  })

  it('rejects Vite+ ownership when valid metadata exceeds the resolver read limit', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'orca-codex-vite-plus-'))
    roots.push(tempRoot)
    const packagesDir = join(tempRoot, 'packages')
    const installId = 'codex-0.166.0-fixture'
    const installDir = join(packagesDir, '@openai', 'codex', installId)
    const family = createInstalledCodexFamily({ tempRoot: join(installDir, 'lib') })
    const metadataPath = join(packagesDir, '@openai', 'codex.json')
    const metadata = JSON.stringify({
      name: '@openai/codex',
      installId,
      padding: 'x'.repeat(70 * 1024)
    })
    mkdirSync(dirname(metadataPath), { recursive: true })
    writeFileSync(metadataPath, metadata)

    expect(Buffer.byteLength(metadata)).toBeGreaterThan(64 * 1024)
    expect(resolveFamily(family)).toMatchObject({
      outcome: 'fallback',
      reason: 'unverified_install'
    })
  })

  it('rejects a Bun installation hint', () => {
    const family = createFamily()

    expect(
      resolveFamily(family, {
        ...family.env,
        npm_config_user_agent: 'bun/1.2.0 node/v26.13.0 win32 x64'
      })
    ).toMatchObject({ outcome: 'fallback', reason: 'unverified_install' })
  })

  it('reports an unavailable native package without starting the launcher', () => {
    const family = createFamily()
    rmSync(family.nativeExecutable)

    expect(resolveFamily(family)).toMatchObject({
      outcome: 'fallback',
      reason: 'native_unavailable'
    })
  })

  it('rejects a native PE image that does not match the selected Node machine', () => {
    const family = createFamily()
    const image = readFileSync(family.nativeExecutable)
    image.writeUInt16LE(0xaa64, 0x84)
    writeFileSync(family.nativeExecutable, image)

    expect(resolveFamily(family)).toMatchObject({
      outcome: 'fallback',
      reason: 'native_unavailable'
    })
  })

  it('rejects a truncated native PE image', () => {
    const family = createFamily()
    writeFileSync(family.nativeExecutable, Buffer.from('MZ'))

    expect(resolveFamily(family)).toMatchObject({
      outcome: 'fallback',
      reason: 'native_unavailable'
    })
  })

  it('revalidates the launcher fingerprint on every call', () => {
    const family = createFamily()
    const scriptPath = join(family.packageRoot, 'bin', 'codex.js')

    expect(resolveFamily(family).outcome).toBe('native')
    writeFileSync(scriptPath, `${readFileSync(scriptPath, 'utf8')}\n`)

    expect(resolveFamily(family)).toMatchObject({
      outcome: 'fallback',
      reason: 'unverified_install'
    })
  })
})
