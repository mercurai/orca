import type { CodexSessionCatalogAccess } from './codex-structured-session-state'
import { CODEX_DEFAULT_SERVICE_TIER } from './codex-structured-service-tier'

export class CodexSpeedAdmissionError extends Error {
  constructor(readonly kind: 'speedSupportUnknown' | 'speedUnavailable') {
    super(kind)
    this.name = 'CodexSpeedAdmissionError'
  }
}

/** A requested paid tier needs the execution account's current catalog before a new turn. */
export function assertCodexSpeedAdmitted(host: {
  options: ReadonlyMap<string, string>
  reportedOptions?: { model?: string }
  catalogAccess?: CodexSessionCatalogAccess
}): void {
  const tier = host.options.get('serviceTier')
  if (tier === undefined || tier === CODEX_DEFAULT_SERVICE_TIER) {
    return
  }
  const access = host.catalogAccess
  const entry = access?.store.get(access.fingerprint)
  if (
    !access ||
    !entry ||
    access.store.isStale(entry, 'latest') ||
    access.store.hasActiveFailure(access.fingerprint)
  ) {
    throw new CodexSpeedAdmissionError('speedSupportUnknown')
  }
  const modelId = host.options.get('model') ?? host.reportedOptions?.model
  const model = entry.models.find((candidate) => candidate.id === modelId)
  if (!model || model.serviceTiers === undefined) {
    throw new CodexSpeedAdmissionError('speedSupportUnknown')
  }
  if (!model.serviceTiers.some((candidate) => candidate.value === tier)) {
    throw new CodexSpeedAdmissionError('speedUnavailable')
  }
}
