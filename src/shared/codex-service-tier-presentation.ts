// Picker presentation of Codex's catalog-backed speed tiers: the per-model `serviceTier` select,
// its unavailable rows and the captions both pickers derive from the descriptor alone. Which ids
// may be requested is `codex-service-tier-selection`; this only decides what is shown.

import type { AgentSessionOptionCatalog, CatalogOption } from './agent-session-option-catalog'
import type { AgentSessionModelOption, AgentSessionOptionChoice } from './agent-session-wire'
import { codexFastTierId, codexStandardTierId } from './codex-service-tier-selection'
import type { TrackedNativeChatSessionOption } from './native-chat-session-option-state'
import type {
  SessionOptionDescriptor,
  SessionOptionSelectChoice
} from './native-chat-session-options'

export const CODEX_SERVICE_TIER_OPTION_ID = 'serviceTier'

/** The execution host's answer for the speed capability. `undefined` where a caller has none
 *  to give: the model metadata alone then decides. */
export type CodexSpeedHostSupport = 'supported' | 'unsupported' | 'unknown'

// Presentation rows for Fast/Ultrafast the model does not advertise. Their values are never an
// advertised id and never admitted; the prefix says whether the catalog denies the tier or
// the model's tier support could not be read at all.
const UNAVAILABLE_PREFIX = 'orca-unavailable:'
const UNVERIFIED_PREFIX = 'orca-unverified:'

type MissingTierName = 'fast' | 'ultrafast'

