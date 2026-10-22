import { readCodexSessionSpeed } from './codex-structured-speed-state'
import type { StructuredAgentSessionLiveOptions } from '../native-chat/agent-session-wire/structured-agent-session-option-models'
import { agentSessionEffortLevels } from '../../shared/agent-session-effort-levels'
import type { AgentSessionOptionsResult } from '../../shared/agent-session-wire'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import type { CodexSession } from './codex-structured-session-state'
import { isCodexTurnOptionKey } from './codex-structured-turn-start'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import { decodeStructuredAgentSessionOptionValue } from '../../shared/structured-agent-session-option-codec'
import {
  CODEX_DEFAULT_SERVICE_TIER,
  codexFastServiceTier,
  codexFastModeOfServiceTier,
  codexOffersServiceTier,
  setCodexServiceTier
} from './codex-structured-service-tier'
import {
  composeCodexSessionOptionCatalog,
  readCodexStructuredSessionOptionCatalog
} from './codex-structured-model-catalog'
import {
  codexAcquireCatalogListing,
  codexSessionCapabilities
} from './codex-structured-catalog-entry'
export { codexAcquireCatalogListing } from './codex-structured-catalog-entry'

/** Canonical overrides plus legacy Fast intent that must never be sent as a turn parameter. */
export function restoredCodexSessionOptions(
  options: Readonly<Record<string, string>> | undefined
): Map<string, string> {
  const restored = new Map(
    Object.entries(options ?? {}).filter(([key]) => isCodexTurnOptionKey(key))
  )
  if (!restored.has('serviceTier') && options?.fastMode === 'false') {
    restored.set('serviceTier', CODEX_DEFAULT_SERVICE_TIER)
  } else if (!restored.has('serviceTier') && options?.fastMode === 'true') {
    restored.set('fastMode', 'true')
  }
  return restored
}

