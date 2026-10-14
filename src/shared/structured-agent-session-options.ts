import type {
  AgentSessionOptionCatalog,
  CatalogModel,
  CatalogOption
} from './agent-session-option-catalog'
import {
  buildNativeChatSessionOptionSnapshot,
  withTrackedNativeChatModel
} from './native-chat-session-option-snapshot'
import {
  applyNativeChatReportedSessionOptions,
  clearTrackedSessionOption,
  createNativeChatSessionOptionRecord,
  type NativeChatSessionOptionRecord
} from './native-chat-session-option-state'
import type { SessionOptionDescriptor, SessionOptionValue } from './native-chat-session-options'
import type {
  AgentSessionModelCatalogResult,
  AgentSessionOptionsResult
} from './agent-session-wire'
import type { AgentSessionSpeedFacts } from './agent-session-speed-facts'
import {
  CODEX_SERVICE_TIER_OPTION_ID,
  codexSpeedCatalogOptions,
  refreshCodexServiceTierCatalog,
  type CodexSpeedHostSupport
} from './codex-service-tier-presentation'
import {
  structuredAgentSessionRequestConfirmed,
  type StructuredAgentSessionRequestedSpeed
} from './structured-agent-session-option-acknowledgement'

function effortOption(model: AgentSessionOptionsResult['models'][number]): CatalogOption | null {
  if (model.efforts.length <= 1) {
    return null
  }
  return {
    id: 'effort',
    label: 'Reasoning effort',
    category: 'thought_level',
    kind: {
      type: 'select',
      choices: model.efforts,
      defaultValue: model.defaultEffort ?? model.efforts[0]!.value,
      ...(model.defaultEffort ? { defaultIsCliDefault: true as const } : {})
    },
    apply: { midSession: { kind: 'command', build: (value) => `/effort ${String(value)}` } }
  }
}

/** Who the catalog is for, stated by the caller from its session record. Speed tiers are Codex's
 *  alone: another agent keeps its own controls however much tier metadata a listing carries. */
export type StructuredAgentSessionCatalogContext = {
  agent: string
  /** The execution host's answer for the speed capability; absent leaves it to model metadata. */
  codexSpeedHost?: CodexSpeedHostSupport
}

const CODEX_CATALOG_CONTEXT: StructuredAgentSessionCatalogContext = { agent: 'codex' }

function discoveredModel(
  model: AgentSessionOptionsResult['models'][number],
  sessionSupportsFastMode: boolean,
  context: StructuredAgentSessionCatalogContext
): CatalogModel {
  const effort = effortOption(model)
  // A model with a speed select drops the boolean: the select carries Standard and Fast too.
  // Another agent never gets the select, however much tier metadata a listing carries.
  const host = context.agent === 'codex' ? context.codexSpeedHost : 'unsupported'
  return {
    id: model.id,
    label: model.label,
    ...(model.description ? { description: model.description } : {}),
    ...(model.isDefault ? { isDefault: true } : {}),
    options: [
      ...(effort ? [effort] : []),
      ...codexSpeedCatalogOptions(model, host, sessionSupportsFastMode)
    ]
  }
}

export function structuredAgentSessionOptionCatalog(
  seed: AgentSessionOptionCatalog,
  result: AgentSessionOptionsResult,
  context: StructuredAgentSessionCatalogContext = CODEX_CATALOG_CONTEXT
): AgentSessionOptionCatalog {
  const models: CatalogModel[] = result.models.map((model) =>
    discoveredModel(model, result.fastModeSupport?.supported === true, context)
  )
  if (result.current.model && !models.some((model) => model.id === result.current.model)) {
    models.push({
      id: result.current.model,
      label: result.current.model,
      options: seed.unknownModelOptions ?? []
    })
  }
  return { ...seed, models, defaultModelIsCliDefault: true }
}

