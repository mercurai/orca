import type { AgentModelCatalogEntry } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { CodexSession, CodexSessionCatalogAccess } from './codex-structured-session-state'
import type { CodexModelCatalogListing } from './codex-structured-model-catalog'

export function listingFromEntry(entry: AgentModelCatalogEntry): CodexModelCatalogListing {
  return {
    models: entry.models.map((model) => ({ ...model }))
  }
}

/** Acquisition uses known choices only; picker reads discover new choices later. */
export function codexAcquireCatalogListing(
  catalogAccess: CodexSessionCatalogAccess | undefined
): CodexModelCatalogListing | null {
  const entry = catalogAccess?.store.get(catalogAccess.fingerprint)
  return entry ? listingFromEntry(entry) : null
}

/** Initial picker reads expose uncertainty while discovery stays off the chat action path. */
export function initialCodexSessionPickerListing(
  session: CodexSession,
  refresh: () => Promise<CodexModelCatalogListing>
): CodexModelCatalogListing | null {
  const access = session.catalogAccess
  if (!access) {
    return null
  }
  if (
    !session.ended &&
    !session.catalogListingInProgress &&
    !access.store.hasActiveFailure(access.fingerprint)
  ) {
    void refresh().catch(() => {})
  }
  const model = session.options.get('model') ?? session.reportedOptions.model
  return {
    models: model ? [{ id: model, label: model, isDefault: false, efforts: [] }] : []
  }
}
