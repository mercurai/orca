import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
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
  agent?: string
  sessionId?: string
  worktree?: string
}

/** Read-only negotiation precedes fingerprints; callers freeze the returned payload for retries. */
export async function prepareCodexSpeedWireOptions(input: SpeedWireInput): Promise<{
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
    if (catalog.origin === 'unknown' || catalog.listingInProgress || catalog.unavailable) {
      return false
    }
    const model = input.options?.model
      ? catalog.models.find((row) => row.id === input.options?.model)
      : catalog.listingNamesConfiguredModel
        ? catalog.models.find((row) => row.isDefault)
        : undefined
    return model?.serviceTiers?.some((row) => row.value === tier &&
      (/^fast$/i.test(row.label.trim()) || /^fast$/i.test(row.value.trim()))) === true
  } catch {
    return false
  }
}
