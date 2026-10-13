// Pure Codex speed rules shared by the live provider, at-rest hosts and presentation: parsing a
// model's advertised request tiers, migrating the legacy fastMode boolean, and admitting a selection.
// Option maps hold bounded encoded strings; `serviceTier` is canonical and outranks `fastMode`.

import { isAgentSessionOptions } from './agent-session-record'
import type { AgentSessionModelOption, AgentSessionOptionChoice } from './agent-session-wire'
import type {
  AgentSessionSpeedFacts,
  AgentSessionSpeedSelectionState
} from './agent-session-speed-facts'
import { decodeStructuredAgentSessionOptionValue } from './structured-agent-session-option-codec'
import type {
  RestingOptionsNormalizeInput,
  RestingOptionsReadInput,
  RestingOptionsReadResult
} from './structured-agent-session-resting-options'

export type * from './structured-agent-session-resting-options'

/** The protocol's own Standard request id, admitted even when a model's metadata is unknown. */
const PROTOCOL_STANDARD_TIER_ID = 'default'
const FAST_TIER_NAME = 'fast'
const MAX_DIAGNOSTIC_ID_LENGTH = 80

// ─── Catalog parsing ────────────────────────────────────────────────────────

/** The fields of one provider tier row that Orca reads; every field is untrusted until narrowed. */
type ProviderTierRow = { id?: unknown; name?: unknown; description?: unknown }

function isProviderTierRow(value: unknown): value is ProviderTierRow {
  return typeof value === 'object' && value !== null
}

function exactText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

// A tier id is stored as a durable option value, so it must fit the record's option bounds.
// The singleton check reuses that guard; an id that fails is unusable, never truncated.
function storableTierId(value: unknown): string | undefined {
  const text = exactText(value)
  return text !== undefined && isAgentSessionOptions({ serviceTier: text }) ? text : undefined
}


function firstArray(...candidates: unknown[]): unknown[] | undefined {
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate
    }
  }
  return undefined
}

function modernTierChoice(entry: unknown): AgentSessionOptionChoice | undefined {
  if (!isProviderTierRow(entry)) {
    return undefined
  }
  const value = storableTierId(entry.id)
  if (!value) {
    return undefined
  }
  const description = exactText(entry.description)
  return {
    value,
    label: exactText(entry.name) ?? value,
    ...(description ? { description } : {})
  }
}

// Legacy rows are bare request strings; the label stays the advertised value, never an alias.
function legacyTierChoice(entry: unknown): AgentSessionOptionChoice | undefined {
  const value = storableTierId(entry)
  return value ? { value, label: value } : undefined
}

function isProtocolStandardChoice(choice: AgentSessionOptionChoice): boolean {
  return choice.value === PROTOCOL_STANDARD_TIER_ID
}

function isStandardChoice(choice: AgentSessionOptionChoice): boolean {
  return isProtocolStandardChoice(choice) || choice.label.trim().toLowerCase() === 'standard'
}

function tiersFromRows(
  rows: readonly unknown[],
  toChoice: (entry: unknown) => AgentSessionOptionChoice | undefined,
  isStandard: (choice: AgentSessionOptionChoice) => boolean
): AgentSessionOptionChoice[] | undefined {
  const seen = new Set<string>()
  const choices: AgentSessionOptionChoice[] = []
  for (const row of rows) {
    const choice = toChoice(row)
    if (choice && !seen.has(choice.value)) {
      seen.add(choice.value)
      choices.push(choice)
    }
  }
  // Rows that name no usable tier say nothing about support, unlike an explicit empty list.
  if (rows.length > 0 && choices.length === 0) {
    return undefined
  }
  return choices.some(isStandard)
    ? choices
    : [{ value: PROTOCOL_STANDARD_TIER_ID, label: 'Standard' }, ...choices]
}

/** A model row's advertised request tiers, Standard included. Modern `serviceTiers`/`service_tiers`
 *  (even empty) outrank legacy `additionalSpeedTiers`/`additional_speed_tiers`. Undefined means
 *  the row states nothing usable, so support is unknown rather than Standard-only. */
export function parseCodexModelServiceTiers(
  row: Record<string, unknown>
): AgentSessionOptionChoice[] | undefined {
  const modern = firstArray(row.serviceTiers, row.service_tiers)
  if (modern) {
    return tiersFromRows(modern, modernTierChoice, isStandardChoice)
  }
  const legacy = firstArray(row.additionalSpeedTiers, row.additional_speed_tiers)
  return legacy ? tiersFromRows(legacy, legacyTierChoice, isProtocolStandardChoice) : undefined
}

