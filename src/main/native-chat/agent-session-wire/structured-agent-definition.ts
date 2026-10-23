// What the host knows about a structured agent before any session of it runs.
//
// Each agent's own module declares its definition, and runtime composition registers it with the
// agent's adapter in one StructuredAgentRegistry. That registry is the only lookup: the router and
// shared host code read a definition through it and never branch on the agent's name.

import type { AgentSessionCapabilities } from '../../../shared/agent-session-capabilities'
import type { AgentSessionStoredAgent } from '../../../shared/agent-session/lifecycle/agent-session-stored-agent'
import type { AgentSessionSpeed } from '../../../shared/agent-session-speed'
import type {
  AgentSessionModelCatalogResult,
  AgentSessionModelOption
} from '../../../shared/agent-session-wire'

/** `agent` names the Orca agent whose sessions this describes; the storage fields bound its records. */
export type StructuredAgentDefinition = AgentSessionStoredAgent & {
  capabilities: AgentSessionCapabilities
  /** Whether Orca provides this agent's chat program on this host; absent when it never does. */
  managedRuntime?: () => boolean
  /** How a session's options read and change while no child runs. */
  restingOptions: {
    /** Whether the agent takes a pick of this option key. */
    acceptsKey: (key: string) => boolean
    /** A new explicit pick may replace older intent; null refuses it without persistence. */
    normalizePick?: (
      saved: Readonly<Record<string, string>>,
      pick: { key: string; value: string }
    ) => Readonly<Record<string, string>> | null
    /** Catalog-backed next-turn facts; no child is acquired to produce them. */
    readSpeed?: (input: {
      saved: Readonly<Record<string, string>>
      currentModel?: string
      catalog: AgentSessionModelCatalogResult
    }) => AgentSessionSpeed
    /** The models a running child falls back to with no catalog; null when it has none. */
    fallbackModels: () => AgentSessionModelOption[] | null
    /** An unpicked effort reads as the model's default effort, as a running child reports it. */
    effortDefaultsToModel: boolean
  }
}

/** An agent whose account is one config directory, as Claude's and Codex's are. */
export type DirectoryAccountAgentDefinition = StructuredAgentDefinition & {
  accountHomeVariable: string
}
