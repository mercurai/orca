// What the host knows about a structured agent before any session of it runs.
//
// Each agent's own module declares its definition, and runtime composition registers it with the
// agent's adapter in one StructuredAgentRegistry. That registry is the only lookup: the router and
// shared host code read a definition through it and never branch on the agent's name.

import type { AgentSessionCapabilities } from '../../../shared/agent-session-capabilities'
import type { AgentSessionStoredAgent } from '../../../shared/agent-session-stored-agent'
import type { AgentSessionModelOption } from '../../../shared/agent-session-wire'
import type {
  RestingOptionsNormalizeInput,
  RestingOptionsReadInput,
  RestingOptionsReadResult
} from '../../../shared/structured-agent-session-resting-options'

export type {
  RestingOptionsMap,
  RestingOptionsNormalizeInput,
  RestingOptionsOrigin,
  RestingOptionsReadInput,
  RestingOptionsReadResult
} from '../../../shared/structured-agent-session-resting-options'

/** `agent` names the Orca agent whose sessions this describes; the storage fields bound its records. */
export type StructuredAgentDefinition = AgentSessionStoredAgent & {
  capabilities: AgentSessionCapabilities
  /** How a session's options read and change while no child runs. */
  restingOptions: {
    /** Whether the agent takes a pick of this option key. */
    acceptsKey: (key: string) => boolean
    /** The models a running child falls back to with no catalog; null when it has none. */
    fallbackModels: () => AgentSessionModelOption[] | null
    /** An unpicked effort reads as the model's default effort, as a running child reports it. */
    effortDefaultsToModel: boolean
    /** The complete option map to persist for a restore, launch seed or option write, applying the
     *  agent's own invariants. Throws for an explicit write the agent cannot accept; absent when
     *  the agent keeps options as given. */
    normalizeOptions?: (input: RestingOptionsNormalizeInput) => Record<string, string>
    /** Canonical decoded values, plus speed facts where the agent reports any; absent when it has none. */
    readOptions?: (input: RestingOptionsReadInput) => RestingOptionsReadResult
  }
}

/** An agent whose account is one config directory, as Claude's and Codex's are. */
export type DirectoryAccountAgentDefinition = StructuredAgentDefinition & {
  accountHomeVariable: string
}