/** The request id Standard uses: the provider's advertised one, else the protocol default. */
export function codexStandardTierId(
  tiers: readonly AgentSessionOptionChoice[] | undefined
): string {
  return (
    tiers?.find((tier) => isStandardChoice(tier) && storableTierId(tier.value))?.value ??
    PROTOCOL_STANDARD_TIER_ID
  )
}

/** The advertised id behind the legacy Fast toggle; Ultrafast and custom tiers never qualify. */
export function codexFastTierId(
  tiers: readonly AgentSessionOptionChoice[] | undefined
): string | undefined {
  return tiers?.find(
    (tier) =>
      !isStandardChoice(tier) &&
      storableTierId(tier.value) !== undefined &&
      (tier.label.trim().toLowerCase() === FAST_TIER_NAME ||
        tier.value.toLowerCase() === FAST_TIER_NAME)
  )?.value
}

// ─── Support and admission ──────────────────────────────────────────────────

export type CodexServiceTierSupport =
  | { known: true; tiers: readonly AgentSessionOptionChoice[] }
  | { known: false }

export type CodexServiceTierState = Exclude<AgentSessionSpeedSelectionState, 'unselected'>

/** Support is known only for a listed model, in a catalog the host actually loaded, that
 *  carries tier metadata. */
export function codexServiceTierSupport(input: {
  models: readonly AgentSessionModelOption[]
  modelId: string | undefined
  catalogKnown: boolean
}): CodexServiceTierSupport {
  const tiers = input.catalogKnown
    ? input.models.find((model) => model.id === input.modelId)?.serviceTiers
    : undefined
  return tiers ? { known: true, tiers } : { known: false }
}

/** Whether one exact id may be requested: protocol Standard always, anything else only when advertised. */
export function codexServiceTierState(
  tierId: string,
  support: CodexServiceTierSupport
): CodexServiceTierState {
  if (tierId === PROTOCOL_STANDARD_TIER_ID) {
    return 'ready'
  }
  if (!support.known) {
    return 'unknown'
  }
  return storableTierId(tierId) !== undefined && support.tiers.some((tier) => tier.value === tierId)
    ? 'ready'
    : 'unavailable'
}

export type CodexServiceTierRejectionReason = 'invalid' | 'unknown' | 'unavailable'

type RejectedSelection = { tierId?: string | undefined; legacyFastMode?: boolean | undefined }

const REJECTION_DETAIL: Record<CodexServiceTierRejectionReason, string> = {
  invalid: 'is not a valid selection',
  unknown: "cannot be verified against this model's catalog",
  unavailable: 'is not offered for this model'
}

function rejectionMessage(
  reason: CodexServiceTierRejectionReason,
  selection: RejectedSelection
): string {
  const subject = selection.tierId
    ? `service tier ${JSON.stringify(selection.tierId.slice(0, MAX_DIAGNOSTIC_ID_LENGTH))}`
    : selection.legacyFastMode
      ? 'Fast mode'
      : 'service tier'
  return `Codex ${subject} ${REJECTION_DETAIL[reason]}.`
}

/** An explicit write or turn admission the catalog cannot back. Callers translate it into
 *  their own wire refusal; nothing here is retried at another tier. */
export class CodexServiceTierSelectionError extends Error {
  readonly reason: CodexServiceTierRejectionReason
  readonly tierId: string | undefined
  readonly legacyFastMode: boolean

  constructor(reason: CodexServiceTierRejectionReason, selection: RejectedSelection) {
    super(rejectionMessage(reason, selection))
    this.name = 'CodexServiceTierSelectionError'
    this.reason = reason
    this.tierId = selection.tierId
    this.legacyFastMode = selection.legacyFastMode === true
  }
}

// ─── Option normalization ───────────────────────────────────────────────────

function advertisedTiers(
  support: CodexServiceTierSupport
): readonly AgentSessionOptionChoice[] | undefined {
  return support.known ? support.tiers : undefined
}

function canonicalTier(options: ReadonlyMap<string, string>): string | undefined {
  return exactText(options.get('serviceTier'))
}

function decodedFastMode(options: ReadonlyMap<string, string>): boolean | undefined {
  const encoded = options.get('fastMode')
  const decoded =
    encoded === undefined ? null : decodeStructuredAgentSessionOptionValue('fastMode', encoded)
  return typeof decoded === 'boolean' ? decoded : undefined
}

// A canonical tier beats any legacy boolean. Otherwise false becomes Standard and true becomes the
// advertised Fast id; an unresolvable true stays as intent rather than becoming false or Standard.
function migrateLegacyFastMode(
  options: Map<string, string>,
  support: CodexServiceTierSupport
): void {
  if (canonicalTier(options)) {
    options.delete('fastMode')
    return
  }
  options.delete('serviceTier')
  const fastMode = decodedFastMode(options)
  const tiers = advertisedTiers(support)
  const resolved =
    fastMode === false
      ? codexStandardTierId(tiers)
      : fastMode === true
        ? codexFastTierId(tiers)
        : undefined
  if (resolved !== undefined) {
    options.set('serviceTier', resolved)
  }
  if (resolved !== undefined || fastMode === undefined) {
    options.delete('fastMode')
  }
}

