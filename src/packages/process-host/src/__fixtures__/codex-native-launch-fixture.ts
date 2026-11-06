/**
 * Synthetic npm install for the official Codex 0.166.0 Windows package family.
 * The adjacent launcher is copied byte-for-byte from the public npm package:
 * @openai/codex@0.166.0/bin/codex.js, SHA-256 e14fc83739c13c1074b12bd1acce4010c893c7f6fbfc1593b4a31d74cabb57af.
 * See codex-native-launcher-0.166.0.NOTICE.txt for source and license.
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { npmProgNodeShim } from './windows-cmd-shim-bodies'

export type CodexWindowsMachine = 'x64' | 'arm64'
export type CodexLauncherKind = 'cmd' | 'shell' | 'powershell'

export type InstalledCodexFamily = {
  launcher: string
  node: string
  nativeExecutable: string
  packageRoot: string
  env: NodeJS.ProcessEnv
}

export type InstalledCodexFamilyOptions = {
  tempRoot: string
  nodeMachine?: CodexWindowsMachine
  launcherKind?: CodexLauncherKind
  shadowShellNode?: boolean
  includeSiblingNodeExe?: boolean
}

const LAUNCHER_SOURCE = join(__dirname, 'codex-native-launcher-0.166.0.txt')

function writePeHeader(path: string, machine: CodexWindowsMachine): void {
  const image = Buffer.alloc(0x88)
  image.write('MZ', 0, 'ascii')
  image.writeUInt32LE(0x80, 0x3c)
  image.write('PE\0\0', 0x80, 'binary')
  image.writeUInt16LE(machine === 'x64' ? 0x8664 : 0xaa64, 0x84)
  writeFileSync(path, image)
}

/** Builds files only; the fixture never executes the copied JavaScript or PE stubs. */
export function createInstalledCodexFamily({
  tempRoot,
  nodeMachine = 'x64',
  launcherKind = 'cmd',
  shadowShellNode = false,
  includeSiblingNodeExe = true
}: InstalledCodexFamilyOptions): InstalledCodexFamily {
  const platformSuffix = `win32-${nodeMachine}`
  const platformVersion = `0.166.0-${platformSuffix}`
  const platformDependency = `@openai/codex-${platformSuffix}`
  const launcherName =
    launcherKind === 'powershell' ? 'codex.ps1' : launcherKind === 'shell' ? 'codex' : 'codex.cmd'
  const launcher = join(tempRoot, launcherName)
  const node = join(tempRoot, 'node.exe')
  const packageRoot = join(tempRoot, 'node_modules', '@openai', 'codex')
  const platformPackageRoot = join(packageRoot, 'node_modules', platformDependency)
  const triple = nodeMachine === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc'
  const nativeExecutable = join(platformPackageRoot, 'vendor', triple, 'bin', 'codex.exe')
  const launcherScript = join(packageRoot, 'bin', 'codex.js')

  mkdirSync(join(packageRoot, 'bin'), { recursive: true })
  mkdirSync(join(platformPackageRoot, 'vendor', triple, 'bin'), { recursive: true })
  if (launcherKind === 'cmd') {
    writeFileSync(launcher, npmProgNodeShim(String.raw`node_modules\@openai\codex\bin\codex.js`))
  } else {
    const shimName =
      launcherKind === 'powershell'
        ? 'codex-native-launcher-powershell-0.166.0.txt'
        : 'codex-native-launcher-shell-0.166.0.txt'
    copyFileSync(join(__dirname, shimName), launcher)
  }
  copyFileSync(LAUNCHER_SOURCE, launcherScript)
  if (includeSiblingNodeExe) {
    writePeHeader(node, nodeMachine)
  }
  if (shadowShellNode) {
    writePeHeader(join(tempRoot, 'node'), nodeMachine === 'x64' ? 'arm64' : 'x64')
  }
  writePeHeader(nativeExecutable, nodeMachine)
  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify(
      {
        name: '@openai/codex',
        version: '0.166.0',
        type: 'module',
        bin: { codex: 'bin/codex.js' },
        optionalDependencies: {
          '@openai/codex-win32-x64': 'npm:@openai/codex@0.166.0-win32-x64',
          '@openai/codex-win32-arm64': 'npm:@openai/codex@0.166.0-win32-arm64'
        }
      },
      null,
      2
    )
  )
  writeFileSync(
    join(platformPackageRoot, 'package.json'),
    JSON.stringify(
      {
        name: '@openai/codex',
        version: platformVersion,
        os: ['win32'],
        cpu: [nodeMachine]
      },
      null,
      2
    )
  )

  return {
    launcher,
    node,
    nativeExecutable,
    packageRoot,
    env: {
      PATH: tempRoot,
      npm_config_user_agent: `npm/11.4.2 node/v26.13.0 win32 ${nodeMachine}`
    }
  }
}
