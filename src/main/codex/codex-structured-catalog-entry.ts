import type { AgentSessionModelOption } from '../../shared/agent-session-wire'
import type { AgentModelCatalogEntry } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { CodexSessionCatalogAccess } from './codex-structured-session-state'
import type { CodexModelCatalogListing } from './codex-structured-model-catalog'

// Tier support is only what a row's own `serviceTiers` advertise. The legacy Fast map beside them is
// a projection, never a catalog: a row without tiers stays unknown, even when the map names an id.
export function listingFromEntry(entry: AgentModelCatalogEntry): CodexModelCatalogListing {
  return {
    models: entry.models.map((model) => ({ ...model })),
    fastModeTierByModel: new Map(Object.entries(entry.fastModeTierByModel))
  }
}

/** The model a session without a pick runs: the listing's default, else its first row. */
export function codexListingDefaultModel(
  models: readonly AgentSessionModelOption[]
): string | undefined {
  return models.find((entry) => entry.isDefault)?.id ?? models[0]?.id
}

/** The tiers this session's account catalog advertises, read from the store with no I/O. `known`
 *  is false until the account has a listing, so absence of tiers never reads as Standard-only. */
export function codexSpeedCatalog(catalogAccess: CodexSessionCatalogAccess | undefined): {
  models: AgentSessionModelOption[]
  known: boolean
} {
  const entry = catalogAccess?.store.get(catalogAccess.fingerprint)
  return entry
    ? { models: listingFromEntry(entry).models, known: true }
    : { models: [], known: false }
}

/** Acquisition uses known choices only; picker reads discover new choices later. */
export function codexAcquireCatalogListing(
  catalogAccess: CodexSessionCatalogAccess | undefined
): CodexModelCatalogListing | null {
  const entry = catalogAccess?.store.get(catalogAccess.fingerprint)
  return entry ? listingFromEntry(entry) : null
}
