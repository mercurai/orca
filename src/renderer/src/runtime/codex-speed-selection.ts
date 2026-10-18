import { AGENT_MODEL_CATALOG_FRESH_MS } from '../../../shared/agent-model-catalog-freshness'
import type { AgentSessionModelCatalogResult, AgentSessionOptionsResult } from '../../../shared/agent-session-wire'
import { CODEX_SPEED_SELECTION_RUNTIME_CAPABILITY } from '../../../shared/agent-session-create-capabilities'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { captureRuntimeEnvironmentRequestRevision } from './runtime-environment-revision'
import { callRuntimeRpc } from './runtime-rpc-client'

export class CodexSpeedSelectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexSpeedSelectionError'
  }
}

export type CodexSpeedWireAuthority = {
  expectedEnvironmentPairingRevision?: number
  expectedEnvironmentRuntimeId?: string
}

type SpeedWireInput = {
  target: RuntimeClientTarget
  options: Readonly<Record<string, string>> | undefined
  frozenOptions?: Readonly<Record<string, string>>
  agent?: string
  sessionId?: string
  worktree?: string
}

/** Reauthorize immutable retries independently from the host's preferred wire representation. */
export async function prepareCodexSpeedWireOptions(input: SpeedWireInput) {
  const prepared = await prepareCurrentCodexSpeedWireOptions(input)
  const frozen = input.frozenOptions
  const tier = input.options?.serviceTier
  if (!frozen || tier === undefined) {
    return prepared
  }
  const canonicalStillAccepted = frozen.serviceTier !== undefined &&
    frozen.serviceTier === prepared.options?.serviceTier
  const standardStillSafe = frozen.fastMode === 'false' && tier === 'default'
  const fastStillExact = frozen.fastMode === 'true' &&
    await verifiedLegacyFastTier(input, tier, prepared.authority ?? {})
  if (!canonicalStillAccepted && !standardStillSafe && !fastStillExact) {
    throw new CodexSpeedSelectionError(
      'The pending speed request cannot be replayed safely. Refresh the speed choices and retry.'
    )
  }
  return { ...prepared, options: frozen }
}

/** Read-only negotiation precedes fingerprints; callers freeze the returned payload for retries. */
async function prepareCurrentCodexSpeedWireOptions(input: SpeedWireInput): Promise<{
  options: Readonly<Record<string, string>> | undefined
  authority?: CodexSpeedWireAuthority
}> {
  const tier = input.options?.serviceTier
  if (tier === undefined || (input.agent !== undefined && input.agent !== 'codex')) {
    return { options: input.options }
  }
  const authority: CodexSpeedWireAuthority = input.target.kind === 'environment'
    ? { expectedEnvironmentPairingRevision: captureRuntimeEnvironmentRequestRevision(input.target.environmentId) }
    : {}
  let status: RuntimeStatus
  try {
    // Fresh per action: a reconnect or an account/model change cannot inherit a cached verdict.
    status = await callRuntimeRpc<RuntimeStatus>(input.target, 'status.get', undefined, authority)
  } catch {
    throw new CodexSpeedSelectionError(
      'Speed support is unknown. Reconnect to the execution host and retry your selection.'
    )
  }
  if (input.target.kind === 'environment') {
    authority.expectedEnvironmentRuntimeId = status.runtimeId
  }
  if (status.capabilities?.includes(CODEX_SPEED_SELECTION_RUNTIME_CAPABILITY)) {
    return { options: input.options, authority }
  }
  let fastMode: string
  if (tier === 'default') {
    fastMode = 'false'
  } else {
    const verified = await verifiedLegacyFastTier(input, tier, authority)
    if (!verified) {
      throw new CodexSpeedSelectionError(
        'This execution host cannot safely apply the selected speed. Update Orca on that host or choose Standard.'
      )
    }
    fastMode = 'true'
  }
  const { serviceTier: _tier, ...rest } = input.options ?? {}
  return { options: { ...rest, fastMode }, authority }
}

async function verifiedLegacyFastTier(
  input: SpeedWireInput,
  tier: string,
  authority: CodexSpeedWireAuthority
): Promise<boolean> {
  if (!input.sessionId && !input.worktree) {
    return false
  }
  try {
    const catalog = await callRuntimeRpc<AgentSessionModelCatalogResult>(
      input.target,
      'agentSession.modelCatalog',
      {
        agent: 'codex',
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.worktree ? { worktree: input.worktree } : {})
      },
      authority
    )
    if (catalog.origin === 'unknown' || catalog.listingInProgress || catalog.unavailable ||
      !Number.isFinite(catalog.fetchedAt) || catalog.fetchedAt > Date.now() ||
      Date.now() - catalog.fetchedAt >= AGENT_MODEL_CATALOG_FRESH_MS) {
      return false
    }
    let modelId = input.options?.model
    if (!modelId && input.sessionId) {
      const session = await callRuntimeRpc<AgentSessionOptionsResult>(input.target, 'agentSession.options',
        { sessionId: input.sessionId }, authority)
      modelId = session.current.model
    }
    const model = modelId
      ? catalog.models.find((row) => row.id === modelId)
      : !input.sessionId && catalog.listingNamesConfiguredModel
        ? catalog.models.find((row) => row.isDefault)
        : undefined
    return model?.serviceTiers?.some((row) => row.value === tier &&
      (/^fast$/i.test(row.label.trim()) || /^fast$/i.test(row.value.trim()))) === true
  } catch {
    return false
  }
}
