import { withStructuredSpeedSnapshot } from '../../structured-agent-session-speed'
import type { AgentSessionSpeed } from '../../agent-session-speed'
// A structured chat's picker: the chat's own values, drawn under the controls of the model they apply to.

import type {
  AgentSessionOptionCatalog,
  CatalogModel,
  CatalogOption
} from './agent-session-option-catalog-types'
import {
  nativeChatSessionOptionDescriptors,
  withTrackedNativeChatModel,
  type NativeChatShownModel
} from '../../native-chat/input/native-chat-session-option-snapshot'
import type {
  SessionOptionDescriptor,
  SessionOptionValue
} from '../../native-chat/input/native-chat-session-options'
import type { TrackedNativeChatSessionOption } from '../../native-chat/input/native-chat-session-option-state'
import {
  catalogEffortLevels,
  effectiveAgentEffort
} from '../../structured-agent-session-effective-effort'
import { effectiveServiceTier } from './structured-agent-session-effective-tier'
import { serviceTierOption } from './structured-agent-session-discovered-model'
import {
  structuredAgentSessionModelId,
  type StructuredAgentSessionOptionRecord
} from './structured-agent-session-option-state'
import { withUnlistedEffort } from './structured-agent-session-unlisted-effort'
import { structuredAgentSessionPermissionDescriptor } from './structured-agent-session-permission-option'
import type { StructuredAgentSessionOptionState } from './structured-agent-session-options'

/** Unpickable placeholder cannot become a launch selection before a real model answer. */
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

/** Name a catalog default only when the host says this launch runs it; otherwise use it solely for controls. */
export function structuredAgentSessionShownModel(
  catalog: AgentSessionOptionCatalog,
  models: readonly CatalogModel[],
  record: StructuredAgentSessionOptionRecord
): { shown: NativeChatShownModel; controlsModelId: string | null; isCliDefault: boolean } {
  const own = structuredAgentSessionModelId(record, 'own')
  const supplied = structuredAgentSessionModelId(record, 'any')
  const defaultId =
    own || !catalog.defaultModelIsCliDefault
      ? null
      : (supplied ?? models.find((model) => model.isDefault)?.id ?? null)
  const currentId = own ?? defaultId
  return {
    shown: {
      currentId,
      valueSource: own
        ? (record.values.model?.source ?? 'unknown')
        : defaultId
          ? 'default'
          : 'unknown',
      tracked: own ? record.values.model : undefined
    },
    controlsModelId: currentId ?? supplied,
    isCliDefault: currentId !== null && currentId === defaultId
  }
}

/** Only the chat’s verified listing describes a model; an unlisted chat model has no inferred capabilities. */
export function structuredAgentSessionDescribedModel(
  state: Pick<StructuredAgentSessionOptionState, 'catalog' | 'verifiedModelIds'>,
  modelId: string
): CatalogModel | undefined {
  const model = state.catalog?.models.find((entry) => entry.id === modelId)
  return model && (!state.verifiedModelIds || state.verifiedModelIds.includes(modelId))
    ? model
    : undefined
}

const tierChoices = (option: CatalogOption | undefined): string[] =>
  option?.id === 'serviceTier' && option.kind.type === 'select'
    ? option.kind.choices.map((choice) => choice.value)
    : []

/** Apply host tier rules; older hosts retain their reported Flex behavior. */
function valuesUnderControls(
  catalog: AgentSessionOptionCatalog,
  controls: readonly CatalogOption[],
  values: Readonly<Record<string, TrackedNativeChatSessionOption>>,
  olderHost: boolean
): Readonly<Record<string, TrackedNativeChatSessionOption>> {
  const tier = values.serviceTier?.value
  const control = controls.find((option) => option.id === 'serviceTier')
  if (
    typeof tier !== 'string' ||
    !control ||
    values.serviceTier?.source === 'applied' ||
    values.model?.source === 'default' ||
    (olderHost && tier === 'flex')
  ) {
    return values
  }
  const effective = effectiveServiceTier({
    tier,
    modelTiers: tierChoices(control),
    listedTiers: catalog.models.flatMap((model) => model.options.flatMap(tierChoices)),
    // The answer's tier is the agent's own report when no listed model offers it.
    reported: true
  })
  return effective === tier
    ? values
    : { ...values, serviceTier: { value: effective, source: 'default' } }
}

