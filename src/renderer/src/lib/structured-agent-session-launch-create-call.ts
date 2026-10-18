import { CodexSpeedSelectionError, prepareCodexSpeedWireOptions } from '@/runtime/codex-speed-selection'
import { structuredAgentSessionCreateFingerprint } from '../../../shared/structured-agent-session-mutation'
import { notifyStructuredLaunchListeners } from './structured-agent-session-launch-registry'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'
import {
  isAgentSessionCreateAdmissionRefusal,
  isDefinitiveAgentSessionCreateRefusal
} from '../../../shared/agent-session-definitive-refusal'
import { readAgentSessionRefusalReference } from '../../../shared/agent-session-wire-refusals'
import { readAgentSessionErrorRefusal } from '../../../shared/agent-session-write-failure'
import {
  callStructuredAgentSession,
  supportsStructuredAgentSessionCreateMessage
} from '@/runtime/structured-agent-session-client'
import { publishStructuredAgentSessionCreateHydration } from './structured-agent-session-create-hydration'
import { askHostCreateSupport } from './structured-agent-session-host-admission'
import {
  abandonStructuredAgentSessionLaunchIntent,
  type StructuredAgentSessionLaunchIntent
} from './launch-structured-agent-session'
import type { StructuredAgentLaunchReceipt } from './structured-agent-session-launch-recovery'
import {
  StructuredAgentSessionCreateError,
  StructuredAgentSessionCreateAbandonedError,
  StructuredAgentSessionCreateRefusalError,
  StructuredAgentSessionCreateUnknownOutcomeError
} from './structured-agent-session-launch-errors'

type LaunchSeed = Readonly<Record<string, string>> | undefined
const DEFINITIVE_CREATE_FAILURE_CODES = [
  'structured_agent_session_unsupported',
  'method_not_found'
] as const

function definitiveStructuredAgentSessionCreateErrorCode(error: unknown): string | null {
  if (error instanceof StructuredAgentSessionCreateError) {
    // Our own classes already carry the verdict; message sniffing below could only invert it.
    return error instanceof StructuredAgentSessionCreateRefusalError &&
      isDefinitiveAgentSessionCreateRefusal(error.code)
      ? error.code
      : null
  }
  for (const code of DEFINITIVE_CREATE_FAILURE_CODES) {
    if (hasRuntimeRpcErrorCode(error, code)) {
      return code
    }
  }
  return null
}

/**
 * Only the host that will execute the session can answer whether it supports creating one there.
 * Both providers ask: the host classifies per agent, and Codex inherits the
 * unresolvable-selector retry above along with the probe. The unknown branch stays on the chat for
 * reconciliation: a retry may follow a create whose reply was lost. Answers the seed create will use.
 */
async function requireHostCreateSupport(
  intent: StructuredAgentSessionLaunchIntent
): Promise<LaunchSeed> {
  const support = await askHostCreateSupport(intent.target, intent.params.worktree, intent.agent)
  if (support.kind === 'unreachable') {
    throw new StructuredAgentSessionCreateUnknownOutcomeError(
      support.message,
      support.code,
      readAgentSessionErrorRefusal(support.error)
    )
  }
  if (support.kind === 'declined' || support.kind === 'workspace-unresolved') {
    abandonStructuredAgentSessionLaunchIntent(intent)
    throw new StructuredAgentSessionCreateRefusalError(
      'structured_agent_session_unsupported',
      'structured_agent_session_unsupported'
    )
  }
  return support.seedOptions
}

type PreparedSpeedOptions = Awaited<ReturnType<typeof prepareCodexSpeedWireOptions>>
const preparingCreates = new WeakMap<StructuredAgentSessionLaunchIntent, Promise<PreparedSpeedOptions>>()

function authorizeCreateSpeed(
  intent: StructuredAgentSessionLaunchIntent,
  options = intent.createCanonicalOptions ?? intent.params.options ?? intent.seedOptions
) {
  return prepareCodexSpeedWireOptions({
    target: intent.target,
    agent: intent.agent,
    worktree: intent.params.worktree,
    options,
    ...(intent.createPrepared ? { frozenOptions: intent.params.options } : {})
  })
}