function compactName(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function advertisesUltrafast(tiers: readonly AgentSessionOptionChoice[]): boolean {
  return tiers.some(
    (tier) => compactName(tier.label) === 'ultrafast' || compactName(tier.value) === 'ultrafast'
  )
}

function missingTierRow(
  name: MissingTierName,
  label: string,
  prefix: string
): SessionOptionSelectChoice {
  return { value: `${prefix}${name}`, label, disabled: true }
}

function advertisedChoice({
  value,
  label,
  description
}: AgentSessionOptionChoice): SessionOptionSelectChoice {
  return { value, label, ...(description ? { description } : {}) }
}

/** Standard, every advertised tier with its exact id, then disabled rows for the Fast and
 *  Ultrafast the model does not offer. Standard is always present: the protocol default is
 *  added when the provider omits it. */
export function codexServiceTierChoices(
  tiers: readonly AgentSessionOptionChoice[],
  supportKnown: boolean
): SessionOptionSelectChoice[] {
  const standardId = codexStandardTierId(tiers)
  const listed = tiers.map(advertisedChoice)
  const prefix = supportKnown ? UNAVAILABLE_PREFIX : UNVERIFIED_PREFIX
  return [
    ...(listed.some((choice) => choice.value === standardId)
      ? listed
      : [{ value: standardId, label: 'Standard' }, ...listed]),
    ...(codexFastTierId(tiers) === undefined ? [missingTierRow('fast', 'Fast', prefix)] : []),
    ...(advertisesUltrafast(tiers) ? [] : [missingTierRow('ultrafast', 'Ultrafast', prefix)])
  ]
}

/** The model's speed select, or null when the legacy Fast toggle (or nothing) stands. Advertised
 *  tiers make the select; on a host that affirms the capability, a model with no tier metadata
 *  still offers protocol Standard beside unverified paid rows, whatever its Fast compatibility
 *  flag says. A host that does not affirm the capability never gets the select. */
export function codexServiceTierCatalogOption(
  model: AgentSessionModelOption,
  host: CodexSpeedHostSupport | undefined
): CatalogOption | null {
  if (host === 'unsupported' || host === 'unknown') {
    return null
  }
  const tiers = model.serviceTiers
  if (tiers === undefined && host !== 'supported') {
    return null
  }
  return {
    id: CODEX_SERVICE_TIER_OPTION_ID,
    label: 'Speed',
    category: 'mode',
    kind: {
      type: 'select',
      choices: codexServiceTierChoices(tiers ?? [], tiers !== undefined),
      defaultValue: codexStandardTierId(tiers)
    },
    apply: {}
  }
}

/** While host support is unresolved no tier is offered, but a saved or held canonical tier must
 *  stay visible under its advertised label. Every row here is disabled, so nothing can be picked;
 *  the snapshot shows only the retained row and drops the select when nothing canonical is tracked. */
export function codexUnresolvedSpeedOptions(
  model: Pick<AgentSessionModelOption, 'serviceTiers'>,
  host: CodexSpeedHostSupport | undefined
): CatalogOption[] {
  if (host !== 'unknown') {
    return []
  }
  return [
    {
      id: CODEX_SERVICE_TIER_OPTION_ID,
      label: 'Speed',
      category: 'mode',
      kind: {
        type: 'select',
        choices: (model.serviceTiers ?? []).map((tier) => ({
          ...advertisedChoice(tier),
          disabled: true
        })),
        defaultValue: codexStandardTierId(undefined)
      },
      apply: {}
    }
  ]
}

function legacyFastModeOption(): CatalogOption {
  return {
    id: 'fastMode',
    label: 'Fast mode',
    category: 'mode',
    kind: { type: 'boolean', defaultValue: false },
    apply: {}
  }
}

/** Every speed control a model shows: the tier select where the host and listing allow it, else
 *  the older Fast toggle where the session and the model both claim support. Another agent passes
 *  `unsupported`, which keeps its toggle however much tier metadata a listing carries. */
export function codexSpeedCatalogOptions(
  model: AgentSessionModelOption,
  host: CodexSpeedHostSupport | undefined,
  sessionSupportsFastMode: boolean
): CatalogOption[] {
  const tier = codexServiceTierCatalogOption(model, host)
  if (tier) {
    return [tier]
  }
  return sessionSupportsFastMode && model.supportsFastMode === true ? [legacyFastModeOption()] : []
}

/** The catalog with each listed model's speed control rebuilt from a fresher listing, so a refreshed
 *  list, a lost tier list or a changed host capability reaches a session whose own list is newer in
 *  source but older in time. No session value is touched: a requested id the new list no longer
 *  offers stays selected, shown disabled. A toggle the listing makes no claim about stays as it was;
 *  one it explicitly denies (the model or the account lacks Fast mode) goes.
 *  Null when no listed model matched. */
export function refreshCodexServiceTierCatalog(
  catalog: AgentSessionOptionCatalog,
  listed: readonly AgentSessionModelOption[],
  host: CodexSpeedHostSupport | undefined,
  accountFastMode: boolean | undefined
): AgentSessionOptionCatalog | null {
  const byId = new Map(listed.map((model) => [model.id, model]))
  let changed = false
  const models = catalog.models.map((model) => {
    const listing = byId.get(model.id)
    if (!listing) {
      return model
    }
    changed = true
    const speed = codexSpeedCatalogOptions(listing, host, accountFastMode === true)
    const keepsToggle =
      speed.length === 0 && accountFastMode !== false && listing.supportsFastMode !== false
    return {
      ...model,
      options: [
        ...model.options.filter(
          (existing) =>
            (existing.id !== CODEX_SERVICE_TIER_OPTION_ID && existing.id !== 'fastMode') ||
            (keepsToggle && existing.id === 'fastMode')
        ),
        ...speed,
        ...codexUnresolvedSpeedOptions(listing, host)
      ]
    }
  })
  return changed ? { ...catalog, models } : null
}

function enabledChoices(
  choices: readonly SessionOptionSelectChoice[]
): SessionOptionSelectChoice[] {
  return choices.filter((choice) => choice.disabled !== true)
}

function missingRowValue(
  choices: readonly SessionOptionSelectChoice[],
  name: MissingTierName
): string | undefined {
  return choices.find(
    (choice) =>
      choice.disabled === true &&
      (choice.value === `${UNAVAILABLE_PREFIX}${name}` ||
        choice.value === `${UNVERIFIED_PREFIX}${name}`)
  )?.value
}

/** What the select shows as chosen. An explicit tier is shown as stored, offered or not: a
 *  retired id stays visible as a disabled row. An unresolved legacy Fast toggle is Fast intent
 *  and shows on the Fast row (disabled when the model lacks it), never as Standard; the legacy
 *  `false` is Standard. With neither, nothing is chosen. */
export function codexServiceTierSelection(args: {
  choices: readonly SessionOptionSelectChoice[]
  tracked: TrackedNativeChatSessionOption | undefined
  legacyFastMode: TrackedNativeChatSessionOption | undefined
}): {
  choices: SessionOptionSelectChoice[]
  currentValue?: string
  source?: TrackedNativeChatSessionOption['source']
} {
  const { tracked, legacyFastMode } = args
  const offered = enabledChoices(args.choices)
  let currentValue: string | undefined
  let source: TrackedNativeChatSessionOption['source'] | undefined
  if (typeof tracked?.value === 'string') {
    currentValue = tracked.value
    source = tracked.source
  } else if (typeof legacyFastMode?.value === 'boolean') {
    source = legacyFastMode.source
    currentValue = legacyFastMode.value
      ? (codexFastTierId(offered) ?? missingRowValue(args.choices, 'fast'))
      : codexStandardTierId(offered)
  }
  const choices = [...args.choices]
  if (currentValue !== undefined && !choices.some((choice) => choice.value === currentValue)) {
    // With no choice listed the protocol default still reads as Standard; any other id stays opaque.
    const isStandard = args.choices.length === 0 && currentValue === codexStandardTierId(undefined)
    choices.push({
      value: currentValue,
      label: isStandard ? 'Standard' : currentValue,
      disabled: true
    })
  }
  return {
    choices,
    ...(currentValue === undefined ? {} : { currentValue }),
    ...(source === undefined ? {} : { source })
  }
}

// ─── Descriptor-derived captions ────────────────────────────────────────────

export type CodexSpeedCaptionKey =
  | 'next-turn'
  | 'not-chosen'
  | 'support-unverified'
  | 'selection-blocked'

function isSpeedSelect(
  descriptor: SessionOptionDescriptor
): descriptor is SessionOptionDescriptor & { kind: { type: 'select' } } {
  return descriptor.id === CODEX_SERVICE_TIER_OPTION_ID && descriptor.kind.type === 'select'
}

/** Whether the picker may let this row change during a running turn: the one selector that
 *  applies to the next turn rather than the current one. */
export function isCodexSpeedSelectorSettable(descriptor: SessionOptionDescriptor): boolean {
  return isSpeedSelect(descriptor) && descriptor.settable
}

function hasUnverifiedRow(choices: readonly SessionOptionSelectChoice[]): boolean {
  return choices.some((choice) => choice.value.startsWith(UNVERIFIED_PREFIX))
}

/** A select with nothing to pick: host support is unresolved and only the retained value shows. */
function offersNoChoice(choices: readonly SessionOptionSelectChoice[]): boolean {
  return enabledChoices(choices).length === 0
}

/** Why the speed select reads as it does, from its descriptor alone, in display order.
 *  Always opens with the next-turn rule, which holds while a turn is running too. */
export function codexSpeedDescriptorCaptions(
  descriptor: SessionOptionDescriptor
): CodexSpeedCaptionKey[] {
  if (!isSpeedSelect(descriptor)) {
    return []
  }
  const { currentValue, choices } = descriptor.kind
  const captions: CodexSpeedCaptionKey[] = ['next-turn']
  if (currentValue === undefined) {
    captions.push('not-chosen')
  }
  if (hasUnverifiedRow(choices)) {
    captions.push('support-unverified')
  }
  // "Choose another" is false when nothing is offered: the phase and row text carry that case.
  if (
    !offersNoChoice(choices) &&
    choices.some((choice) => choice.value === currentValue && choice.disabled === true)
  ) {
    captions.push('selection-blocked')
  }
  return captions
}

/** How a speed row relates to the catalog: `unverified` when the model's tier support could
 *  not be read, `unavailable` when the catalog lacks the tier, `higher-usage` for an offered
 *  Fast or Ultrafast, which draws more of the allowance than Standard. Other offered rows,
 *  custom tiers included, claim nothing about usage. */
export function codexSpeedChoiceStatus(
  descriptor: SessionOptionDescriptor,
  choice: SessionOptionSelectChoice
): 'offered' | 'higher-usage' | 'unavailable' | 'unverified' {
  if (!isSpeedSelect(descriptor)) {
    return 'offered'
  }
  if (choice.disabled === true) {
    const { choices } = descriptor.kind
    return hasUnverifiedRow(choices) || offersNoChoice(choices) ? 'unverified' : 'unavailable'
  }
  const names = [compactName(choice.label), compactName(choice.value)]
  return names.includes('fast') || names.includes('ultrafast') ? 'higher-usage' : 'offered'
}
