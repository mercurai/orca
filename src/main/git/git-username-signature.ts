import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  readLocalGitConfigSignature,
  resolveLocalGitConfigPaths
} from '../github/local-git-config-signature'

// Why: the repo-level config signature does not cover the user's global git config, which feeds
// github.user / user.username / user.name, nor HEAD, which picks the branch whose remote counts.
async function statStamp(path: string): Promise<string> {
  try {
    const stats = await stat(path)
    return `${path}\0${stats.mtimeMs}\0${stats.size}`
  } catch {
    return `${path}\0missing`
  }
}

/** Read once per enrichment pass: every repo shares the same global config files. */
export async function readGlobalGitConfigStamp(): Promise<string> {
  const home = homedir()
  const xdg = process.env.XDG_CONFIG_HOME || join(home, '.config')
  const stamps = await Promise.all([
    statStamp(join(home, '.gitconfig')),
    statStamp(join(xdg, 'git', 'config'))
  ])
  return stamps.join('\0')
}

async function readHeadStamp(repoPath: string): Promise<string | undefined> {
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
  globalConfigStamp: string
): Promise<string | undefined> {
  const [config, head] = await Promise.all([
    readLocalGitConfigSignature({ repoPath, connectionId: null }),
    readHeadStamp(repoPath)
  ])
  if (config === undefined || head === undefined) {
    return undefined
  }
  return `${config}\0${head}\0${globalConfigStamp}`
}
