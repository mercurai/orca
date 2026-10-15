import type { AgentType } from './agent-status-types'
import { isAgentSessionOptions } from './agent-session-record'
import { sessionOptionValueIsValid } from './agent-session-option-catalog'
import type {
  NativeChatSessionOptionSettingsMutation,
  PersistedNativeChatSessionOptions,
  SessionOptionValue
} from './native-chat-session-options'
import {
  decodeStructuredAgentSessionOptionValue,
  encodeStructuredAgentSessionOptionValue
} from './structured-agent-session-option-codec'

export function resolveNativeChatSessionOptionDefaults(
  persisted: PersistedNativeChatSessionOptions | null | undefined,
  agent: AgentType
): Record<string, SessionOptionValue> | undefined {
  const entry = persisted?.[agent]
  // Why: untouched settings must preserve the agent CLI's configured defaults;
  // only a model explicitly selected by the user authorizes launch flags.
  const modelId = typeof entry?.model === 'string' && entry.model.trim() ? entry.model : undefined
  if (!modelId) {
    return undefined
  }
  const values: Record<string, SessionOptionValue> = { model: modelId }
  const storedValues = entry?.valuesByModel?.[modelId]
  if (storedValues && typeof storedValues === 'object') {
    for (const [id, value] of Object.entries(storedValues)) {
      if (sessionOptionValueIsValid(value)) {
        values[id] = value
      }
    }
  }
  return values
}

/** Canonical values seed through the existing durable string record; the codec
 *  is the only boundary that represents the boolean Fast preference as text.
 *  `serviceTier` is Codex's canonical speed and outranks a coexisting `fastMode`. */
export const STRUCTURED_LAUNCH_SEED_OPTION_IDS = [
  'model',
  'effort',
  'serviceTier',
  'fastMode'
] as const

const NON_BLANK_SEED_OPTION_IDS: ReadonlySet<string> = new Set(['model', 'effort', 'serviceTier'])

/** Any chosen option set narrowed to what a structured create may seed: the seedable ids only,
 *  each encoded as a bounded string. An empty result is `undefined` rather than `{}` — an empty map fails
 *  the durable record's bounded-string guard, and `agent_session_options_invalid` is not a wire
 *  refusal code, so the throw strands the launch with no fallback.
 *
 *  Shared with orchestration, whose `--model`/`--effort` seed a worker's session the same way a
 *  saved selection seeds the user's own chat. */
export function narrowStructuredLaunchSeedOptions(
  values: Readonly<Record<string, unknown>> | null | undefined
): Record<string, string> | undefined {
  const seeded: Record<string, string> = {}
  for (const id of STRUCTURED_LAUNCH_SEED_OPTION_IDS) {
    const value = values?.[id]
    if (id === 'fastMode' && seeded.serviceTier !== undefined) {
      continue
    }
    if (NON_BLANK_SEED_OPTION_IDS.has(id) && !(typeof value === 'string' && value.trim())) {
      continue
    }
    if (typeof value === 'string' || typeof value === 'boolean') {
      const encoded = encodeStructuredAgentSessionOptionValue(id, value)
      if (encoded !== null) {
        seeded[id] = encoded
      }
    }
  }
  return Object.keys(seeded).length > 0 ? seeded : undefined
}

/** An already-encoded seed read from another host or from storage: the seedable ids whose value
 *  decodes, or `undefined` when nothing usable remains. */
export function parseStructuredLaunchSeedOptions(
  value: unknown
): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const entries = new Map<string, unknown>(Object.entries(value))
  const parsed: Record<string, string> = {}
  for (const id of STRUCTURED_LAUNCH_SEED_OPTION_IDS) {
    const encoded = entries.get(id)
    if (id === 'fastMode' && parsed.serviceTier !== undefined) {
      continue
    }
    if (
      typeof encoded === 'string' &&
      encoded.trim() &&
      decodeStructuredAgentSessionOptionValue(id, encoded) !== null
    ) {
      parsed[id] = encoded
    }
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined
}

/** The saved selection a structured create seeds into its string-valued reservation. Only Codex
 *  keeps `serviceTier`; Claude and every other agent seed their own controls. */
export function resolveStructuredLaunchSeedOptions(
  persisted: PersistedNativeChatSessionOptions | null | undefined,
  agent: AgentType
): Record<string, string> | undefined {
  const values = resolveNativeChatSessionOptionDefaults(persisted, agent)
  if (!values || agent === 'codex') {
    return narrowStructuredLaunchSeedOptions(values)
  }
  const { serviceTier: _codexOnly, ...others } = values
  return narrowStructuredLaunchSeedOptions(others)
}

const CODEX_SPEED_COUNTERPART: Readonly<Record<string, string>> = {
  fastMode: 'serviceTier',
  serviceTier: 'fastMode'
}

function isCodexSpeedOption(agent: AgentType, optionId: string): boolean {
  return agent === 'codex' && (optionId === 'fastMode' || optionId === 'serviceTier')
}

/** A Codex speed value the seed boundary would accept: a boolean Fast toggle or a non-blank tier
 *  id that fits the durable record's bounded string. Anything else is not a speed choice. */
