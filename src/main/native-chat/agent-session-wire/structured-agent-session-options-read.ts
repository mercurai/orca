// A chat's options, live or at rest.
//
// At rest nothing here needs a child. The pick is the record's own `options` — what the next start replays —
// and the list is the host's model catalog, the same one the picker already reads before a chat
// exists. A pick made at rest is written to the record as intent, through the same transition a live
// pick takes, so the next start applies it.

import {
  refuse,
  type AgentSessionFastModeSupport,
  type AgentSessionModelOption,
  type AgentSessionOptionResult,
  type AgentSessionOptionsResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { decodeStructuredAgentSessionOptionValue } from '../../../shared/structured-agent-session-option-codec'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentModelCatalogService } from '../agent-model-catalog/agent-model-catalog-service'
import { journalOpenReadRefusal } from '../agent-session-journal/journal-open-failure'
import type { StructuredAgentDefinition } from './structured-agent-definition'
import type { StructuredAgentRegistry } from './structured-agent-registry'
import type { StructuredAgentSessionLiveOptions } from './structured-agent-session-adapter'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import { recordedRefusalOptions } from './structured-agent-session-option-error'
import { structuredAgentSessionOptionModels } from './structured-agent-session-option-models'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'

type RestingOptions = Pick<
  AgentSessionOptionsResult,
  'models' | 'fastModeSupport' | 'current' | 'speed'
>

type RestingRules = StructuredAgentDefinition['restingOptions']

/** The at-rest rules of the record's agent, as this runtime registered it; null for any other. */
function restingOptionRules(
  agents: Pick<StructuredAgentRegistry, 'definition'>,
  record: AgentSessionRecord
): RestingRules | null {
  return agents.definition(record.provider)?.restingOptions ?? null
}

type RestingCatalogDeps = { modelCatalog?: Pick<AgentModelCatalogService, 'read'> }

type RestingCatalog = {
  /** The host's listing, else the agent's fallback list; null when neither exists. */
  listed: AgentSessionModelOption[] | null
  /** True only for a real listing of the account; the fallback list never counts. */
  known: boolean
  fastModeSupport?: AgentSessionFastModeSupport
}

async function readRestingCatalog(
  deps: RestingCatalogDeps,
  record: AgentSessionRecord,
  sessionId: string,
  rules: RestingRules | null
): Promise<RestingCatalog> {
  const catalog = (await deps.modelCatalog
    ?.read({ agent: record.provider, sessionId })
    .catch(() => null)) ?? { origin: 'unknown' as const }
  if (catalog.origin === 'unknown') {
    // With no catalog for the account, the list a running child of this agent falls back to.
    return { listed: rules?.fallbackModels() ?? null, known: false }
  }
  return {
    listed: catalog.models,
    known: true,
    ...(catalog.fastModeSupport ? { fastModeSupport: catalog.fastModeSupport } : {})
  }
}

/** The model a chat at rest is on: the pick, else the default of a real listing. Only a real
 *  listing names the account's default; a built-in list's default is a guess, so with none the
 *  client keeps its own. */
function restingModel(
  saved: Readonly<Record<string, string>>,
  catalog: RestingCatalog
): string | undefined {
  return (
    saved.model ??
    (catalog.known ? catalog.listed?.find((entry) => entry.isDefault)?.id : undefined)
  )
}

async function readStructuredAgentSessionOptionsAtRest(
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'agents' | 'modelCatalog'>,
  sessionId: string
): Promise<RestingOptions> {
  const record = deps.store.getRecord(sessionId)
  if (!record) {
    throw new Error('agent_session_identity_required')
  }
  const rules = restingOptionRules(deps.agents, record)
  const catalog = await readRestingCatalog(deps, record, sessionId, rules)
  const models = catalog.listed ?? []
  const saved = record.options ?? {}
  // An unknown model is one the client already treats as unconfirmed.
  const model = restingModel(saved, catalog)
  // As a live child answers: the pick, else the model's default where the agent reports that.
  const effort =
    saved.effort ??
    (rules?.effortDefaultsToModel
      ? models.find((entry) => entry.id === model)?.defaultEffort
      : undefined)
  const listedModels = catalog.listed
    ? structuredAgentSessionOptionModels(catalog.listed, model, (row) => row)
    : []
  // The agent's own reader decides the canonical values; without one, the legacy boolean alone.
  const read = rules?.readOptions?.({
    options: saved,
    models: listedModels,
    ...(model ? { currentModel: model } : {}),
    catalogKnown: catalog.known
  })
  const fastMode =
    saved.fastMode === undefined
      ? null
      : decodeStructuredAgentSessionOptionValue('fastMode', saved.fastMode)
  const canonical = read?.current ?? (typeof fastMode === 'boolean' ? { fastMode } : {})
  return {
    models: listedModels,
    ...(catalog.fastModeSupport ? { fastModeSupport: catalog.fastModeSupport } : {}),
    ...(read?.speed ? { speed: read.speed } : {}),
    current: {
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...canonical
    }
  }
}

function optionRejection(message: string): TurnOutcome<never> {
  return {
    ok: false,
    refusal: refuse('agent_session_operation_invalid', { reason: 'optionRejected' }, message)
  }
}

/** The complete option map after one at-rest pick. An agent with its own normalizer judges the
 *  pick against the account's catalog and throws for one it cannot accept; otherwise the pick is
 *  merged as given. */
