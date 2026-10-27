import { describe, expect, it } from 'vitest'
import { agentSessionRefusalError } from '../../../../../../shared/agent-session-wire-refusals'
import { isUnknownWorkerStartOutcome } from './worker-topology'

describe('worker start outcome classification', () => {
  it('treats an explicit operation_unknown code as unknown at any stage', () => {
    const error = Object.assign(new Error('relay dropped'), { code: 'operation_unknown' })

    expect(isUnknownWorkerStartOutcome(error, 'dispatch_input')).toBe(true)
    expect(isUnknownWorkerStartOutcome(error, 'worktree_create')).toBe(true)
  })

  it('treats a typed post-attach operation-unknown refusal as unknown', () => {
    const error = agentSessionRefusalError(
      'agent_session_operation_unknown',
      { reason: 'tabUnconfirmed' },
      'The chat may have been created, but its tab could not be confirmed.'
    )

    expect(error).not.toHaveProperty('code')
    expect(isUnknownWorkerStartOutcome(error, 'dispatch_input')).toBe(true)
  })

  it('treats a lost connection during worktree create as unknown', () => {
    expect(isUnknownWorkerStartOutcome(new Error('connection reset'), 'worktree_create')).toBe(true)
    expect(isUnknownWorkerStartOutcome(new Error('request timed out'), 'worktree_create')).toBe(
      true
    )
  })

  it('keeps a definite failure definite', () => {
    expect(isUnknownWorkerStartOutcome(new Error('connection reset'), 'dispatch_input')).toBe(false)
    expect(isUnknownWorkerStartOutcome(new Error('worktree exists'), 'worktree_create')).toBe(false)
  })

  // Why: a stalled prompt still reports a definite failure to the caller — the correction path is
  // the worker's own report, which keeps its capability and can re-settle the dispatch (see
  // worker-start-unobserved-prompt-settlement.test.ts), not an outcome_unknown receipt.
  it('does not class a stalled dispatch prompt as unknown', () => {
    expect(isUnknownWorkerStartOutcome(new Error('agent_prompt_stalled'), 'dispatch_input')).toBe(
      false
    )
  })
})