export type StructuredAgentSessionOptionState = {
  catalog: AgentSessionOptionCatalog | null
  /** What produced `catalog`; a weaker source never replaces a stronger one. `seed` is the
   *  built-in list before the host answered (shown as the quiet placeholder); `builtin` is the
   *  same list once the host said it has none, usable but naming nothing the host may replace. */
  catalogSource: 'seed' | 'builtin' | 'host' | 'live' | null
  record: NativeChatSessionOptionRecord
  pendingId: string | null
  /** The host's speed facts from the last live read: absent from an older host, another agent,
   *  or before any read, which never means Standard. */
  speed?: AgentSessionSpeedFacts
  /** A speed this client asked for that no accepted answer has replaced: held apart from what the
   *  host stores, and keeping sends out until an explicit accepted replacement. */
  requested?: StructuredAgentSessionRequestedSpeed
}

/** With `seedCatalog`, the state holds the static seed from the first frame, but the picker shows
 *  the quiet placeholder until the host answers; every later source only upgrades it. */
export function createStructuredAgentSessionOptionState(
  agent = 'codex',
  seedCatalog?: AgentSessionOptionCatalog | null
): StructuredAgentSessionOptionState {
  return {
    catalog: seedCatalog ?? null,
    catalogSource: seedCatalog ? 'seed' : null,
    record: createNativeChatSessionOptionRecord(agent),
    pendingId: null
  }
}

/** The host answered with no list (none saved, a failed read, or an older host): the built-in
 *  list becomes usable, still naming nothing until a host or session list does. */
export function settleStructuredAgentSessionBuiltinCatalog(
  state: StructuredAgentSessionOptionState
): StructuredAgentSessionOptionState {
  return state.catalogSource === 'seed' ? { ...state, catalogSource: 'builtin' } : state
}

/**
 * Applies the host's stored model catalog: models only, no current selection
 * and no record writes, so nothing here reads as a committed value — the pick
 * stays provisional until a live options result confirms it. A live catalog
 * is never downgraded by this.
 */
export function applyStructuredAgentSessionModelCatalog(
  state: StructuredAgentSessionOptionState,
  seed: AgentSessionOptionCatalog,
  catalog: AgentSessionModelCatalogResult,
  options: { newLaunch: boolean; codexSpeedHost?: CodexSpeedHostSupport }
): StructuredAgentSessionOptionState {
  const context: StructuredAgentSessionCatalogContext = {
    agent: state.record.agent,
    ...(options.codexSpeedHost ? { codexSpeedHost: options.codexSpeedHost } : {})
  }
  if (state.catalogSource === 'live') {
    // The session's list outranks the host's, but a refreshed tier list must still reach it.
    const refreshed =
      state.catalog && catalog.origin !== 'unknown' && context.agent === 'codex'
        ? refreshCodexServiceTierCatalog(
            state.catalog,
            catalog.models,
            context.codexSpeedHost,
            catalog.fastModeSupport?.supported === true
          )
        : null
    return refreshed ? { ...state, catalog: refreshed } : state
  }
  const models =
    catalog.origin === 'unknown'
      ? []
      : catalog.models.map((model) =>
          discoveredModel(model, catalog.fastModeSupport?.supported === true, context)
        )
  if (catalog.origin === 'unknown' || models.length === 0) {
    return settleStructuredAgentSessionBuiltinCatalog(state)
  }
  // The host says whether its listed default is what this launch runs; an older host never says,
  // so the client's own knowledge of the agent stands in. A reopened chat may keep its own model.
  const namesDefault =
    options.newLaunch &&
    (catalog.listingNamesConfiguredModel ?? seed.hostListingNamesConfiguredModel === true)
  return {
    ...state,
    // `isDefault` came from a real listing, so a launch's CLI default is nameable —
    // as a provisional `default`-source value, never a confirmed one.
    catalog: {
      ...seed,
      models,
      ...(namesDefault ? { defaultModelIsCliDefault: true } : {})
    },
    catalogSource: 'host'
  }
}

