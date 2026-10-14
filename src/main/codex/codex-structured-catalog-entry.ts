import type { AgentSessionModelOption } from '../../shared/agent-session-wire'
import { codexStandardTierId } from '../../shared/codex-service-tier-selection'
import type { AgentModelCatalogEntry } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { CodexSessionCatalogAccess } from './codex-structured-session-state'
import type { CodexModelCatalogListing } from './codex-structured-model-catalog'

// An entry saved before tier metadata existed names only the Fast id, so that one row keeps working;
// every other tier stays unadvertised until a listing says otherwise.
function withLegacyFastTier(
  model: AgentSessionModelOption,
  fastModeTierByModel: Readonly<Record<string, string>>
): AgentSessionModelOption {
  const fastTierId = Object.hasOwn(fastModeTierByModel, model.id)
    ? fastModeTierByModel[model.id]
    : undefined
  if (model.serviceTiers || !fastTierId) {
    return { ...model }
  }
  return {
    ...model,
    serviceTiers: [
      { value: codexStandardTierId(undefined), label: 'Standard' },
      { value: fastTierId, label: 'Fast' }
    ]
  }
}

export function listingFromEntry(entry: AgentModelCatalogEntry): CodexModelCatalogListing {
  return {
    models: entry.models.map((model) => withLegacyFastTier(model, entry.fastModeTierByModel)),
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