export function structuredAgentSessionDrawnValues(
  state: StructuredAgentSessionOptionState
): Readonly<Record<string, TrackedNativeChatSessionOption>> {
  return drawnModelControls(state)?.values ?? state.record.values
}

/** Preserve a requested tier under its own unlisted Codex model, without claiming support. */
function unlistedCodexTier(state: StructuredAgentSessionOptionState): string | undefined {
  const modelId = structuredAgentSessionModelId(state.record, 'own')
  const tier = state.record.values.serviceTier?.value
  // A seed lists no model: its rows cannot describe an installed model before discovery.
  return state.record.agent === 'codex' &&
    state.olderHost !== true &&
    modelId !== null &&
    (state.catalogSource === 'seed' ||
      structuredAgentSessionDescribedModel(state, modelId) === undefined) &&
    typeof tier === 'string'
    ? tier
    : undefined
}

function drawnModelControls(state: StructuredAgentSessionOptionState) {
  const { record } = state
  if (
    !state.catalog ||
    (state.catalogSource === 'seed' && structuredAgentSessionModelId(record, 'own') === null)
  ) {
    return null
  }
  // Before discovery, name only accepted input; static rows cannot supply installed capabilities.
  const catalog = state.catalogSource === 'seed' ? { ...state.catalog, models: [] } : state.catalog
  const models = withTrackedNativeChatModel(catalog, catalog.models, { model: record.values.model })
  const shown = structuredAgentSessionShownModel(catalog, models, record)
  const modelControls = shown.controlsModelId
    ? (models.find((model) => model.id === shown.controlsModelId)?.options ?? [])
    : modellessControls(catalog, record)
  // Normalize only under the named model’s listed controls; stand-ins/unlisted models preserve host values.
  const normalises =
    shown.shown.currentId !== null &&
    structuredAgentSessionDescribedModel(
      { catalog, verifiedModelIds: state.verifiedModelIds },
      shown.shown.currentId
    ) !== undefined
  // An unlisted Codex model can retain a requested tier, without borrowing another model’s offers.
  const controls =
    unlistedCodexTier(state) !== undefined &&
    !modelControls.some((option) => option.id === 'serviceTier' || option.id === 'fastMode')
      ? [...modelControls, serviceTierOption([])]
      : modelControls
  let values =
    normalises && record.agent !== 'codex'
      ? valuesUnderControls(catalog, controls, record.values, state.olderHost === true)
      : record.values
  if (record.agent === 'pi' && state.reportedEffort !== undefined) {
    values = { ...values, effort: { value: state.reportedEffort, source: 'reported' } }
  }
  const requested = values.effort
  if (
    normalises &&
    record.agent === 'pi' &&
    typeof requested?.value === 'string' &&
    requested.source !== 'reported'
  ) {
    const effort = effectiveAgentEffort(requested.value, catalogEffortLevels(controls))
    if (effort && effort !== requested.value) {
      values = { ...values, effort: { ...requested, value: effort } }
    }
  }
  return { catalog, models, ...shown, controls, values }
}

/** Without model evidence, retain saved nonstandard speed and allow Standard to disable it. */
function modellessControls(
  catalog: AgentSessionOptionCatalog,
  record: StructuredAgentSessionOptionRecord
): CatalogOption[] {
  const tier = record.values.serviceTier?.value
  if (typeof tier !== 'string' || tier === 'default') {
    return []
  }
  const named = catalog.models
    .flatMap((model) => model.options)
    .flatMap((option) =>
      option.id === 'serviceTier' && option.kind.type === 'select' ? option.kind.choices : []
    )
    .find((choice) => choice.value === tier)
  return [serviceTierOption([named ?? { value: tier, label: tier }])]
}

function modelOptionSnapshot(state: StructuredAgentSessionOptionState): SessionOptionDescriptor[] {
  if (!state.catalog) {
    return []
  }
  const drawn = drawnModelControls(state)
  // Wait for host labels instead of flashing built-in names the answer may replace.
  if (!drawn) {
    return [PROVIDER_DEFAULT_MODEL_PLACEHOLDER]
  }
  const { catalog, models, shown, controlsModelId, isCliDefault, controls, values } = drawn
  const snapshot =
    models.length === 0
      ? []
      : nativeChatSessionOptionDescriptors({
          catalog,
          models,
          mode: 'live',
          modelLabel: 'Model',
          liveTransport: 'agent-session',
          model: shown,
          controls,
          values,
          modelIsCliDefault: isCliDefault
        })
  return snapshot.length > 0 || state.catalogSource === 'live'
    ? withUnlistedEffort(
        catalog,
        controlsModelId,
        values.effort,
        state.verifiedModelIds,
        snapshot,
        state.record.agent
      )
    : [PROVIDER_DEFAULT_MODEL_PLACEHOLDER]
}

