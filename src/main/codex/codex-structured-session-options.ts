import type { AgentSessionOptionsResult } from '../../shared/agent-session-wire'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import type { CodexSession } from './codex-structured-session-state'
import { isCodexTurnOptionKey } from './codex-structured-turn-start'
import {
  AgentSessionOptionRejectedError,
  isAgentSessionOptionRejectedError
} from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import { decodeStructuredAgentSessionOptionValue } from '../../shared/structured-agent-session-option-codec'
import { normalizeCodexServiceTierOptions } from '../../shared/codex-service-tier-selection'
import {
  isCodexRefusedTierKey,
  normalizeCodexSpeedIntent,
  readCodexSpeedIntent
} from './codex-structured-speed-intent'
import {
  codexSpeedFacts,
  migrateCodexSessionSpeed,
  replaceCodexSessionOptions
} from './codex-structured-fast-mode'
import {
  composeCodexSessionOptionCatalog,
  fetchCodexModelCatalogListing,
  readCodexStructuredSessionOptionCatalog,
  type CodexModelCatalogListing,
  type CodexSessionOptionCatalog
} from './codex-structured-model-catalog'
import {
  codexAcquireCatalogListing,
  codexListingDefaultModel,
  codexSpeedCatalog,
  listingFromEntry
} from './codex-structured-catalog-entry'
export { codexAcquireCatalogListing } from './codex-structured-catalog-entry'

/** Recognized options of a saved record, including the private record of a refused speed pick.
 *  Legacy Fast resolves as far as no catalog allows: false is Standard, and an unresolved true
 *  stays as intent for the first catalog that can name its tier. */
export function restoredCodexSessionOptions(
  options: Readonly<Record<string, string>> | undefined
): Map<string, string> {
  const recognized = Object.fromEntries(
    Object.entries(options ?? {}).filter(([key, value]) => {
      return (
        (isCodexTurnOptionKey(key) || isCodexRefusedTierKey(key)) &&
        (key !== 'fastMode' ||
          typeof decodeStructuredAgentSessionOptionValue('fastMode', value) === 'boolean')
      )
    })
  )
  return new Map(
    Object.entries(
      normalizeCodexServiceTierOptions({
        priorOptions: recognized,
        changes: {},
        origin: 'restore',
        models: [],
        catalogKnown: false
      })
    )
  )
}

export type { CodexSessionOptionCatalog } from './codex-structured-model-catalog'

export { readCodexStructuredSessionOptionCatalog } from './codex-structured-model-catalog'

async function fetchCodexListingThroughStore(
  session: CodexSession,
  timeoutMs: number | undefined
): Promise<CodexModelCatalogListing> {
  const access = session.catalogAccess
  if (!access) {
    return fetchCodexModelCatalogListing({ connection: session.connection, timeoutMs })
  }
  const entry = await access.store.refresh(access.fingerprint, 'codex', access, async () => {
    const listing = await fetchCodexModelCatalogListing({
      connection: session.connection,
      timeoutMs
    })
    return {
      models: listing.models,
      fastModeTierByModel: listing.fastModeTierByModel,
      origin: 'live-session'
    }
  })
  if (!entry) {
    throw new Error(access.store.failureDetail(access.fingerprint) ?? 'codex model listing failed')
  }
  return listingFromEntry(entry)
}

/**
 * The listing a picker read answers with: any stored entry immediately, with a
 * background refresh once it ages out; a provider fetch only when this key has
 * never listed. The refresh rides the session's own connection and its bounded
 * request timeout, off the caller's path.
 */
export async function codexSessionCatalogListingForPicker(
  session: CodexSession,
  timeoutMs: number | undefined
): Promise<CodexModelCatalogListing> {
  const access = session.catalogAccess
  const entry = access?.store.get(access.fingerprint)
  if (access && entry) {
    if (access.store.shouldRefresh(access.fingerprint)) {
      void fetchCodexListingThroughStore(session, timeoutMs).catch(() => {})
    }
    return listingFromEntry(entry)
  }
  return fetchCodexListingThroughStore(session, timeoutMs)
}

export async function readCodexStructuredSessionOptions(input: {
  connection: Pick<CodexAppServerConnection, 'request'>
  current: { model?: string; effort?: string; fastMode?: boolean }
  reportedServiceTier?: string | null
  reportedServiceTierKnown?: boolean
  timeoutMs?: number
}): Promise<AgentSessionOptionsResult> {
  return (await readCodexStructuredSessionOptionCatalog(input)).result
}

// The stored speed is judged against the destination model of this very listing, so a legacy Fast
// resolves here once the listing can name it and an unresolved one is reported as such.
function applyLiveCodexCatalog(
  session: CodexSession,
  listing: CodexModelCatalogListing
): AgentSessionOptionsResult {
  const model = session.options.get('model') ?? session.reportedOptions.model
  const effort = session.options.get('effort') ?? session.reportedOptions.effort
  const currentModel = model ?? codexListingDefaultModel(listing.models)
  migrateCodexSessionSpeed(session, { models: listing.models, currentModel })
  const stored = readCodexSpeedIntent({
    options: Object.fromEntries(session.options),
    models: listing.models,
    ...(currentModel ? { currentModel } : {}),
    catalogKnown: true
  })
  const catalog: CodexSessionOptionCatalog = composeCodexSessionOptionCatalog(listing, {
    current: {
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...stored.current
    },
    ...(session.reportedOptions.serviceTierKnown
      ? {
          reportedServiceTier: session.reportedOptions.serviceTier ?? null,
          reportedServiceTierKnown: true
        }
      : {})
  })
  return { ...catalog.result, speed: codexSpeedFacts(stored.speed, session.speedEvidence) }
}

