import type { AgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import type { AgentModelCatalogEntry, AgentModelCatalogSuccess } from './agent-model-catalog-entry'
import type { AgentModelCatalogStore } from './agent-model-catalog-store'

/** Lists an agent's models before a chat, under the account a launch would pin. `signal` stops
 *  the listing and its child once the host that asked is going away; `workspacePath` is the folder
 *  of the chat that asked, where a listing that opens a session runs. */
export type AgentModelCatalogProbe = (
  accountHome: AgentSessionAccountHome,
  options?: { signal?: AbortSignal; workspacePath?: string }
) => Promise<AgentModelCatalogSuccess>

/** Who lists, by identity: a live session's per-spawn handle, or the session-less probe. */
export type AgentModelCatalogLister = AgentModelCatalogSessionAccess | AgentModelCatalogProbe

/** A live session's handle into the store, pinned at spawn to the account home
 *  THAT child launched under — an account switched afterwards must never
 *  receive or poison this session's listing. */
export type AgentModelCatalogSessionAccess = {
  store: AgentModelCatalogStore
  fingerprint: string
  accountHomePath: string
}


export type {
  AgentModelCatalogEntry,
  AgentModelCatalogListing,
  AgentModelCatalogLiveListing,
  AgentModelCatalogSource,
  AgentModelCatalogSuccess
} from './agent-model-catalog-entry'

export type AgentModelCatalogInFlightListings = {
  agent: string
  listings: Map<AgentModelCatalogLister, Promise<AgentModelCatalogEntry | null>>
}
