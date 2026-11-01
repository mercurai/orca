import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'

const SIGNATURE_FILE_NAME = 'repo-git-username-signatures.json'

export type RepoUsernameSignature = { signature: string; username: string }
export type RepoUsernameSignatures = Map<string, RepoUsernameSignature>

function isSignatureEntry(value: unknown): value is RepoUsernameSignature {
  return (
    typeof value === 'object' &&
    value !== null &&
    'signature' in value &&
    typeof value.signature === 'string' &&
    'username' in value &&
    typeof value.username === 'string'
  )
}

// Why a sidecar file: the signature is a launch-to-launch cache of "nothing changed", not repo
// data, so it stays out of the repo record and the renderer-visible Repo shape.
function signatureFilePath(): string {
  return join(app.getPath('userData'), SIGNATURE_FILE_NAME)
}

export async function loadRepoUsernameSignatures(): Promise<RepoUsernameSignatures> {
  try {
    const parsed: unknown = JSON.parse(await readFile(signatureFilePath(), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return new Map()
    }
    return new Map(Object.entries(parsed).filter(([, value]) => isSignatureEntry(value)))
  } catch {
    // Missing or corrupt file: every repo resolves once and the file is rewritten.
    return new Map()
  }
}

export async function saveRepoUsernameSignatures(
  signatures: RepoUsernameSignatures
): Promise<void> {
  const path = signatureFilePath()
  const tempPath = `${path}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(tempPath, JSON.stringify(Object.fromEntries(signatures)), 'utf8')
    await rename(tempPath, path)
  } catch (error) {
    // Losing the cache only costs one re-resolution on the next launch.
    console.error('[repo-username] Failed to save signatures:', error)
  }
}