export function applyStructuredAgentSessionOptions(
  state: StructuredAgentSessionOptionState,
  seed: AgentSessionOptionCatalog,
  result: AgentSessionOptionsResult,
  codexSpeedHost?: CodexSpeedHostSupport
): StructuredAgentSessionOptionState {
  const isCodex = state.record.agent === 'codex'
  if (result.current.fastMode === undefined) {
    clearTrackedSessionOption(state.record, result.current.model ?? null, 'fastMode')
  }
  // A read that names no tier does not erase one the user requested: revalidation keeps intent.
  applyNativeChatReportedSessionOptions(
    state.record,
    {
      ...(result.current.model ? { model: result.current.model } : {}),
      ...(result.current.effort ? { effort: result.current.effort } : {}),
      ...(result.current.fastMode !== undefined ? { fastMode: result.current.fastMode } : {}),
      ...(isCodex && result.current.serviceTier
        ? { [CODEX_SERVICE_TIER_OPTION_ID]: result.current.serviceTier }
        : {})
    },
    result.current.confirmed ?? []
  )
  const { speed: _previousSpeed, requested, ...rest } = state
  // The host's own read of exactly what was requested answers it; any other read leaves it held.
  const stillRequested =
    requested !== undefined &&
    !(state.pendingId === null && structuredAgentSessionRequestConfirmed(requested, result.current))
  return {
    ...rest,
    ...(stillRequested ? { requested } : {}),
    catalog: structuredAgentSessionOptionCatalog(seed, result, {
      agent: state.record.agent,
      ...(codexSpeedHost ? { codexSpeedHost } : {})
    }),
    catalogSource: 'live',
    ...(isCodex && result.speed ? { speed: result.speed } : {})
  }
}

/** Before the host answers, or an agent with no list reports, the quiet model pill: never
 *  pickable, so displaying it can never become a launch pick. */
const PROVIDER_DEFAULT_MODEL_PLACEHOLDER: SessionOptionDescriptor = {
  id: 'model',
  label: 'Model',
  category: 'model',
  kind: { type: 'select', choices: [] },
  valueSource: 'unknown',
  transport: 'agent-session',
  settable: false,
  disabledReason: 'available-after-session-start'
}

export function structuredAgentSessionOptionSnapshot(
  state: StructuredAgentSessionOptionState
): SessionOptionDescriptor[] {
  if (!state.catalog) {
    return []
  }
  // Until the host answers, the built-in list would paint a label its list may replace.
  if (state.catalogSource === 'seed') {
    return [PROVIDER_DEFAULT_MODEL_PLACEHOLDER]
  }
  const snapshot = buildNativeChatSessionOptionSnapshot({
    catalog: state.catalog,
    // A seeded default can name a model the static seed does not list yet.
    models: withTrackedNativeChatModel(state.catalog, state.catalog.models, state.record),
    record: state.record,
    mode: 'live',
    modelLabel: 'Model',
    liveTransport: 'agent-session'
  })
  return snapshot.length > 0 || state.catalogSource === 'live'
    ? snapshot
    : [PROVIDER_DEFAULT_MODEL_PLACEHOLDER]
}

/** No launch holds a pick and no fence can carry one yet, so the picker only shows. */
export function lockedStructuredAgentSessionOptionSnapshot(
  snapshot: readonly SessionOptionDescriptor[]
): SessionOptionDescriptor[] {
  return snapshot.map((descriptor) => ({
    ...descriptor,
    settable: false,
    disabledReason: 'available-after-session-start'
  }))
}

export function canSetStructuredAgentSessionOption(
  state: StructuredAgentSessionOptionState,
  id: string,
  value: SessionOptionValue
): boolean {
  const descriptor = structuredAgentSessionOptionSnapshot(state).find((entry) => entry.id === id)
  return Boolean(
    state.catalog &&
    state.pendingId === null &&
    ((typeof value === 'string' &&
      descriptor?.kind.type === 'select' &&
      // A disabled row is presentation of an unavailable choice, never one that may be sent.
      descriptor.kind.choices.some((choice) => choice.value === value && !choice.disabled)) ||
      (typeof value === 'boolean' && descriptor?.kind.type === 'boolean'))
  )
}

export {
  commitStructuredAgentSessionOption,
  commitStructuredAgentSessionOptionValues
} from './structured-agent-session-option-acknowledgement'
export {
  structuredAgentSessionOptionPicks,
  type StructuredSessionOptionPick
} from './structured-agent-session-option-picks'