export async function readLiveCodexSessionOptions(
  session: CodexSession,
  timeoutMs: number | undefined
): Promise<AgentSessionOptionsResult> {
  const listing = await codexSessionCatalogListingForPicker(session, timeoutMs)
  return applyLiveCodexCatalog(session, listing)
}

/** Fetch outside the session lane; apply against current options inside it. */
export async function prepareLiveCodexSessionOptions(
  session: CodexSession,
  timeoutMs: number | undefined
): Promise<() => AgentSessionOptionsResult> {
  const listing = await codexSessionCatalogListingForPicker(session, timeoutMs)
  return () => applyLiveCodexCatalog(session, listing)
}

export async function applyCodexStructuredSessionOption(
  session: CodexSession,
  key: string,
  value: string
): Promise<Readonly<Record<string, string>>> {
  try {
    return applyValidatedCodexStructuredSessionOption(session, key, value)
  } catch (error) {
    if (isAgentSessionOptionRejectedError(error)) {
      // A refused speed pick is kept as this session's blocked intent; the host persists the same map.
      if (error.refusalOptions) {
        replaceCodexSessionOptions(session.options, error.refusalOptions)
      }
      throw error
    }
    throw new AgentSessionOptionRejectedError(error)
  }
}

/**
 * With no listing known, a pick is kept as the next turn's intent rather than refused: catalog
 * bookkeeping must not gate it. Codex judges the model on `turn/start`.
 */
function applyUnlistedCodexSessionOption(
  session: CodexSession,
  key: 'model' | 'effort',
  value: string
): Readonly<Record<string, string>> {
  if (
    key === 'model' &&
    value !== (session.options.get('model') ?? session.reportedOptions.model)
  ) {
    // An effort saved under another model is unverified for this one; its default applies.
    session.options.delete('effort')
  }
  session.options.set(key, value)
  return Object.fromEntries(session.options)
}

// A speed write is judged against the catalog this session's account holds. The same rules run for
// a chat at rest, so both paths accept and refuse the same writes: a legacy Fast toggle the catalog
// cannot resolve is stored as intent and blocks the next turn, never refused here.
function applyCodexSpeedOption(
  session: CodexSession,
  key: 'serviceTier' | 'fastMode',
  value: string
): Readonly<Record<string, string>> {
  const catalog = codexSpeedCatalog(session.catalogAccess)
  const currentModel = session.reportedOptions.model ?? codexListingDefaultModel(catalog.models)
  replaceCodexSessionOptions(
    session.options,
    normalizeCodexSpeedIntent({
      priorOptions: Object.fromEntries(session.options),
      changes: { [key]: value },
      origin: 'set-option',
      models: catalog.models,
      ...(currentModel ? { currentModel } : {}),
      catalogKnown: catalog.known
    })
  )
  return Object.fromEntries(session.options)
}

function applyListedCodexModelOrEffort(
  session: CodexSession,
  listing: CodexModelCatalogListing,
  key: 'model' | 'effort',
  value: string
): Readonly<Record<string, string>> {
  const priorModel = session.options.get('model') ?? session.reportedOptions.model
  const priorEffort = session.options.get('effort') ?? session.reportedOptions.effort
  const catalog = composeCodexSessionOptionCatalog(listing, {
    current: {
      ...(priorModel ? { model: priorModel } : {}),
      ...(priorEffort ? { effort: priorEffort } : {})
    }
  })
  if (key === 'model' && !catalog.result.models.some((entry) => entry.id === value)) {
    throw new Error(`codex app-server does not offer model ${value}`)
  }
  const modelId = key === 'model' ? value : catalog.result.current.model
  const model = catalog.result.models.find((entry) => entry.id === modelId)
  const requestedEffort = key === 'effort' ? value : priorEffort
  if (
    key === 'effort' &&
    (!model?.efforts.length || !model.efforts.some((effort) => effort.value === requestedEffort))
  ) {
    throw new Error(`codex app-server model ${modelId} does not support ${value}`)
  }
  const effort =
    model?.efforts.length === 0
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
  // The stored speed is kept for the new model, whether or not it offers it; only legacy Fast
  // intent that this model's tiers can now name is resolved.
  migrateCodexSessionSpeed(session, { models: catalog.result.models, currentModel: modelId })
  return Object.fromEntries(session.options)
}

function applyValidatedCodexStructuredSessionOption(
  session: CodexSession,
  key: string,
  value: string
): Readonly<Record<string, string>> {
  if (key === 'serviceTier' || key === 'fastMode') {
    return applyCodexSpeedOption(session, key, value)
  }
  if (key !== 'model' && key !== 'effort') {
    session.options.set(key, value)
    return Object.fromEntries(session.options)
  }
  const listing = codexAcquireCatalogListing(session.catalogAccess)
  return listing
    ? applyListedCodexModelOrEffort(session, listing, key, value)
    : applyUnlistedCodexSessionOption(session, key, value)
}
