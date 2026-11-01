// Agent modules declare definitions; the runtime registry owns shared lookup instead of agent-name branches.

import type { AgentSessionCapabilities } from '../../../shared/agent-session-capabilities'
import type { AgentSessionStoredAgent } from '../../../shared/agent-session/lifecycle/agent-session-stored-agent'
import type { AgentSessionSpeed } from '../../../shared/agent-session-speed'
import type {
  AgentSessionModelCatalogResult,
  AgentSessionModelOption
} from '../../../shared/agent-session-wire'

export type StructuredAgentDefinition = AgentSessionStoredAgent & {
  capabilities: AgentSessionCapabilities
  /** Absent means Orca never supplies this agent’s managed runtime. */
  managedRuntime?: () => boolean
  restingOptions: {
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
    /** Unpicked effort follows the model default, matching running-child reports. */
    effortDefaultsToModel: boolean
  }
}

/** Accounts represented by a single config directory. */
export type DirectoryAccountAgentDefinition = StructuredAgentDefinition & {
  accountHomeVariable: string
}
