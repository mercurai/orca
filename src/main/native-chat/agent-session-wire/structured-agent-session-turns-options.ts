import { refuse, type AgentSessionOptionResult } from '../../../shared/agent-session-wire'
import {
  isAgentSessionOptionRejectedError,
  recordedRefusalOptions
} from './structured-agent-session-option-error'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

/** Persists a settled option map. A rejection first lets the adapter put its live state back, then
 *  rethrows the storage failure itself, so nothing is published for a write that did not land. */
async function persistSettledOptions(
  ctx: AgentSessionTurnContext,
  input: { key: string; value: string },
  priorOptions: Readonly<Record<string, string>>,
  options: Readonly<Record<string, string>>
): Promise<void> {
  try {
    await ctx.persistOptions(options)
  } catch (persistFailure) {
    try {
      ctx.adapter.recoverFailedOptionPersistence?.({
        sessionId: ctx.sessionId,
        fence: ctx.fence,
        ...input,
        priorOptions
      })
    } catch (recoveryFailure) {
      ctx.logger.warn('restoring the live options after a failed save failed', {
        scope: 'option-persistence-recovery',
        sessionId: ctx.sessionId,
        error: recoveryFailure
      })
    }
    throw persistFailure
  }
}

export async function performSetOption(
  ctx: AgentSessionTurnContext,
  input: { key: string; value: string },
  signal?: AbortSignal
): Promise<TurnOutcome<AgentSessionOptionResult>> {
  // A copy, taken before the adapter changes anything: recovery needs the record as it stood.
  const priorOptions = { ...ctx.persistedOptions }
  let applied: void | Readonly<Record<string, string>>
  try {
    applied = await ctx.adapter.setOption({
      sessionId: ctx.sessionId,
      ...input,
      fence: ctx.fence,
      priorOptions,
      ...(signal ? { signal } : {})
    })
  } catch (error) {
    if (isAgentSessionOptionRejectedError(error)) {
      const refusalOptions = recordedRefusalOptions(error)
      if (refusalOptions) {
        // A persistence failure propagates from here, so nothing is published for it.
        await persistSettledOptions(ctx, input, priorOptions, refusalOptions)
        ctx.publish()
      }
      return {
        ok: false,
        refusal: refuse(
          'agent_session_operation_invalid',
          { reason: error.refusalReason },
          error.message
        )
      }
    }
    throw error
  }
  await persistSettledOptions(ctx, input, priorOptions, applied ?? { [input.key]: input.value })
  ctx.publish()
  return { ok: true, value: { ...input, ...(applied ? { options: { ...applied } } : {}) } }
}