/** Startup reports the thread's defaults together with the saved next-turn intent. */
export function reportedCodexSessionOptions(
  session: CodexSession
): AgentSessionOptionsResult['current'] {
  const model = session.options.get('model') ?? session.reportedOptions.model ?? ''
  const effort =
    session.options.get('effort') ??
    (model === session.reportedOptions.model ? session.reportedOptions.effort : undefined)
  // The saved tier, which the next turn sends as-is.
  const serviceTier = session.options.get('serviceTier')
  return {
    model,
    ...(effort ? { effort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    ...(serviceTier === undefined && session.options.get('fastMode') === 'true'
      ? { fastMode: true }
      : {})
  }
}

export type { CodexSessionOptionCatalog } from './codex-structured-model-catalog'

export { readCodexStructuredSessionOptionCatalog } from './codex-structured-model-catalog'

export async function readCodexStructuredSessionOptions(input: {
  connection: Pick<CodexAppServerConnection, 'request'>
  current: { model?: string; effort?: string; serviceTier?: string }
  reportedServiceTier?: string | null
  reportedServiceTierKnown?: boolean
  timeoutMs?: number
}): Promise<AgentSessionOptionsResult> {
  return readCodexStructuredSessionOptionCatalog(input)
}

function composeLiveCodexCatalog(
  session: CodexSession,
  listing: ReturnType<typeof codexSessionCapabilities>
): StructuredAgentSessionLiveOptions {
  const model = session.options.get('model') ?? session.reportedOptions.model
  const effort = session.options.get('effort') ?? session.reportedOptions.effort
  const serviceTier = session.options.get('serviceTier')
  const pendingFast = serviceTier === undefined && session.options.get('fastMode') === 'true'
  const catalog = composeCodexSessionOptionCatalog(listing, {
    current: {
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(serviceTier ? { serviceTier } : {})
    },
    ...(!pendingFast && session.reportedOptions.serviceTierKnown
      ? {
          reportedServiceTier: session.reportedOptions.serviceTier ?? null,
          reportedServiceTierKnown: true
        }
      : {})
  })
  const { fastMode: catalogFastMode, ...current } = catalog.current
  const fastMode =
    serviceTier !== undefined
      ? codexFastModeOfServiceTier(
          serviceTier,
          listing.models.find((entry) => entry.id === catalog.current.model)
        )
      : catalogFastMode
  return {
    ...catalog,
    fastModeSupport: listing.fastModeSupport,
    current: {
      ...current,
      ...(serviceTier !== undefined ? { serviceTier } : {}),
      ...(typeof fastMode === 'boolean' ? { fastMode } : {}),
      ...(pendingFast ? { fastMode: true } : {})
    },
    speed: readCodexSessionSpeed(session, listing)
  }
}

export async function readLiveCodexSessionOptions(
  session: CodexSession,
  timeoutMs: number | undefined
): Promise<StructuredAgentSessionLiveOptions> {
  return (await prepareLiveCodexSessionOptions(session, timeoutMs))()
}

/** Demand discovery outside the session lane; compose from its installed snapshot inside it. */
export async function prepareLiveCodexSessionOptions(
  session: CodexSession,
  _timeoutMs: number | undefined
): Promise<() => StructuredAgentSessionLiveOptions> {
  await session.catalogAccess?.demand?.()
  return () => composeLiveCodexCatalog(session, codexSessionCapabilities(session))
}

export async function applyCodexStructuredSessionOption(
  session: CodexSession,
  key: string,
  value: string
): Promise<Readonly<Record<string, string>>> {
  try {
    return applyValidatedCodexStructuredSessionOption(session, key, value)
  } catch (error) {
    throw new AgentSessionOptionRejectedError(error)
  }
}

/**
 * With no listing known, a pick is kept as the next turn's intent rather than refused: catalog
 * bookkeeping must not gate it. Codex judges the model and tier on `turn/start`.
 */
function applyUnlistedCodexSessionOption(
  session: CodexSession,
  key: 'model' | 'effort' | 'serviceTier',
  value: string
): Readonly<Record<string, string>> {
  if (
    key === 'model' &&
    value !== (session.options.get('model') ?? session.reportedOptions.model)
  ) {
    // An effort saved under another model is unverified for this one; its default applies.
    session.options.delete('effort')
  }
  if (key === 'serviceTier') {
    setCodexServiceTier(session.options, value)
  } else {
    session.options.set(key, value)
  }
  return Object.fromEntries(session.options)
}

function applyValidatedCodexStructuredSessionOption(
  session: CodexSession,
  requestedKey: string,
  requestedValue: string
): Readonly<Record<string, string>> {
  const verified = codexAcquireCatalogListing(session.catalogAccess, true)
  const capabilities = codexSessionCapabilities(session)
  const listing =
    requestedKey === 'model' ? verified : capabilities.models.length ? capabilities : null
  const priorModel = session.options.get('model') ?? session.reportedOptions.model
  const catalog = listing
    ? composeCodexSessionOptionCatalog(listing, {
        current: priorModel ? { model: priorModel } : {}
      })
    : null
  // An older client still sends its Fast toggle.
  const key = requestedKey === 'fastMode' ? 'serviceTier' : requestedKey
  const value =
    requestedKey === 'fastMode'
      ? codexServiceTierOfFastMode(
          requestedValue,
          catalog?.models.find((entry) => entry.id === catalog.current.model)
        )
      : requestedValue
  if (key !== 'model' && key !== 'effort' && key !== 'serviceTier') {
    session.options.set(key, value)
    return Object.fromEntries(session.options)
  }
  if (key === 'serviceTier' && value === CODEX_DEFAULT_SERVICE_TIER) {
    setCodexServiceTier(session.options, value)
    return Object.fromEntries(session.options)
  }
  if (!catalog) {
    return applyUnlistedCodexSessionOption(session, key, value)
  }
  if (key === 'model' && !catalog.models.some((entry) => entry.id === value)) {
    throw new Error(`codex app-server does not offer model ${value}`)
  }
  const modelId = key === 'model' ? value : catalog.current.model
  const model = catalog.models.find((entry) => entry.id === modelId)
  if (key === 'serviceTier') {
    if (
      !codexOffersServiceTier(
        session,
        model,
        catalog.models,
        value,
        capabilities.listedServiceTiers
      )
    ) {
      throw new Error(`codex app-server model ${modelId} does not offer the ${value} tier`)
    }
    setCodexServiceTier(session.options, value)
    return Object.fromEntries(session.options)
  }
  const priorEffort = session.options.get('effort') ?? session.reportedOptions.effort
  const requestedEffort = key === 'effort' ? value : priorEffort
  const levels = agentSessionEffortLevels(model)
  if (key === 'effort' && levels && !levels.has(value)) {
    throw new Error(`codex app-server model ${modelId} does not support ${value}`)
  }
  const effort =
    levels === null
      ? requestedEffort
      : levels.size === 0
        ? undefined
        : (model?.efforts.find((entry) => entry.value === requestedEffort)?.value ??
          model?.defaultEffort ??
          model?.efforts[0]?.value)
  session.options.set('model', modelId)
  if (effort) {
    session.options.set('effort', effort)
  } else {
    session.options.delete('effort')
  }
  return Object.fromEntries(session.options)
}

/** The tier an older client's Fast toggle asks for; unknown Fast support is refused. */
function codexServiceTierOfFastMode(
  encoded: string,
  model: Parameters<typeof codexFastServiceTier>[0]
): string {
  const fastMode = decodeStructuredAgentSessionOptionValue('fastMode', encoded)
  if (typeof fastMode !== 'boolean') {
    throw new Error('codex fast mode must be encoded as true or false')
  }
  const tier = fastMode ? codexFastServiceTier(model) : CODEX_DEFAULT_SERVICE_TIER
  if (!tier) {
    throw new Error('codex app-server does not support Fast mode for this model')
  }
  return tier
}
