import { getRepoExecutionHostId } from '../shared/execution-host'
import type { Repo } from '../shared/repo-types'
import { resolveLocalGitUsernameDetailed } from './git/git-username'
import { blockedWslDistroForPath, wslDistroForPath } from './wsl/wsl-unc-access-gate'
import {
  readGlobalGitConfigStamp,
  readLocalGitUsernameSignature
} from './git/git-username-signature'
import {
  loadRepoUsernameSignatures,
  saveRepoUsernameSignatures
} from './repo-git-username-signature-store'

type RepoUsernameStore = {
  getRepos(): Repo[]
  // Repo ids can repeat across hosts.
  setResolvedRepoGitUsername(
    target: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>,
    username: string
  ): boolean
}

type EnrichmentOptions = {
  onChanged?: () => void
}

// Why: resolution spawns git (and possibly gh) subprocesses, so run it at most
// once per repo location per app session — hydrateRepo serves the persisted
// value in between. A relaunch re-resolves only repos whose config signature changed.
const attemptedLocations = new Set<string>()
let enrichmentInFlight: Promise<void> | null = null
let rerunRequested = false

function getRepoLocationKey(repo: Pick<Repo, 'path' | 'connectionId' | 'executionHostId'>): string {
  return `${getRepoExecutionHostId(repo)}\0${repo.path}`
}

async function enrichRepoGitUsernamesInBackground(
  store: RepoUsernameStore,
  options: EnrichmentOptions
): Promise<void> {
  const repos = store.getRepos()
  const liveLocations = new Set(
    repos.filter((repo) => repo.kind !== 'folder' && !repo.connectionId).map(getRepoLocationKey)
  )
  for (const location of attemptedLocations) {
    if (!liveLocations.has(location)) {
      attemptedLocations.delete(location)
    }
  }
  const candidates = repos.filter(
    (repo) =>
      repo.kind !== 'folder' &&
      !repo.connectionId &&
      !attemptedLocations.has(getRepoLocationKey(repo))
  )
  const signatures = await loadRepoUsernameSignatures()
  let signaturesChanged = false
  for (const location of signatures.keys()) {
    if (!liveLocations.has(location)) {
      signatures.delete(location)
      signaturesChanged = true
    }
  }
  const globalConfigStamp = candidates.length > 0 ? await readGlobalGitConfigStamp() : undefined
  let changed = false
  for (const repo of candidates) {
    // Leave stopped distros unattempted and untouched, including signature reads.
    if (wslDistroForPath(repo.path) && (await blockedWslDistroForPath(repo.path))) {
      continue
    }
    const location = getRepoLocationKey(repo)
    attemptedLocations.add(location)
    // Why before resolving: an edit that lands mid-resolution then differs from the stored
    // signature and re-resolves on the next launch instead of being masked.
    const signature = await readLocalGitUsernameSignature(repo.path, globalConfigStamp)
    const remembered = signatures.get(location)
    if (signature !== undefined && remembered?.signature === signature) {
      // Why apply it: a re-added repo has a fresh record without the username, and the record save
      // is debounced, so the sidecar copy is what survives a kill between the two writes.
      if (store.setResolvedRepoGitUsername(repo, remembered.username)) {
        changed = true
      }
      continue
    }
    const { username, authoritative } = await resolveLocalGitUsernameDetailed(repo.path)
    // Preserve cached usernames on failure; authoritative empty results clear stale accounts.
    if (!authoritative && !username) {
      continue
    }
    // Why: a non-authoritative result (gh timed out) must retry next launch, so only an
    // authoritative one is remembered as "unchanged".
    if (authoritative && signature !== undefined) {
      signatures.set(location, { signature, username })
      signaturesChanged = true
    }
    if (store.setResolvedRepoGitUsername(repo, username)) {
      changed = true
    }
  }
  if (signaturesChanged) {
    await saveRepoUsernameSignatures(signatures)
  }
  if (changed) {
    options.onChanged?.()
  }
}

// Keep repo-list calls subprocess-free to avoid blocking startup.
export function enrichRepoGitUsernames(
  store: RepoUsernameStore,
  options: EnrichmentOptions = {}
): void {
  if (enrichmentInFlight) {
    // Pick up repos added while the current pass was probing.
    rerunRequested = true
    return
  }
  enrichmentInFlight = enrichRepoGitUsernamesInBackground(store, options)
    .catch((error: unknown) => {
      console.error('[repo-username] Failed to enrich git usernames:', error)
    })
    .finally(() => {
      enrichmentInFlight = null
      if (rerunRequested) {
        rerunRequested = false
        enrichRepoGitUsernames(store, options)
      }
    })
}

export async function flushRepoGitUsernameEnrichmentForTests(): Promise<void> {
  // A queued rerun replaces enrichmentInFlight when the first pass settles.
  while (enrichmentInFlight) {
    await enrichmentInFlight
  }
}

export function resetRepoGitUsernameEnrichmentForTests(): void {
  attemptedLocations.clear()
  enrichmentInFlight = null
  rerunRequested = false
}
