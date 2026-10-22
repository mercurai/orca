import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentModelCatalogEntry } from './agent-model-catalog-store'
import type { AgentModelCatalogService, AgentModelCatalogServiceDeps } from './agent-model-catalog-service-contract'
import { independentAgentModelCatalog } from './agent-model-catalog-discovery'
import { agentModelCatalogResultFromEntry } from './agent-model-catalog-entry'
import { workspaceKeepsListedDefault } from './agent-model-catalog-workspace'

export async function answerAgentModelCatalog(
  context: {
    deps: AgentModelCatalogServiceDeps
    params: Parameters<AgentModelCatalogService['read']>[0]
    scoped: AgentSessionRecord | undefined
    workspacePath: string | null | undefined
    accountHomePath: string | null
    fingerprint: string
    base: string
    exact: boolean
    folder: string | undefined
  },
  listed: AgentModelCatalogEntry | null,
  extra: { listingInProgress?: true } = {}
): Promise<AgentSessionModelCatalogResult> {
  const { deps, params, scoped, workspacePath, accountHomePath, fingerprint, base, exact, folder } = context
        const independent = independentAgentModelCatalog(params.agent)
        const accountFallback =
          independent && scoped && params.savedOnly &&
          params.workspacePath === null && !params.inSessionWorkspace
        const initialDisplay = listed ?? (exact && !params.verifiedOnly ? deps.store.get(base) : null)
        const resolveDefault = initialDisplay !== null &&
          !(independent && !params.legacyOptionsDisplay &&
            (!deps.store.verified(initialDisplay) || (!exact && !params.legacy))) &&
          !(exact && listed !== null && deps.store.verified(listed))
        const keepsListedDefault = resolveDefault
          ? await workspaceKeepsListedDefault(
              deps, params.agent, accountFallback ? undefined : workspacePath, accountHomePath
            )
          : false
        // Resolve rows and proof from the same snapshot after workspace resolution yields.
        listed = deps.store.get(fingerprint)
        if (params.verifiedOnly && (!listed ||
          (independent && (!exact || !deps.store.verified(listed))))) {
          return { origin: 'unknown', catalogState: 'unknown' }
        }
        const display = listed ?? (exact && !params.verifiedOnly ? deps.store.get(base) : null)
        const verified = exact && listed !== null && deps.store.verified(listed)
        const result = display
          ? agentModelCatalogResultFromEntry(
              display,
              independent && !params.legacyOptionsDisplay &&
                (!deps.store.verified(display) || (!exact && !params.legacy))
                ? false : verified ? true : keepsListedDefault,
              deps.listingNamesConfiguredModel?.has(params.agent) === true,
              !independent || verified
            )
          : null
        const holdsEverywhere =
          result?.listingNamesConfiguredModel === true &&
          deps.agentReadsProjectModelConfig?.(params.agent) === false
        // Read after workspace resolution: a failure or refresh may have landed during its await.
        const unavailable = deps.store.failure(fingerprint)?.unavailable
        const available =
          listed !== null &&
          (!independent || deps.store.verified(listed)) &&
          !deps.store.isStale(listed, 'latest') &&
          !deps.store.hasActiveFailure(fingerprint) &&
          unavailable === undefined
        const catalogState = available
          ? 'available'
          : deps.store.isListing(fingerprint)
            ? 'loading'
            : 'unknown'
        return {
          ...(result ?? { origin: 'unknown' }),
          catalogState,
          ...extra,
          ...(holdsEverywhere ? { defaultHoldsInEveryWorkspace: true as const } : {}),
          ...(result && (folder !== undefined || exact)
            ? { modelsDifferByWorkspace: true as const }
            : {}),
          ...(!params.savedOnly &&
          !params.verifiedOnly &&
          deps.store.isListing(fingerprint) &&
          (independent || !listed)
            ? { listingInProgress: true as const }
            : {}),
          ...(deps.store.failure(fingerprint)?.unavailable
            ? { unavailable: deps.store.failure(fingerprint)?.unavailable }
            : {})
        }
}
