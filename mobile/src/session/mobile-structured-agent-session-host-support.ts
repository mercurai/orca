import type { CodexSpeedHostSupport } from '../../../src/shared/codex-service-tier-presentation'
import {
  AGENT_SESSION_CODEX_SERVICE_TIERS_RUNTIME_CAPABILITY,
  AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY,
  AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY,
  AGENT_SESSION_REPEATED_STOP_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'

/** Structured-session features the connected host advertised; null until the status probe answers. */
export type StructuredAgentSessionHostSupport = {
  promptCancel: boolean
  questionAnswers: boolean
  /** Mid-turn sends queue as host-held drafts; an older host keeps today's immediate path. */
  queuedMessages: boolean
  /** A /compact sent while the agent works waits as a card; an older host refuses it. */
  queuedCommands: boolean
  /** The host publishes every session's status on one stream. A host from before phones could
   *  read it refuses the call, which reads the same as its absence. */
  statusFeed: boolean
  /** A Stop that stopped nothing adds no row, so a repeated Stop is quiet. */
  quietRepeatedStop: boolean
  /** The host stores catalog speed tiers (Standard/Fast/custom). Absent reads as not advertised:
   *  an older host drops a canonical tier and keeps only the Fast toggle. */
  codexServiceTiers?: boolean
}

/** The speed capability from the one status probe: unknown until it answers, never a second probe. */
export function mobileCodexSpeedHostSupport(
  hostSupport: StructuredAgentSessionHostSupport | null
): CodexSpeedHostSupport {
  if (hostSupport === null) {
    return 'unknown'
  }
  return hostSupport.codexServiceTiers === true ? 'supported' : 'unsupported'
}

export function structuredAgentSessionHostSupport(
  capabilities: readonly string[]
): StructuredAgentSessionHostSupport {
  return {
    promptCancel: capabilities.includes(AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY),
    questionAnswers: capabilities.includes(AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY),
    queuedMessages: capabilities.includes(AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY),
    queuedCommands: capabilities.includes(AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY),
    statusFeed: capabilities.includes(AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY),
    quietRepeatedStop: capabilities.includes(AGENT_SESSION_REPEATED_STOP_RUNTIME_CAPABILITY),
    codexServiceTiers: capabilities.includes(AGENT_SESSION_CODEX_SERVICE_TIERS_RUNTIME_CAPABILITY)
  }
}