export function structuredAgentSessionOptionSnapshot(
  state: StructuredAgentSessionOptionState
): SessionOptionDescriptor[] {
  const permission = structuredAgentSessionPermissionDescriptor(state)
  const tierId = unlistedCodexTier(state)
  const modelId = structuredAgentSessionModelId(state.record, 'own') ?? undefined
  const needsOwnSpeed = tierId !== undefined && (!state.speed || state.speedModelId !== modelId)
  const speed: AgentSessionSpeed | undefined = needsOwnSpeed
    ? {
        requested: { tierId },
        support: state.listingInProgress ? 'loading' : 'unknown',
        processing: { status: 'unknown' }
      }
    : state.speed
  const options = withStructuredSpeedSnapshot(
    modelOptionSnapshot(state),
    speed,
    needsOwnSpeed ? modelId : state.speedModelId
  ).map((option) =>
    (state.listingInProgress && ['effort', 'serviceTier', 'fastMode'].includes(option.id)) ||
    (state.fastModeRestricted && option.id === 'fastMode')
      ? { ...option, settable: false }
      : option
  )
  return permission ? [...options, permission] : options
}

/** Presentation only until a launch or fence can carry picks. */
export function lockedStructuredAgentSessionOptionSnapshot(
  snapshot: readonly SessionOptionDescriptor[],
  capabilitiesOnly = false
): SessionOptionDescriptor[] {
  return snapshot.map((descriptor) =>
    capabilitiesOnly && !['effort', 'serviceTier', 'fastMode'].includes(descriptor.id)
      ? descriptor
      : { ...descriptor, settable: false, disabledReason: 'available-after-session-start' }
  )
}

/** Only the current model's own verified, discovered effort menu proves a level; seeds, stand-ins and other models' menus do not. */
function currentModelMenuOffersEffort(
  state: StructuredAgentSessionOptionState,
  value: string
): boolean {
  const drawn = drawnModelControls(state)
  const currentId = drawn?.shown.currentId
  if (!drawn || !currentId) {
    return false
  }
  const menu = structuredAgentSessionDescribedModel(
    { catalog: drawn.catalog, verifiedModelIds: state.verifiedModelIds },
    currentId
  )?.options.find((option) => option.id === 'effort')
  return menu?.kind.type === 'select' && menu.kind.choices.some((choice) => choice.value === value)
}

export function canSetStructuredAgentSessionOption(
  state: StructuredAgentSessionOptionState,
  id: string,
  value: SessionOptionValue,
  snapshot = structuredAgentSessionOptionSnapshot(state),
  interactionReady = true,
  pending = false
): boolean {
  if (!interactionReady || pending || (id === 'fastMode' && state.fastModeRestricted)) {
    return false
  }
  if (id === 'permissionMode') {
    const descriptor = snapshot.find((entry) => entry.id === id)
    return (
      descriptor?.settable === true &&
      descriptor.kind.type === 'select' &&
      (value === 'own'
        ? state.permissionOwnSupported === true
        : descriptor.kind.choices.some((choice) => choice.value === value))
    )
  }
  // A control the snapshot reports read-only cannot be edited; a refresh only presents it locked,
  // and the model pill stays pickable by typed literal while its placeholder is unsettable.
  // Effort is read-only for any unlisted model or retired level, yet only Pi's exact menus
  // refuse a typed level, unless the current model's own discovered menu lists it;
  // Claude and Codex still accept one to repair it.
  if (
    id !== 'model' &&
    (id !== 'effort' || state.record.agent === 'pi') &&
    !state.listingInProgress &&
    snapshot.find((entry) => entry.id === id)?.settable === false &&
    !(id === 'effort' && typeof value === 'string' && currentModelMenuOffersEffort(state, value))
  ) {
    return false
  }
  return (
    (['model', 'effort', 'serviceTier', 'personality'].includes(id) &&
      typeof value === 'string' &&
      value.length > 0) ||
    (id === 'fastMode' && typeof value === 'boolean')
  )
}
