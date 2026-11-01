import type { CodexSessionCatalogAccess } from './codex-structured-session-state'
import type { CodexAppliedSettings } from './codex-structured-applied-settings'
import {
  CODEX_DEFAULT_SERVICE_TIER,
  codexFastServiceTier,
  setCodexServiceTier
} from './codex-structured-service-tier'

export class CodexSpeedAdmissionError extends Error {
  constructor(readonly kind: 'speedSupportUnknown' | 'speedUnavailable') {
    super(kind)
    this.name = 'CodexSpeedAdmissionError'
  }
}

/** A requested non-Standard tier needs the execution account's current catalog before a new turn. */
export function assertCodexSpeedAdmitted(host: {
  options: Map<string, string>
  reportedOptions?: { model?: string }
  appliedTurnOptions?: Readonly<Record<string, string>>
  appliedSettings?: Pick<CodexAppliedSettings, 'knownModel'>
  catalogAccess?: CodexSessionCatalogAccess
}): void {
  const tier = host.options.get('serviceTier')
  const pendingFast = tier === undefined && host.options.get('fastMode') === 'true'
  if ((!pendingFast && tier === undefined) || tier === CODEX_DEFAULT_SERVICE_TIER) {
    return
  }
  const access = host.catalogAccess
  const entry = access?.read ? access.read(true) : access?.store.get(access.fingerprint)
  if (
    !access ||
    !entry ||
    access.store.isStale(entry, 'latest') ||
    access.store.hasActiveFailure(access.fingerprint) ||
    access.store.failure(access.fingerprint)?.unavailable
  ) {
    throw new CodexSpeedAdmissionError('speedSupportUnknown')
  }
  const knownModel = host.appliedSettings
    ? host.appliedSettings.knownModel()
    : host.appliedTurnOptions === undefined
      ? host.reportedOptions?.model
      : host.appliedTurnOptions.model
  const modelId = host.options.get('model') ?? knownModel
  const model = entry.models.find((candidate) => candidate.id === modelId)
  if (!model || model.serviceTiers === undefined) {
    throw new CodexSpeedAdmissionError('speedSupportUnknown')
  }
  const admittedTier = pendingFast ? codexFastServiceTier(model) : tier
  if (!admittedTier || !model.serviceTiers.some((candidate) => candidate.value === admittedTier)) {
    throw new CodexSpeedAdmissionError('speedUnavailable')
  }
  if (pendingFast) {
    setCodexServiceTier(host.options, admittedTier)
  }
}
