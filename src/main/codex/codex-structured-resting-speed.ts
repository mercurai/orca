import type { AgentSessionSpeed } from '../../shared/agent-session-speed'
import type { AgentSessionModelCatalogResult } from '../../shared/agent-session-wire'
import { CODEX_DEFAULT_SERVICE_TIER, codexFastServiceTier } from './codex-structured-service-tier'

/** A new explicit pick supersedes the other representation; bulk reads prefer canonical intent. */
export function normalizeCodexRestingOptionPick(
  saved: Readonly<Record<string, string>>,
  pick: { key: string; value: string }
): Readonly<Record<string, string>> | null {
  if (pick.key === 'serviceTier' || (pick.key === 'fastMode' && pick.value === 'false')) {
    const tierId = pick.key === 'fastMode' ? CODEX_DEFAULT_SERVICE_TIER : pick.value
    if (!tierId.trim()) {
      return null
    }
    const { fastMode: _legacy, ...retained } = saved
    return { ...retained, serviceTier: tierId }
  }
  if (pick.key === 'fastMode') {
    if (pick.value !== 'true') {
      return null
    }
    const { serviceTier: _canonical, ...retained } = saved
    return { ...retained, fastMode: 'true' }
  }
  return { ...saved, [pick.key]: pick.value }
}

/** At rest, only a fresh catalog for this execution account and selected model proves support. */
export function readCodexRestingSpeed(input: {
  saved: Readonly<Record<string, string>>
  currentModel?: string
  catalog: AgentSessionModelCatalogResult
}): AgentSessionSpeed {
  const { saved, catalog } = input
  const canonical = saved.serviceTier
  const legacyFast = canonical === undefined && saved.fastMode === 'true'
  let tierId = canonical ?? (saved.fastMode === 'false' ? CODEX_DEFAULT_SERVICE_TIER : undefined)
  let support: AgentSessionSpeed['support'] = catalog.catalogState === 'loading' ||
    catalog.listingInProgress ? 'loading' : 'unknown'
  if (catalog.catalogState === 'available' && catalog.origin !== 'unknown' &&
    !catalog.unavailable) {
    const modelId = saved.model ?? input.currentModel
    const model = catalog.models.find((row) => row.id === modelId)
    if (model?.serviceTiers !== undefined) {
      if (legacyFast) {
        tierId = codexFastServiceTier(model)
      }
      const available = legacyFast && tierId === undefined ? false :
        tierId === undefined || tierId === CODEX_DEFAULT_SERVICE_TIER ||
        model.serviceTiers.some((tier) => tier.value === tierId)
      support = available ? 'available' : 'unavailable'
    }
  }
  const requested = tierId !== undefined ? { tierId } :
    legacyFast ? { legacyFast: true as const } : undefined
  return {
    ...(requested ? { requested } : {}),
    support,
    processing: { status: 'unknown' }
  }
}
