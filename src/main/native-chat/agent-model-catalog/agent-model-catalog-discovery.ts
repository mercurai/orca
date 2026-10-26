import { AGENT_MODEL_CATALOG_FRESH_MS } from '../../../shared/agent-model-catalog-freshness'
import { independentAgentModelCatalog } from '../../../shared/agent-model-catalog-ownership'
import type { AgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import type { AgentModelCatalogSuccess, AgentModelCatalogEntry } from './agent-model-catalog-entry'

export type AgentModelCatalogResolvedProbe = {
  identity: unknown
  run: (signal?: AbortSignal) => Promise<AgentModelCatalogSuccess>
}

/** Recover reruns shell lookup after a miss; snapshot and saved never do. */
export type AgentModelCatalogLookup = 'saved' | 'snapshot' | 'recover'

export type AgentModelCatalogProbe = ((
  accountHome: AgentSessionAccountHome,
  options?: { signal?: AbortSignal; workspacePath?: string; cwd?: string }
) => Promise<AgentModelCatalogSuccess>) & {
  resolveLegacy?: (home: AgentSessionAccountHome) => Promise<AgentModelCatalogResolvedProbe>
  resolve?: (
    home: AgentSessionAccountHome,
    cwd: string,
    lookup?: AgentModelCatalogLookup
  ) => Promise<AgentModelCatalogResolvedProbe>
}

export { independentAgentModelCatalog } from '../../../shared/agent-model-catalog-ownership'

/** Agents supply probes or opt out; the service owns caching, refresh and publication. */
export type AgentModelCatalogDiscovery =
  | {
      kind: 'probe'
      probe: AgentModelCatalogProbe
      /** True only when listing defaults match the account's actual configured model. */
      listingNamesConfiguredModel: boolean
      /** Project-dependent catalogs require a chat folder and cannot be prewarmed. */
      listsInChatFolder?: true
    }
  | { kind: 'unavailable'; reason: string }

export function isAgentModelCatalogStale(
  entry: AgentModelCatalogEntry,
  source: 'discovery' | 'latest',
  due: boolean,
  now: () => number
): boolean {
  const at = source === 'latest' ? entry.fetchedAt : entry.discovered?.at
  return (
    due ||
    at === undefined ||
    (source === 'discovery' &&
      independentAgentModelCatalog(entry.agent) &&
      entry.discovered?.complete !== true) ||
    now() - at >=
      (independentAgentModelCatalog(entry.agent) ? 2 * 60_000 : AGENT_MODEL_CATALOG_FRESH_MS)
  )
}