function admitExplicitTier(tierId: string, support: CodexServiceTierSupport): void {
  if (storableTierId(tierId) === undefined) {
    throw new CodexServiceTierSelectionError('invalid', {})
  }
  const state = codexServiceTierState(tierId, support)
  if (state !== 'ready') {
    throw new CodexServiceTierSelectionError(state, { tierId })
  }
}

// An explicit old-client toggle replaces the canonical tier, so a malformed one is refused before
// anything is deleted: dropping it would leave no tier and let the provider default apply.
function rejectMalformedFastModeToggle(fastMode: string): void {
  if (typeof decodeStructuredAgentSessionOptionValue('fastMode', fastMode) !== 'boolean') {
    throw new CodexServiceTierSelectionError('invalid', { legacyFastMode: true })
  }
}

/** The complete option map after a restore, launch seed or option write. Restore and launch keep
 *  unadvertised ids and unresolved Fast intent without throwing; only an explicit `set-option`
 *  serviceTier the catalog cannot back, or a malformed fastMode toggle, throws. A model or effort
 *  change keeps the existing selection even when the destination lacks it, and a valid explicit
 *  fastMode toggle replaces it. */
export function normalizeCodexServiceTierOptions(
  input: RestingOptionsNormalizeInput
): Record<string, string> {
  const options = new Map(Object.entries({ ...input.priorOptions, ...input.changes }))
  const modelId = input.changes.model ?? input.priorOptions.model ?? input.currentModel
  const support = codexServiceTierSupport({
    models: input.models,
    modelId,
    catalogKnown: input.catalogKnown
  })
  if (input.origin === 'set-option') {
    const { serviceTier, fastMode } = input.changes
    if (serviceTier !== undefined) {
      admitExplicitTier(serviceTier, support)
      options.delete('fastMode')
    } else if (fastMode !== undefined) {
      rejectMalformedFastModeToggle(fastMode)
      options.delete('serviceTier')
    }
  }
  migrateLegacyFastMode(options, support)
  return Object.fromEntries(options)
}

// ─── Reading the selection ──────────────────────────────────────────────────

/** Codex always reports speed facts, unlike the generic result where they are optional. */
export type CodexRestingOptionsReadResult = RestingOptionsReadResult & {
  speed: AgentSessionSpeedFacts
}

function legacyFastModeProjection(
  tierId: string,
  support: CodexServiceTierSupport
): { fastMode?: boolean } {
  const tiers = advertisedTiers(support)
  if (tierId === PROTOCOL_STANDARD_TIER_ID || tierId === codexStandardTierId(tiers)) {
    return { fastMode: false }
  }
  return tierId === codexFastTierId(tiers) ? { fastMode: true } : {}
}

/** The canonical current values and selection facts for a stored option map, judged against the
 *  destination model. Never throws; `unavailable` means the known catalog lacks the id,
 *  `unknown` that nothing can confirm it. */
export function readCodexServiceTierOptions(
  input: RestingOptionsReadInput
): CodexRestingOptionsReadResult {
  const options = new Map(Object.entries(input.options))
  const support = codexServiceTierSupport({
    models: input.models,
    modelId: options.get('model') ?? input.currentModel,
    catalogKnown: input.catalogKnown
  })
  migrateLegacyFastMode(options, support)
  const tierId = canonicalTier(options)
  if (tierId) {
    return {
      current: { serviceTier: tierId, ...legacyFastModeProjection(tierId, support) },
      speed: { selection: { tierId, state: codexServiceTierState(tierId, support) } }
    }
  }
  if (options.get('fastMode') === 'true') {
    return {
      current: { fastMode: true },
      speed: {
        selection: { legacyFastMode: true, state: support.known ? 'unavailable' : 'unknown' }
      }
    }
  }
  return { current: {}, speed: { selection: { state: 'unselected' } } }
}

/** The exact id to send with the next turn, or undefined when the session never chose a speed.
 *  Throws for an unavailable or unverifiable selection so the turn is refused before any write. */
export function admitCodexServiceTierForTurn(input: RestingOptionsReadInput): string | undefined {
  const { selection } = readCodexServiceTierOptions(input).speed
  if (selection.state === 'unselected') {
    return undefined
  }
  if (selection.state === 'ready' && selection.tierId !== undefined) {
    return selection.tierId
  }
  throw new CodexServiceTierSelectionError(
    selection.state === 'unavailable' ? 'unavailable' : 'unknown',
    selection
  )
}
