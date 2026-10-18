import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  readConfigPathSignatures,
  readLocalGitConfigSignature,
  resolveLocalGitConfigPaths,
  withConfigSignatureDeadline
} from '../github/local-git-config-signature'

// Why: the repo-level config signature does not cover the user's global git config, which feeds
// github.user / user.username / user.name, nor HEAD, which picks the branch whose remote counts.
// The gh login also decides the username, so gh's hosts file (changed by login, logout and switch) is stamped.
// Every read here is bounded by the 2 s config-signature deadline: a stuck mount must not wedge the pass.

function ghHostsFilePath(home: string): string {
  const configDir =
    process.env.GH_CONFIG_DIR ||
    (process.env.XDG_CONFIG_HOME && join(process.env.XDG_CONFIG_HOME, 'gh')) ||
    (process.platform === 'win32' && process.env.APPDATA
      ? join(process.env.APPDATA, 'GitHub CLI')
      : join(home, '.config', 'gh'))
  return join(configDir, 'hosts.yml')
}

// Stat only: hosts.yml may hold a token, so its content is never read.
async function statStamp(path: string): Promise<string> {
  try {
    const stats = await stat(path)
    return `${path}\0${stats.mtimeMs}\0${stats.size}`
  } catch {
    return `${path}\0missing`
  }
}

/** Read once per enrichment pass; undefined when the files could not be read in time. */
export function readGlobalGitConfigStamp(): Promise<string | undefined> {
  return withConfigSignatureDeadline(readUnboundedGlobalGitConfigStamp())
}

async function readUnboundedGlobalGitConfigStamp(): Promise<string> {
  // Git for Windows prefers %HOME% over the profile directory; GIT_CONFIG_GLOBAL replaces both files.
  const home = process.env.HOME || homedir()
  const xdg = process.env.XDG_CONFIG_HOME || join(home, '.config')
  const globalPaths = process.env.GIT_CONFIG_GLOBAL
    ? [process.env.GIT_CONFIG_GLOBAL]
    : [join(home, '.gitconfig'), join(xdg, 'git', 'config')]
  // Why includes: user.name / github.user commonly live in an [include]d work config.
  const stamps = await Promise.all([
    ...globalPaths.map((path) => readConfigPathSignatures(path)),
    statStamp(ghHostsFilePath(home))
  ])
  return stamps.flat().join('\0')
}

function readHeadStamp(repoPath: string): Promise<string | undefined> {
  return withConfigSignatureDeadline(readUnboundedHeadStamp(repoPath))
}

async function readUnboundedHeadStamp(repoPath: string): Promise<string | undefined> {
  const configPaths = await resolveLocalGitConfigPaths(repoPath)
  if (!configPaths) {
    return undefined
  }
  try {
    return (await readFile(join(dirname(configPaths.worktreeConfigPath), 'HEAD'), 'utf8')).trim()
  } catch {
    return undefined
  }
}

/**
 * Everything the local username resolution reads from disk, as one string. Undefined when any
 * part cannot be read: the caller must then resolve rather than trust a missing signature.
 */
export async function readLocalGitUsernameSignature(
  repoPath: string,
  globalConfigStamp: string | undefined
): Promise<string | undefined> {
  const [config, head] = await Promise.all([
    readLocalGitConfigSignature({ repoPath, connectionId: null }),
    readHeadStamp(repoPath)
  ])
  if (config === undefined || head === undefined || globalConfigStamp === undefined) {
    return undefined
  }
  return `${config}\0${head}\0${globalConfigStamp}`
}