function isExplicitCodexSpeedChoice(
  agent: AgentType,
  optionId: string,
  value: SessionOptionValue
): boolean {
  if (!isCodexSpeedOption(agent, optionId)) {
    return false
  }
  const encoded = encodeStructuredAgentSessionOptionValue(optionId, value)
  if (encoded === null) {
    return false
  }
  return (
    optionId === 'fastMode' ||
    (encoded.trim() !== '' && isAgentSessionOptions({ serviceTier: encoded }))
  )
}

/** Fold a settled batch of picks onto the durable record. A surface that must send the
 *  whole object back — rather than merging key by key — applies them in one pass so a
 *  later pick in the batch cannot drop an earlier one. */
export function applyNativeChatSessionOptionPicks(args: {
  persisted: PersistedNativeChatSessionOptions | null | undefined
  agent: AgentType
  picks: Extract<NativeChatSessionOptionSettingsMutation, { type: 'apply-picks' }>['picks']
}): PersistedNativeChatSessionOptions {
  let persisted = args.persisted ?? {}
  const tierModelIds = new Set(
    args.picks
      .filter(
        (pick) =>
          pick.optionId === 'serviceTier' &&
          isExplicitCodexSpeedChoice(args.agent, pick.optionId, pick.value)
      )
      .map((pick) => pick.modelId)
  )
  for (const pick of args.picks) {
    // Why: a canonical snapshot batch carries a compatibility fastMode projection for the same
    // model. In pick order it still adopts the model, but stores no Fast value, so the tier wins
    // whatever the intra-model order and the batch's last-picked model is unchanged.
    const isProjection =
      pick.optionId === 'fastMode' &&
      tierModelIds.has(pick.modelId) &&
      isExplicitCodexSpeedChoice(args.agent, pick.optionId, pick.value)
    persisted = updateNativeChatSessionOptionDefaults({
      persisted,
      agent: args.agent,
      ...pick,
      ...(isProjection ? { optionId: 'model', value: pick.modelId } : {})
    })
  }
  return persisted
}

/** Applies one host-owned delta to the latest record. Returning null means the
 * authoritative model list found nothing to retire. */
export function applyNativeChatSessionOptionSettingsMutation(
  persisted: PersistedNativeChatSessionOptions | null | undefined,
  mutation: NativeChatSessionOptionSettingsMutation
): PersistedNativeChatSessionOptions | null {
  if (mutation.type === 'apply-picks') {
    return applyNativeChatSessionOptionPicks({
      persisted,
      agent: mutation.agent,
      picks: mutation.picks
    })
  }
  const modelId = persisted?.[mutation.agent]?.model
  if (!modelId || mutation.availableModelIds.includes(modelId)) {
    return null
  }
  return clearNativeChatSessionOptionModel(persisted, mutation.agent)
}

/** Why: an authoritative probe proved this id gone, and a stale `model` is emitted
 *  verbatim as a launch flag — grok exits fatally on an unknown one. Dropping only
 *  `model` keeps the per-model option values for a later reselect. */
export function clearNativeChatSessionOptionModel(
  persisted: PersistedNativeChatSessionOptions | null | undefined,
  agent: AgentType
): PersistedNativeChatSessionOptions {
  const currentAgent = persisted?.[agent]
  if (!currentAgent?.model) {
    return { ...persisted }
  }
  const { model: _dropped, ...rest } = currentAgent
  return { ...persisted, [agent]: rest }
}

export function updateNativeChatSessionOptionDefaults(args: {
  persisted: PersistedNativeChatSessionOptions | null | undefined
  agent: AgentType
  modelId: string
  optionId: string
  value: SessionOptionValue
  /** Defaults to adopting, since without a `model` no launch resolves the value at all.
   *  Only the picker surface, which can tell a probe-confirmed id from the seed's guess
   *  at the CLI default, withholds it: adopting a guess would emit `-m <guess>` on every
   *  later launch, fatal on an account without that model. */
  adoptModelAsLaunchDefault?: boolean
}): PersistedNativeChatSessionOptions {
  const isSpeed = isCodexSpeedOption(args.agent, args.optionId)
  // Why: a malformed speed value is no choice at all; it must not overwrite the same key or
  // adopt its model as the launch default.
  if (isSpeed && !isExplicitCodexSpeedChoice(args.agent, args.optionId, args.value)) {
    return args.persisted ?? {}
  }
  const currentAgent = args.persisted?.[args.agent]
  const currentModelValues = currentAgent?.valuesByModel?.[args.modelId] ?? {}
  // Why: an explicit speed action is a new user choice, so the other spelling of speed is stale.
  const supersededId = isSpeed ? CODEX_SPEED_COUNTERPART[args.optionId] : undefined
  const keptModelValues = Object.fromEntries(
    Object.entries(currentModelValues).filter(([id]) => id !== supersededId)
  )
  const valuesByModel = {
    ...currentAgent?.valuesByModel,
    ...(args.optionId === 'model'
      ? {}
      : {
          [args.modelId]: { ...keptModelValues, [args.optionId]: args.value }
        })
  }
  return {
    ...args.persisted,
    [args.agent]: {
      ...currentAgent,
      ...(args.adoptModelAsLaunchDefault === false
        ? {}
        : { model: args.optionId === 'model' ? String(args.value) : args.modelId }),
      valuesByModel
    }
  }
}
