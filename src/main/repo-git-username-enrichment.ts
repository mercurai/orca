import { getRepoExecutionHostId } from '../shared/execution-host'
import type { Repo } from '../shared/repo-types'
import { resolveLocalGitUsernameDetailed } from './git/git-username'
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
  // Why the repo and not its id: duplicate repo ids across execution hosts make an id-only write ambiguous.
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

// Why the execution host and not connectionId: a runtime repo has no connectionId, so a
// connectionId-only key collides with a local repo at the same path and blocks one of them for the session.
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
      // Why: SSH repo paths are remote; local git cannot inspect them. The
      // SSH username path (getSshGitUsername) stays caller-driven.
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
  const globalConfigStamp = candidates.length > 0 ? await readGlobalGitConfigStamp() : ''
  let changed = false
  for (const repo of candidates) {
    const location = getRepoLocationKey(repo)
    attemptedLocations.add(location)
    // Why before resolving: an edit that lands mid-resolution then differs from the stored
    // signature and re-resolves on the next launch instead of being masked.
    const signature = await readLocalGitUsernameSignature(repo.path, globalConfigStamp)
    if (signature !== undefined && signatures.get(location) === signature) {
      continue
    }
    const { username, authoritative } = await resolveLocalGitUsernameDetailed(repo.path)
    // Why: a non-authoritative '' means a probe timed out and says nothing
    // about the account — keep the persisted value. An authoritative result
    // (including '') is the current truth: it must also CLEAR a stale
    // persisted username after the user removes github.user or logs out.
    if (!authoritative && !username) {
      continue
    }
    // Why: a non-authoritative result (gh timed out) must retry next launch, so only an
    // authoritative one is remembered as "unchanged".
    if (authoritative && signature !== undefined && signatures.get(location) !== signature) {
      signatures.set(location, signature)
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

/**
 * Resolve git usernames for repos that haven't been probed this session, off
 * the caller's critical path. Fire-and-forget by design: repos:list must stay
 * subprocess-free (issue #7225 — a stuck sync probe froze startup for minutes).
 */
export function enrichRepoGitUsernames(
  store: RepoUsernameStore,
  options: EnrichmentOptions = {}
): void {
  if (enrichmentInFlight) {
    // Why: a repo added mid-pass would otherwise be dropped until some later
    // repos:list happens to fire — queue one follow-up pass instead.
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
