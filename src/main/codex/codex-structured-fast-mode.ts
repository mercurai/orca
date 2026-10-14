import { providerDiagnostic, providerDiagnosticOf } from '../../shared/agent-session-failure'
import type { AgentSessionSpeedFacts } from '../../shared/agent-session-speed-facts'
import type {
  AgentSessionFastModeSupport,
  AgentSessionModelOption,
  AgentSessionOptionChoice
} from '../../shared/agent-session-wire'
import {
  admitCodexServiceTierForTurn,
  CodexServiceTierSelectionError,
  codexFastTierId,
  normalizeCodexServiceTierOptions,
  parseCodexModelServiceTiers
} from '../../shared/codex-service-tier-selection'
import { isCodexAppServerRequestError } from './codex-app-server-connection'
import { isCodexAppServerUnsupportedError } from './codex-app-server-session'
import { codexListingDefaultModel, codexSpeedCatalog } from './codex-structured-catalog-entry'
import type { CodexOpenedThread } from './codex-structured-thread-open'
import type { CodexSession } from './codex-structured-session-state'

/** A model row's advertised request tiers, with the legacy Fast projection derived from the same rows. */
export function readCodexModelTiers(row: Record<string, unknown>): {
  serviceTiers?: AgentSessionOptionChoice[]
  fastModeTierId?: string
} {
  const serviceTiers = parseCodexModelServiceTiers(row)
  const fastModeTierId = codexFastTierId(serviceTiers)
  return {
    ...(serviceTiers ? { serviceTiers } : {}),
    ...(fastModeTierId ? { fastModeTierId } : {})
  }
}

export function codexFastModeSupport(
  models: readonly AgentSessionModelOption[]
): AgentSessionFastModeSupport | undefined {
  if (models.some((model) => model.supportsFastMode === true)) {
    return { supported: true }
  }
  return models.length > 0 && models.every((model) => model.supportsFastMode === false)
    ? { supported: false, reason: 'model-not-supported' }
    : undefined
}

export function reportedCodexThreadOptions(
  opened: CodexOpenedThread
): CodexSession['reportedOptions'] {
  return {
    ...(opened.model ? { model: opened.model } : {}),
    ...(opened.effort ? { effort: opened.effort } : {}),
    ...('serviceTier' in opened
      ? { serviceTier: opened.serviceTier ?? null, serviceTierKnown: true as const }
      : {})
  }
}

/** Replaces a session's stored options in place; the Map's identity is shared with its turns. */
export function replaceCodexSessionOptions(
  options: Map<string, string>,
  next: Readonly<Record<string, string>>
): void {
  options.clear()
  for (const [key, value] of Object.entries(next)) {
    options.set(key, value)
  }
}

/** Resolves legacy speed intent against a catalog the host now holds. Nothing is dropped: an
 *  unresolved Fast stays as intent, and an advertised tier is never rewritten. */
export function migrateCodexSessionSpeed(
  session: Pick<CodexSession, 'options'>,
  input: { models: readonly AgentSessionModelOption[]; currentModel: string | undefined }
): void {
  replaceCodexSessionOptions(
    session.options,
    normalizeCodexServiceTierOptions({
      priorOptions: Object.fromEntries(session.options),
      changes: {},
      origin: 'restore',
      models: input.models,
      ...(input.currentModel ? { currentModel: input.currentModel } : {}),
      catalogKnown: true
    })
  )
}

// ─── Speed evidence ─────────────────────────────────────────────────────────

/** What this session's host observed about its speed requests. Ephemeral and per child: it is
 *  never persisted, and a new acquisition starts with none. */
export type CodexSpeedEvidence = Pick<AgentSessionSpeedFacts, 'lastRequest' | 'applied'>

type CodexSpeedRequest = NonNullable<AgentSessionSpeedFacts['lastRequest']>

/** A new attempt replaces `lastRequest` only. `applied` moves on a positive answer to that request. */
export function recordCodexSpeedRequest(
  host: Pick<CodexSession, 'speedEvidence'>,
  request: Omit<CodexSpeedRequest, 'detail'> & { detail?: string | undefined }
): void {
  const { clientMessageId, tierId, turnId, state } = request
  const detail = request.detail ? providerDiagnostic(request.detail, 'person')?.text : undefined
  host.speedEvidence = {
    ...host.speedEvidence,
    lastRequest: {
      clientMessageId,
      tierId,
      state,
      ...(turnId ? { turnId } : {}),
      ...(detail ? { detail } : {})
    },
    ...(state === 'accepted'
      ? { applied: { clientMessageId, tierId, ...(turnId ? { turnId } : {}) } }
      : {})
  }
}

/** The selection facts plus the session's request evidence. Processing stays absent: no per-turn
 *  server report of the tier is read anywhere. */
export function codexSpeedFacts(
  selection: AgentSessionSpeedFacts,
  evidence: CodexSpeedEvidence | undefined
): AgentSessionSpeedFacts {
  return {
    ...selection,
    ...(evidence?.lastRequest ? { lastRequest: evidence.lastRequest } : {}),
    ...(evidence?.applied ? { applied: evidence.applied } : {})
  }
}

type CodexSpeedHost = Pick<CodexSession, 'options' | 'catalogAccess' | 'speedEvidence'> & {
  reportedOptions?: { model?: string }
}

/** The exact tier the next `turn/start` carries, validated against this session's own account
 *  catalog; undefined when the session never chose a speed. Throws before any write when the
 *  selection is unavailable or unverifiable, recording that refusal. */
export function admitCodexTurnSpeed(
  host: CodexSpeedHost,
  clientMessageId: string
): string | undefined {
  const catalog = codexSpeedCatalog(host.catalogAccess)
  const currentModel =
    host.options.get('model') ??
    host.reportedOptions?.model ??
    codexListingDefaultModel(catalog.models)
  try {
    return admitCodexServiceTierForTurn({
      options: Object.fromEntries(host.options),
      models: catalog.models,
      ...(currentModel ? { currentModel } : {}),
      catalogKnown: catalog.known
    })
  } catch (error) {
    if (error instanceof CodexServiceTierSelectionError && error.tierId) {
      recordCodexSpeedRequest(host, {
        clientMessageId,
        tierId: error.tierId,
        state: 'rejected',
        detail: error.message
      })
    }
    throw error
  }
}

/** Runs the `turn/start` write carrying `tierId`, recording what became of that exact request.
 *  A transport failure leaves it `sent`: delivery is unknown, never accepted or rejected. */
export async function trackCodexSpeedRequest<TAnswer>(
  host: Pick<CodexSession, 'speedEvidence'>,
  request: { clientMessageId: string; tierId: string | undefined },
  write: () => Promise<TAnswer>,
  turnIdOf: (answer: TAnswer) => string | null
): Promise<TAnswer> {
  const { clientMessageId, tierId } = request
  if (tierId === undefined) {
    return write()
  }
  recordCodexSpeedRequest(host, { clientMessageId, tierId, state: 'sent' })
  try {
    const answer = await write()
    recordCodexSpeedRequest(host, {
      clientMessageId,
      tierId,
      state: 'accepted',
      turnId: turnIdOf(answer) ?? undefined
    })
    return answer
  } catch (error) {
    if (isCodexAppServerRequestError(error) || isCodexAppServerUnsupportedError(error)) {
      const diagnostic = providerDiagnosticOf(error)
      recordCodexSpeedRequest(host, {
        clientMessageId,
        tierId,
        state: 'rejected',
        detail: diagnostic?.audience === 'person' ? diagnostic.text : undefined
      })
    }
    throw error
  }
}
