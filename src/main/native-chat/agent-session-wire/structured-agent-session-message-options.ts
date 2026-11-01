import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionProviderChildIdentity } from './structured-agent-session-host-types'

const OPTION_ORDER = ['model', 'effort', 'serviceTier', 'personality'] as const

/** Changed or unconfirmed Codex choices need a new turn: steer has no option fields. */
export function waitsForCodexTurnOptions(
  record: Pick<AgentSessionRecord, 'provider' | 'sessionId'> | null,
  journal: Pick<AgentSessionJournal, 'newestTurn' | 'itemBody'>,
  next: Pick<AgentJournalSubmission, 'clientMessageId' | 'options'>,
  child: StructuredAgentSessionProviderChildIdentity,
  adapter?: Pick<StructuredAgentSessionAdapter, 'readAppliedInputOptions'>
): boolean {
  if (record?.provider !== 'codex') {
    return false
  }
  const body = journal.itemBody(agentJournalSubmissionKey(next.clientMessageId))
  if (body?.kind !== 'message' || body.command) {
    return false
  }
  const turn = journal.newestTurn()
  if (turn?.state !== 'running') {
    return false
  }
  const applied = adapter?.readAppliedInputOptions?.({
    sessionId: record.sessionId,
    fence: child.fence,
    acquisitionGeneration: child.generation,
    next: next.options
  })
  if (!applied) {
    return (
      next.options === undefined || Object.values(next.options).some((value) => value !== undefined)
    )
  }
  if (applied.next.serviceTier === undefined && applied.next.fastMode !== undefined) {
    // Legacy Fast remains unresolved until fresh model/account admission; it cannot steer.
    if (applied.next.fastMode === 'true' || applied.next.fastMode !== applied.active.fastMode) {
      return true
    }
  }
  return OPTION_ORDER.some(
    (key) => applied.next[key] !== undefined && applied.next[key] !== applied.active[key]
  )
}
