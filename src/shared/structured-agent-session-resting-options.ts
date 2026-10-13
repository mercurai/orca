// Provider-neutral inputs and results of an agent's optional `restingOptions` callbacks, which a
// structured-agent definition uses to normalize and read a session's stored options without a child.

import type { AgentSessionModelOption, AgentSessionOptionsResult } from './agent-session-wire'
import type { AgentSessionSpeedFacts } from './agent-session-speed-facts'

export type RestingOptionsOrigin = 'restore' | 'launch' | 'set-option'

/** Stored options: bounded encoded strings keyed by option id. */
export type RestingOptionsMap = Readonly<Record<string, string>>

export type RestingOptionsNormalizeInput = {
  priorOptions: RestingOptionsMap
  /** Keys the caller is changing; for `set-option` they identify the actual user action. */
  changes: RestingOptionsMap
  origin: RestingOptionsOrigin
  models: readonly AgentSessionModelOption[]
  currentModel?: string
  catalogKnown: boolean
}

export type RestingOptionsReadInput = {
  options: RestingOptionsMap
  models: readonly AgentSessionModelOption[]
  currentModel?: string
  catalogKnown: boolean
}

export type RestingOptionsReadResult = {
  current: AgentSessionOptionsResult['current']
  /** Absent for an agent with no speed facts to report. */
  speed?: AgentSessionSpeedFacts
}
