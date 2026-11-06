import { accessSync, constants, statSync } from 'node:fs'
import { getBundledLauncherPath } from '../cli/bundled-cli-launcher-path'

export type CodexShellNativeResolverOptions = {
  isPackaged: boolean
  isWsl?: boolean
  resourcesPath?: string | null
  /** Test seam. */
  platform?: NodeJS.Platform
}

/** Absolute path of the packaged local Windows resolver, or null outside its supported host. */
export function resolveCodexShellNativeResolverCommand(
  options: CodexShellNativeResolverOptions
): string | null {
  const platform = options.platform ?? process.platform
  if (!options.isPackaged || options.isWsl || platform !== 'win32' || !options.resourcesPath) {
    return null
  }

  const candidate = getBundledLauncherPath('win32', options.resourcesPath)
  return candidate && isReadableFile(candidate) ? candidate : null
}

function isReadableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false
    }
    accessSync(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}
