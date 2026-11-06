import {
  applyWindowsCodexNativeEnvironment,
  resolveWindowsCodexNativeLaunch
} from '@orca/process-host/windows-codex-native-resolution'
import type { WindowsHostInteractiveLoginSpawn } from '../../shared/windows-interactive-login-spawn'
import { buildWindowsHostInteractiveLoginSpawn } from '../../shared/windows-interactive-login-spawn'
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { resolveCodexCommand } from '../codex-cli/command'
import { getSpawnArgsForWindows } from '../win32-utils'
import { runWslProcess } from '../wsl/wsl-runner'
import {
  buildWslCodexAvailabilityScript,
  WSL_CODEX_AVAILABILITY_TIMEOUT_MS
} from './wsl-codex-command'

export function createHostLoginSpawn(managedHomePath: string): {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  codexCommand: string
  directExecutable: boolean
  interactiveLogin: WindowsHostInteractiveLoginSpawn | null
} {
  const codexCommand = resolveCodexCommand()
  const childEnv = withCliRuntimeOnPath(codexCommand, {
    ...process.env,
    CODEX_HOME: managedHomePath
  })
  const resolution =
    process.platform === 'win32'
      ? resolveWindowsCodexNativeLaunch({
          launcher: codexCommand,
          env: childEnv,
          platform: process.platform
        })
      : null
  const nativeResolution = resolution?.outcome === 'native' ? resolution : null
  const directExecutable =
    nativeResolution !== null || (process.platform === 'win32' && /\.exe$/i.test(codexCommand))
  const loginCommand = nativeResolution?.nativeExecutable ?? codexCommand
  const loginEnv = nativeResolution
    ? applyWindowsCodexNativeEnvironment(childEnv, nativeResolution.environmentDelta)
    : childEnv
  // Why: Windows host login needs a real console; otherwise inherit/hide
  // leaves the child unable to read a paste-code / device-auth prompt.
  const interactiveLogin =
    process.platform === 'win32'
      ? buildWindowsHostInteractiveLoginSpawn(loginCommand, ['login'])
      : null
  const { spawnCmd, spawnArgs } = interactiveLogin
    ? { spawnCmd: interactiveLogin.command, spawnArgs: interactiveLogin.args }
    : getSpawnArgsForWindows(loginCommand, ['login'])
  return {
    command: spawnCmd,
    args: spawnArgs,
    env: loginEnv,
    codexCommand,
    directExecutable,
    interactiveLogin
  }
}

export async function assertWslCodexCliAvailable(wslInfo: {
  distro: string
  linuxPath: string
}): Promise<void> {
  // This is a PATH lookup, so it needs the login PATH: an nvm-installed codex lives nowhere else.
  const result = await runWslProcess({
    distro: wslInfo.distro,
    loginPath: 'preferred',
    script: buildWslCodexAvailabilityScript(),
    shell: 'sh',
    timeoutMs: WSL_CODEX_AVAILABILITY_TIMEOUT_MS
  })
  if (result.code !== 0 && !result.environmentResolved) {
    throw new Error('Could not check the Codex CLI in WSL. Try again.')
  }
  if (result.code !== 0 || result.timedOut) {
    throw new Error(
      `Codex CLI is not available in WSL ${wslInfo.distro}. Install Codex in that distro or switch Account location to Windows.`,
      { cause: new Error(result.stderr.trim() || `codex lookup exited with ${result.code}`) }
    )
  }
}