async function restingOptionsAfterPick(
  deps: RestingCatalogDeps,
  record: AgentSessionRecord,
  sessionId: string,
  rules: RestingRules,
  input: { key: string; value: string }
): Promise<Record<string, string>> {
  const priorOptions = record.options ?? {}
  if (!rules.normalizeOptions) {
    return { ...priorOptions, [input.key]: input.value }
  }
  const catalog = await readRestingCatalog(deps, record, sessionId, rules)
  const currentModel = restingModel(priorOptions, catalog)
  return rules.normalizeOptions({
    priorOptions,
    changes: { [input.key]: input.value },
    origin: 'set-option',
    models: catalog.listed ?? [],
    ...(currentModel ? { currentModel } : {}),
    catalogKnown: catalog.known
  })
}

/** Records a pick for the next start. Only a key the provider would accept is kept, and an agent
 *  whose normalizer refuses the pick leaves the record untouched. */
export async function recordStructuredAgentSessionOptionIntent(
  deps: RestingCatalogDeps & {
    store: Pick<AgentSessionRecordStore, 'getRecord'>
    agents: Pick<StructuredAgentRegistry, 'definition'>
  },
  ctx: Pick<AgentSessionTurnContext, 'sessionId' | 'persistOptions' | 'publish'>,
  input: { key: string; value: string }
): Promise<TurnOutcome<AgentSessionOptionResult>> {
  const record = deps.store.getRecord(ctx.sessionId)
  const rules = record ? restingOptionRules(deps.agents, record) : null
  if (!record || !rules?.acceptsKey(input.key)) {
    return optionRejection(
      `${record?.provider ?? 'This session'} has no session option named ${input.key}`
    )
  }
  let options: Record<string, string>
  try {
    options = await restingOptionsAfterPick(deps, record, ctx.sessionId, rules, input)
  } catch (error) {
    // The normalizer's contract: a throw is a refusal of this pick, before anything is written —
    // except the complete map a typed refusal carries, which records the refusal itself.
    const refusalOptions = recordedRefusalOptions(error)
    if (refusalOptions) {
      await ctx.persistOptions(refusalOptions)
      ctx.publish()
    }
    return optionRejection(error instanceof Error ? error.message : String(error))
  }
  await ctx.persistOptions(options)
  ctx.publish()
  return { ok: true, value: { ...input, options } }
}

/** A live child's own answer, or the answer at rest; the goal, usage and rewind either way. */
export async function readStructuredAgentSessionOptions(
  context: Pick<
    StructuredAgentSessionMutationContext,
    'deps' | 'serialize' | 'openConversation' | 'conversation'
  >,
  sessionId: string
): Promise<AgentSessionOptionsResult> {
  const { adapter, agents, store } = context.deps
  const started = await context.serialize(sessionId, async () => {
    const session = await context.openConversation(sessionId).catch((error: unknown) => {
      throw journalOpenReadRefusal(error, context.deps.logger, sessionId)
    })
    const child = session?.child
    if (!child) {
      return { kind: 'rest' as const }
    }
    const prepared = adapter.prepareReadOptions?.({ sessionId, fence: child.fence })
    if (prepared) {
      return { kind: 'prepared' as const, child, prepared }
    }
    if (!adapter.readOptions) {
      throw new Error('structured_agent_session_options_unsupported')
    }
    return {
      kind: 'live' as const,
      options: await adapter.readOptions({ sessionId, fence: child.fence })
    }
  })
  const live: StructuredAgentSessionLiveOptions | null =
    started.kind === 'live'
      ? started.options
      : started.kind === 'prepared'
        ? await started.prepared.then((apply) =>
            context.serialize(sessionId, async () => {
              const child = (await context.openConversation(sessionId))?.child
              return child === started.child ? apply() : null
            })
          )
        : null
  let options: Omit<AgentSessionOptionsResult, 'rewind'>
  if (live) {
    const { catalogListing, ...answer } = live
    if (catalogListing) {
      // What a running child listed is its account's catalog too, so the next chat opens warm.
      context.deps.modelCatalog?.recordLiveListing(sessionId, catalogListing)
    }
    options = answer
  } else {
    options = await readStructuredAgentSessionOptionsAtRest(context.deps, sessionId)
  }
  // Re-acquired after the reads above: the handle they saw may have closed and reopened since.
  const session = await context.conversation(sessionId)
  const phase = store.getRecord(sessionId)?.rewind?.phase
  const agent = session.params.provider
  const capabilities = agents.capabilities(agent)
  const floor = session.journal.context.floor()
  const contextFloor = floor ? { contextFloor: floor } : {}
  return {
    ...options,
    rewind:
      phase === 'prepared' || phase === 'provider-succeeded'
        ? { supported: false, reason: 'outcome-unknown' }
        : (adapter.rewindSupport?.(sessionId, agent) ?? {
            supported: false,
            reason: 'unsupported'
          }),
    conversationCommands: capabilities?.compact ? ['clear', 'compact'] : ['clear'],
    ...(capabilities?.threadGoal
      ? { threadGoal: { current: session.journal.threadGoal(), ...contextFloor } }
      : {}),
    ...(capabilities?.contextUsage
      ? { contextUsage: { current: session.journal.contextUsage(), ...contextFloor } }
      : {})
  }
}
