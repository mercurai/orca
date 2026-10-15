import type { AgentSessionRefusalReference } from '../../../shared/agent-session-wire-refusals'
import type { AgentSessionWriteFailure } from '../../../shared/agent-session-write-failure'

/** `host-update-needed`: the host says it cannot take the speed. `host-unreachable`: it could not
 *  say. `refused`: it answered the speed write with a refusal. `unconfirmed`: nothing proves the
 *  write landed. */
export const STRUCTURED_LAUNCH_SPEED_BLOCK_REASONS = [
  'host-update-needed',
  'host-unreachable',
  'refused',
  'unconfirmed'
] as const

export type StructuredLaunchSpeedBlockReason =
  (typeof STRUCTURED_LAUNCH_SPEED_BLOCK_REASONS)[number]

/** Why a chosen Codex speed holds a launch back. The tier stays exactly as chosen: no other speed
 *  stands in for it. */
export type StructuredLaunchSpeedBlock = {
  tierId: string
  reason: StructuredLaunchSpeedBlockReason
  /** The host's answer behind a refusal; kept in memory only. */
  failure?: AgentSessionWriteFailure
}

export class StructuredAgentSessionCreateError extends Error {
  constructor(
    message: string,
    /** The wire refusal code, or the RPC error code when the create never reached a handler. */
    readonly code: string,
    /** The host's refusal as a reader may word it; absent from an older host or a local failure. */
    readonly refusal?: AgentSessionRefusalReference
  ) {
    super(message)
  }
}

/**
 * The host proved it created nothing. The class itself is the verdict:
 * `launchStructuredAgentSession` is the only place that decides it against the shared allowlist.
 */
export class StructuredAgentSessionCreateRefusalError extends StructuredAgentSessionCreateError {
  constructor(
    message: string,
    code: string = 'structured_agent_session_unsupported',
    refusal?: AgentSessionRefusalReference
  ) {
    super(message, code, refusal)
    this.name = 'StructuredAgentSessionCreateRefusalError'
  }
}

/**
 * Refused with a code that does not prove the session is absent. A sibling opened here would sit
 * beside a session the host may already hold, so this deliberately is NOT a refusal error: it flows
 * down the same path as a lost reply, which replays the intent and reconciles.
 */
export class StructuredAgentSessionCreateUnknownOutcomeError extends StructuredAgentSessionCreateError {
  constructor(message: string, code: string, refusal?: AgentSessionRefusalReference) {
    super(message, code, refusal)
    this.name = 'StructuredAgentSessionCreateUnknownOutcomeError'
  }
}

/**
 * Raised before create is sent: the host says it cannot take the speed the saved defaults chose, so
 * nothing exists to adopt. A speed refused after create is never this class; that chat exists.
 */
export class StructuredAgentSessionSpeedHostUnsupportedError extends StructuredAgentSessionCreateRefusalError {
  constructor(readonly block: StructuredLaunchSpeedBlock) {
    super('Codex speed selection needs a host update', 'codex_service_tiers_unsupported')
    this.name = 'StructuredAgentSessionSpeedHostUnsupportedError'
  }
}

/** Raised before create is sent: the host could not say whether it takes the chosen speed. Like an
 *  unreachable create probe it proves nothing, so a retry replays and reconciles. */
export class StructuredAgentSessionSpeedHostUnknownError extends StructuredAgentSessionCreateUnknownOutcomeError {
  constructor(readonly block: StructuredLaunchSpeedBlock) {
    super('Codex speed support could not be confirmed on the host', 'codex_service_tiers_unknown')
    this.name = 'StructuredAgentSessionSpeedHostUnknownError'
  }
}

/** Orca cannot name the one host that owns the workspace, so no chat is started anywhere. */
export class StructuredAgentSessionOwnerUnresolvedError extends Error {
  constructor(worktreeId: string) {
    super(`No single runtime owns workspace ${worktreeId}`)
    this.name = 'StructuredAgentSessionOwnerUnresolvedError'
  }
}
