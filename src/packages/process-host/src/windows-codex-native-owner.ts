import { closeSync, existsSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { dirname, join, win32 } from 'node:path'

type JsonObject = Record<string, unknown>

const MAX_OWNER_METADATA_BYTES = 64 * 1024

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readOwnerMetadata(path: string): JsonObject | null {
  const fd = openSync(path, 'r')
  try {
    const stats = fstatSync(fd)
    if (!stats.isFile() || stats.size > MAX_OWNER_METADATA_BYTES) {
      return null
    }
    const buffer = Buffer.alloc(MAX_OWNER_METADATA_BYTES + 1)
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0)
    if (bytesRead !== stats.size || bytesRead > MAX_OWNER_METADATA_BYTES) {
      return null
    }
    const value: unknown = JSON.parse(buffer.toString('utf8', 0, bytesRead))
    return isJsonObject(value) ? value : null
  } finally {
    closeSync(fd)
  }
}

function sameWindowsPath(left: string, right: string): boolean {
  return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase()
}

function isWithinWindowsPath(parent: string, child: string): boolean {
  const relative = win32.relative(win32.resolve(parent).toLowerCase(), win32.resolve(child).toLowerCase())
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${win32.sep}`) && !win32.isAbsolute(relative))
  )
}

function isPnpmOwned(nodeModulesDir: string, codexPackageRoot: string): boolean {
  if (!existsSync(join(nodeModulesDir, '.modules.yaml'))) {
    return false
  }
  try {
    return sameWindowsPath(realpathSync(join(nodeModulesDir, '@openai', 'codex')), codexPackageRoot)
  } catch {
    return false
  }
}

function isVitePlusOwned(packagesDir: string, codexPackageRoot: string): boolean {
  if (win32.basename(packagesDir).toLowerCase() !== 'packages') {
    return false
  }
  try {
    const metadata = readOwnerMetadata(join(packagesDir, '@openai', 'codex.json'))
    if (!metadata || metadata.name !== '@openai/codex') {
      return false
    }
    const installId = metadata.installId ?? ''
    if (typeof installId !== 'string') {
      return false
    }
    const installDir = installId.startsWith('#')
      ? win32.join(packagesDir, `@openai/codex${installId}`)
      : win32.join(packagesDir, '@openai', 'codex', installId)
    if (!isWithinWindowsPath(packagesDir, installDir)) {
      return false
    }
    return [win32.join(installDir, 'lib', 'node_modules'), win32.join(installDir, 'node_modules')].some(
      (nodeModulesDir) => {
        try {
          return sameWindowsPath(
            realpathSync(join(nodeModulesDir, '@openai', 'codex')),
            codexPackageRoot
          )
        } catch {
          return false
        }
      }
    )
  } catch {
    return false
  }
}

function envValues(env: NodeJS.ProcessEnv, name: string): string[] {
  const lowerName = name.toLowerCase()
  return Object.keys(env)
    .filter((key) => key.toLowerCase() === lowerName)
    .map((key) => env[key])
    .filter((value): value is string => typeof value === 'string')
}

export function hasUnsupportedWindowsCodexOwner(
  codexPackageRoot: string,
  entrypoint: string,
  env: NodeJS.ProcessEnv
): boolean {
  const startDirs = new Set([codexPackageRoot, dirname(entrypoint)])
  for (const startDir of startDirs) {
    const filesystemRoot = win32.parse(startDir).root
    for (let currentDir = startDir; currentDir !== filesystemRoot; currentDir = dirname(currentDir)) {
      if (isVitePlusOwned(currentDir, codexPackageRoot)) {
        return true
      }
      if (isPnpmOwned(join(currentDir, 'node_modules'), codexPackageRoot)) {
        return true
      }
    }
    if (isPnpmOwned(join(filesystemRoot, 'node_modules'), codexPackageRoot)) {
      return true
    }
  }

  if (
    envValues(env, 'npm_config_user_agent').some((value) => /\bbun\//i.test(value)) ||
    envValues(env, 'npm_execpath').some((value) => value.toLowerCase().includes('bun'))
  ) {
    return true
  }
  const normalizedRoot = codexPackageRoot.replace(/\//g, '\\').toLowerCase()
  return (
    normalizedRoot.includes('\\.bun\\install\\global\\') ||
    normalizedRoot.endsWith('\\.bun\\install\\global')
  )
}
