import { statSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'

type ReportCli = {
  executable: string
  argvPrefix: readonly string[]
  mode: 'native' | 'electron-cli'
}

/** Resolve THIS host's CLI; the model and inherited ORCA_CLI_COMMAND cannot select it. */
export function resolvePiWorkerReportCli(
  options: { platform?: NodeJS.Platform; resourcesPath?: string } = {}
): ReportCli {
  if (!hasAppEnvironment()) {
    throw new Error('Pi reporting requires the current host app environment')
  }
  const platform = options.platform ?? process.platform
  const paths = platform === 'win32' ? win32 : posix
  const app = getAppEnvironment()
  const launcher = app.getCliLauncherPath?.()
  if (launcher) {
    requireExecutable(launcher, platform)
    return { executable: launcher, argvPrefix: [], mode: 'native' }
  }
  if (!app.isPackaged()) {
    const executable = app.getPath('exe')
    const entry = paths.join(app.getAppPath(), 'out', 'cli', 'index.js')
    requireExecutable(executable, platform)
    requireFile(entry, platform)
    // Why no .cmd: the host supplies the same executable/entry as its dev launcher.
    // The adapter sets only fixed Electron flags; session identity remains inherited env.
    return { executable, argvPrefix: [entry], mode: 'electron-cli' }
  }
  const resourcesPath = options.resourcesPath ?? process.resourcesPath
  if (!resourcesPath || !paths.isAbsolute(resourcesPath)) {
    throw new Error('Pi reporting requires the current installed CLI location')
  }
  const command = platform === 'win32' ? 'orca.exe' : platform === 'linux' ? 'orca-ide' : 'orca'
  const executable = paths.join(resourcesPath, 'bin', command)
  requireExecutable(executable, platform)
  return { executable, argvPrefix: [], mode: 'native' }
}

function requireExecutable(path: string, platform: NodeJS.Platform): void {
  if (/\.(?:cmd|bat)$/i.test(path) || (platform === 'win32' && !/\.exe$/i.test(path))) {
    throw new Error('Pi reporting requires a native CLI launcher, not a shell command')
  }
  requireFile(path, platform)
}

function requireFile(path: string, platform: NodeJS.Platform): void {
  const paths = platform === 'win32' ? win32 : posix
  if (!paths.isAbsolute(path) || /[\0\r\n]/.test(path)) {
    throw new Error('Pi reporting requires an absolute host file path')
  }
  try {
    if (statSync(path).isFile()) return
  } catch {
    // Missing or inaccessible host files must not fall back to another runtime on PATH.
  }
  throw new Error('Pi reporting host CLI file is unavailable')
}
