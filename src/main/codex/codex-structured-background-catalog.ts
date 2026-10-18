import { AgentModelCatalogListingStoppedError } from '../native-chat/agent-model-catalog/agent-model-catalog-failures'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { fetchCodexModelCatalogListing } from './codex-structured-model-catalog'
import type { CodexSession } from './codex-structured-session-state'

type BackgroundCatalogInput = {
  session: CodexSession
  sessionId: string
  sessions: ReadonlyMap<string, CodexSession>
  timeoutMs: number | undefined
  logger: StructuredAgentSessionLogger | undefined
}

async function refresh(input: BackgroundCatalogInput): Promise<void> {
  const { session, sessionId, sessions } = input
  const access = session.catalogAccess
  const store = access?.store
  const fingerprint = access?.fingerprint
  const prior = fingerprint ? store?.get(fingerprint) : undefined
  if (
    fingerprint &&
    store &&
    (store.hasActiveFailure(fingerprint) || (prior && !store.isStale(prior)))
  ) {
    return
  }
  const isCurrent = (): boolean => sessions.get(sessionId) === session && !session.ended
  session.catalogListingInProgress = true
  try {
    const listModels = async () => {
      try {
        const listing = await fetchCodexModelCatalogListing({
          connection: session.connection,
          timeoutMs: input.timeoutMs,
          deadlineMs: Math.min(input.timeoutMs ?? 30_000, 30_000)
        })
        if (!isCurrent()) {
          throw new AgentModelCatalogListingStoppedError()
        }
        if (listing.models.length === 0) {
          throw new Error('codex app-server returned no available models')
        }
        return { models: listing.models, origin: 'live-session' as const }
      } catch (error) {
        if (!isCurrent()) {
          throw new AgentModelCatalogListingStoppedError()
        }
        throw error
      }
    }
    if (access) {
      // Joining the store also fences a cold-cache listing across account changes.
      await access.store.refresh(access.fingerprint, 'codex', access, listModels)
    } else {
      await listModels()
    }
  } catch (error) {
    if (!isCurrent()) {
      return
    }
    input.logger?.warn('Codex model catalog refresh failed', {
      scope: 'codex-background-catalog',
      sessionId,
      error
    })
  } finally {
    session.catalogListingInProgress = false
  }
}

/** Catalog work begins after ownership and never joins a chat action. */
export function startBackgroundCodexCatalogRefresh(input: BackgroundCatalogInput): void {
  void refresh(input).catch((error: unknown) => {
    try {
      input.logger?.warn('Codex model catalog refresh failed', {
        scope: 'codex-background-catalog',
        sessionId: input.sessionId,
        error
      })
    } catch {
      // Reporting must never reject an unawaited task.
    }
  })
}