async function prepareCreateWireOptions(
  intent: StructuredAgentSessionLaunchIntent
): Promise<PreparedSpeedOptions> {
  const pending = preparingCreates.get(intent)
  if (pending) {
    return pending
  }
  if (intent.createPrepared) {
    // A retry reauthorizes the selection but cannot reinterpret its frozen wire payload.
    const prepared = await authorizeCreateSpeed(intent)
    const original = intent.createSpeedAuthority
    if (
      (original?.expectedEnvironmentPairingRevision !== undefined &&
        original.expectedEnvironmentPairingRevision !== prepared.authority?.expectedEnvironmentPairingRevision) ||
      (original?.expectedEnvironmentRuntimeId !== undefined &&
        original.expectedEnvironmentRuntimeId !== prepared.authority?.expectedEnvironmentRuntimeId)
    ) {
      throw new CodexSpeedSelectionError('The execution host changed. Reconnect and retry the speed selection.')
    }
    return { ...prepared, authority: original ?? prepared.authority }
  }
  const prepare = (async () => {
    let supported = false
    try {
      supported = await supportsStructuredAgentSessionCreateMessage(intent.target)
    } catch {
      // Unknown first-message support retains the legacy prompt path.
    }
    const preparation = intent.prepareCreate?.()
    const staged = preparation?.params ?? intent.params
    const canonical = staged.options ?? intent.seedOptions
    const prepared = await authorizeCreateSpeed(intent, canonical)
    // No prompt ownership or persisted negotiation marker changes before authorization.
    intent.createMessageSupport = supported
    const committed = preparation?.commit?.() ?? staged
    if (canonical) {
      intent.createCanonicalOptions = { ...canonical }
    }
    intent.createSpeedAuthority = prepared.authority
    const { options: _priorOptions, ...fields } = committed
    const params = { ...fields, ...(prepared.options ? { options: prepared.options } : {}) }
    intent.params = {
      ...params,
      envelope: {
        ...params.envelope,
        payloadFingerprint: structuredAgentSessionCreateFingerprint({
          sessionId: intent.sessionId,
          ...params
        })
      }
    }
    intent.createPrepared = true
    notifyStructuredLaunchListeners()
    return prepared
  })()
  preparingCreates.set(intent, prepare)
  try {
    return await prepare
  } finally {
    preparingCreates.delete(intent)
  }
}

/** Told the seed a paired server says this create will use, which may differ from an earlier
 *  attempt's; a local launch reads its own settings instead. */
export type StructuredLaunchHostSeedListener = (seedOptions: LaunchSeed) => void

export async function launchStructuredAgentSession(
  intent: StructuredAgentSessionLaunchIntent,
  onHostSeed?: StructuredLaunchHostSeedListener,
  priorCreateOutcomeUnknown = false
): Promise<StructuredAgentLaunchReceipt> {
  const hostSeed = await requireHostCreateSupport(intent)
  if (intent.target.kind !== 'local') {
    onHostSeed?.(hostSeed)
  }
  const prepared = await prepareCreateWireOptions(intent)
  let result: AgentSessionMutationResult<AgentSessionAttachResult>
  if (intent.beforeCreate?.() === false) {
    abandonStructuredAgentSessionLaunchIntent(intent)
    throw new StructuredAgentSessionCreateAbandonedError(
      'Conversation source retired before create.'
    )
  }
  delete intent.beforeCreate
  try {
    result = await callStructuredAgentSession<AgentSessionMutationResult<AgentSessionAttachResult>>(
      intent.target,
      'agentSession.create',
      intent.params,
      prepared.authority
    )
  } catch (error) {
    const code = definitiveStructuredAgentSessionCreateErrorCode(error)
    if (code) {
      abandonStructuredAgentSessionLaunchIntent(intent)
      throw new StructuredAgentSessionCreateRefusalError(
        error instanceof Error ? error.message : String(error),
        code,
        readAgentSessionErrorRefusal(error)
      )
    }
    throw error
  }
  if (!result.ok) {
    const { code, message, ownerVerdict } = result.refusal
    const refusal = readAgentSessionRefusalReference(result.refusal)
    const attemptRefusedBeforeCommit =
      !priorCreateOutcomeUnknown &&
      result.refusal.createAttemptRefusedBeforeCommit === true &&
      refusal !== undefined &&
      isAgentSessionCreateAdmissionRefusal(refusal)
    // Attempt proof cannot settle an earlier create whose reply was lost.
    if (
      !attemptRefusedBeforeCommit &&
      !isDefinitiveAgentSessionCreateRefusal(code) &&
      ownerVerdict !== 'exited'
    ) {
      // Keep the focus intent: the session may exist, and recovery still has to adopt it.
      throw new StructuredAgentSessionCreateUnknownOutcomeError(message, code, refusal)
    }
    abandonStructuredAgentSessionLaunchIntent(intent)
    throw new StructuredAgentSessionCreateRefusalError(message, code, refusal)
  }
  const firstMessage = intent.params.firstMessage
    ? (result.value.firstMessage ??
      result.value.page.submissions.find(
        (submission) => submission.clientMessageId === intent.params.firstMessage?.clientMessageId
      ))
    : undefined
  if (
    intent.params.firstMessage &&
    firstMessage?.clientMessageId !== intent.params.firstMessage.clientMessageId
  ) {
    throw new StructuredAgentSessionCreateUnknownOutcomeError(
      'The created chat did not confirm its first message.',
      'agent_session_operation_unknown'
    )
  }
  if (intent.createMessageSupport === true) {
    publishStructuredAgentSessionCreateHydration(intent, result.value.page, result.value.fence)
  }
  return {
    sessionId: result.value.sessionId,
    fence: result.value.fence,
    ...(firstMessage ? { firstMessage, cursor: result.cursor } : {})
  }
}
