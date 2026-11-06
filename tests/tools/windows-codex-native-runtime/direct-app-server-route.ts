import { delimiter, dirname, join } from 'node:path'
import {
  readWindowsProcessIdentityTableFresh,
  type WindowsProcessIdentityRow
} from '../../../src/main/windows/windows-process-table'
import { processTreeForRoot } from './process-tree-identity'
import {
  createRuntimeEnvironment,
  type RuntimeMode,
  type RuntimeSettings,
  type RuntimeShell
} from './runtime-environment'

const IDENTITY_WAIT_MS = 15_000
const DIRECT_SHELL: RuntimeShell = {
  name: 'PowerShell 7',
  kind: 'powershell',
  executable: ''
}

export type DirectLaunch = { env: NodeJS.ProcessEnv; command: string; envToDelete: string[] }

export function stringEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}

export function envKeysToDelete(env: NodeJS.ProcessEnv): string[] {
  const overlayKeys = new Set(Object.keys(env))
  return Object.keys(process.env).filter((key) => !overlayKeys.has(key))
}

export function verifySpawnEnvironment(
  env: NodeJS.ProcessEnv | undefined,
  homeRoot: string,
  settings: RuntimeSettings
): void {
  if (!env) {
    throw new Error('Direct app-server spawn did not receive its isolated environment')
  }
  const codexHome = env.CODEX_HOME
  const pathEntries = (env.PATH ?? '').split(delimiter).map(normalizePath)
  if (!codexHome || !normalizePath(codexHome).startsWith(normalizePath(homeRoot))) {
    throw new Error('Direct app-server launch did not receive its isolated temporary CODEX_HOME')
  }
  if (!pathEntries.includes(normalizePath(settings.npmBin))) {
    throw new Error('Direct app-server launch PATH omitted the temporary npm shim directory')
  }
  if (!pathEntries.includes(normalizePath(dirname(process.execPath)))) {
    throw new Error('Direct app-server launch PATH omitted its selected Node runtime')
  }
  if (
    Object.keys(env).some(
      (key) =>
        /^(OPENAI|CODEX|AZURE_OPENAI|ANTHROPIC)_/i.test(key) && key.toUpperCase() !== 'CODEX_HOME'
    )
  ) {
    throw new Error('Direct app-server environment contains inherited provider authentication')
  }
}

export function makeLaunch(
  settings: RuntimeSettings,
  mode: RuntimeMode,
  homeRoot: string
): DirectLaunch {
  const env = createRuntimeEnvironment(settings, DIRECT_SHELL, mode, homeRoot)
  return {
    env,
    command: join(settings.npmBin, 'codex.cmd'),
    envToDelete: envKeysToDelete(env)
  }
}

export async function waitForIdentity(pid: number): Promise<WindowsProcessIdentityRow> {
  const deadline = Date.now() + IDENTITY_WAIT_MS
  while (Date.now() < deadline) {
    const rows = await readWindowsProcessIdentityTableFresh()
    const row = rows.find((candidate) => candidate.pid === pid)
    if (row && typeof row.creationTimeMs === 'number') {
      return row
    }
    await delay(100)
  }
  throw new Error('Direct Codex process identity was unavailable')
}

export function creationTime(row: WindowsProcessIdentityRow): number {
  if (typeof row.creationTimeMs !== 'number') {
    throw new Error('Direct Codex process has no creation time')
  }
  return row.creationTimeMs
}

export function rootKind(row: WindowsProcessIdentityRow): 'node.exe' | 'codex.exe' {
  const name = row.name.toLowerCase()
  if (name === 'node.exe' || name === 'codex.exe') {
    return name
  }
  throw new Error('Direct app-server root was neither the npm Node wrapper nor native executable')
}

export function verifyDirectRoute(
  rows: WindowsProcessIdentityRow[],
  rootPid: number,
  rootCreationTimeMs: number,
  mode: RuntimeMode
): WindowsProcessIdentityRow[] {
  const tree = processTreeForRoot(rows, rootPid, rootCreationTimeMs)
  const root = tree.find((row) => row.pid === rootPid)
  if (!root) {
    throw new Error('Direct app-server root was absent from its process tree')
  }
  const codex = tree.filter((row) => row.name.toLowerCase() === 'codex.exe')
  if (codex.length === 0) {
    throw new Error('Direct app-server route has no native Codex executable')
  }
  if (tree.some((row) => row.name.toLowerCase() === 'orca.exe')) {
    throw new Error('An Orca resolver process remained alive during direct app-server runtime')
  }
  if (mode === 'native' && root.name.toLowerCase() !== 'codex.exe') {
    throw new Error('Direct native app-server did not start as the Codex executable')
  }
  if (mode === 'optout' && root.name.toLowerCase() !== 'node.exe') {
    throw new Error('Direct opt-out app-server did not retain the npm Node.js wrapper')
  }
  const byPid = new Map(tree.map((row) => [row.pid, row]))
  for (const process of codex) {
    let parentPid = process.ppid
    let nodeParent = root.name.toLowerCase() === 'node.exe'
    const seen = new Set<number>()
    while (parentPid !== rootPid) {
      if (seen.has(parentPid)) {
        throw new Error('Direct Codex ancestry contains a PID cycle')
      }
      seen.add(parentPid)
      const parent = byPid.get(parentPid)
      if (!parent) {
        throw new Error('Direct Codex ancestry is incomplete')
      }
      if (parent.name.toLowerCase() === 'node.exe') {
        nodeParent = true
      }
      parentPid = parent.ppid
    }
    if (mode === 'native' && nodeParent) {
      throw new Error('Direct native Codex still has a persistent Node.js launcher parent')
    }
    if (mode === 'optout' && !nodeParent) {
      throw new Error('Direct opt-out Codex lost its npm Node.js launcher parent')
    }
  }
  return tree
}

export function environmentFrom(value: unknown): NodeJS.ProcessEnv | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const env: NodeJS.ProcessEnv = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      env[key] = entry
    }
  }
  return env
}

function normalizePath(value: string): string {
  return value
    .replace(/[\\/]+/g, '\\')
    .replace(/\\$/u, '')
    .toLowerCase()
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}
