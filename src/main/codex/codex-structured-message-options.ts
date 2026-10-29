import { pickedSkillsInText } from '../../shared/structured-agent-session-send-mutation'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import type { CodexTurnHost } from './codex-structured-turn-start'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { StructuredAgentSessionInputNotAdmitted } from '../native-chat/agent-session-wire/structured-agent-session-input-admission'
import { agentSessionFailureFact } from '../../shared/agent-session-failure'
import { codexDispatchRejection } from './codex-structured-turn-end-settlement'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AgentSessionExecutionOptions } from '../../shared/agent-session-execution-options'
import type { CodexSession } from './codex-structured-session-state'

/** Allowlist turn overrides so saved options cannot replace the thread's permission policy. */
const CODEX_TURN_OPTION_KEYS = new Set(['model', 'effort', 'personality', 'serviceTier'])

export function isCodexTurnOptionKey(key: string): boolean {
  return CODEX_TURN_OPTION_KEYS.has(key)
}

export function resolvedCodexGoalSettings(
  _session: CodexSession,
  choices: AgentSessionExecutionOptions = {}
) {
  return {
    ...(choices.model !== undefined ? { model: choices.model } : {}),
    ...(choices.effort !== undefined ? { effort: choices.effort } : {})
  }
}

function capturedCodexMessageOptions(
  choices: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const captured: Record<string, string> = {}
  for (const key of ['model', 'effort', 'personality', 'serviceTier'] as const) {
    if (choices[key] !== undefined) {
      captured[key] = choices[key]
    }
  }
  if (choices.serviceTier === undefined && choices.fastMode !== undefined) {
    if (choices.fastMode === 'false') {
      captured.serviceTier = 'default'
    } else if (choices.fastMode === 'true') {
      captured.fastMode = 'true'
    } else {
      throw new Error('codex fast mode must be encoded as true or false')
    }
  }
  return captured
}

/** Omitted captured fields inherit the native thread's current values. */
export async function resolvedCodexMessageOptions(
  _session: CodexSession,
  choices: AgentSessionExecutionOptions | undefined
): Promise<Readonly<Record<string, string>> | undefined> {
  return choices === undefined ? undefined : capturedCodexMessageOptions(choices)
}

/** Compare the active turn with the next captured intent. */
export function readCodexAppliedInputOptions(
  session: CodexSession | undefined,
  input: Parameters<NonNullable<StructuredAgentSessionAdapter['readAppliedInputOptions']>>[0]
): ReturnType<NonNullable<StructuredAgentSessionAdapter['readAppliedInputOptions']>> {
  if (!session || session.ended || session.connection.closed || session.fence !== input.fence ||
      session.acquisitionGeneration !== input.acquisitionGeneration || !session.appliedTurnOptions) {
    return null
  }
  const active = session.appliedTurnOptions
  const next = capturedCodexMessageOptions(input.next ?? Object.fromEntries(session.options))
  const projected = { ...active, ...next }
  if (next.fastMode !== undefined && next.serviceTier === undefined) {
    delete projected.serviceTier
  } else if (next.serviceTier !== undefined) {
    delete projected.fastMode
  }
  return { active, next: projected }
}

/** Check the live binding after options settle and again whenever the provider is about to write. */
export async function prepareCodexMessageDispatch(
  session: CodexSession,
  input: Parameters<StructuredAgentSessionAdapter['dispatch']>[0],
  registered: () => boolean
) {
  const checkAbort = () => {
    if (input.signal?.aborted) {
      throw new StructuredAgentSessionInputNotAdmitted({
        state: 'rejected',
        ...codexDispatchRejection(
          agentSessionFailureFact(session.ended ? 'providerExited' : 'cancelled')
        )
      })
    }
  }
  await input.beforeDispatch?.()
  checkAbort()
  input.onInputPreparation?.()
  const turnOptions = await waitForPromiseWithSignal(
    resolvedCodexMessageOptions(session, input.executionOptions),
    input.signal
  ).catch((error: unknown) => {
    checkAbort()
    throw error
  })
  checkAbort()
  return {
    ...input,
    turnOptions,
    isCurrent: () =>
      registered() &&
      !session.ended &&
      session.fence === input.fence &&
      input.isCurrent?.() !== false
  }
}

export function turnInputFor(
  host: CodexTurnHost,
  body: AgentJournalMessageItem
): Record<string, unknown>[] {
  const input: Record<string, unknown>[] = []
  let text = ''
  for (const block of body.blocks as NativeChatBlock[]) {
    if (block.type === 'text' && block.text.length > 0) {
      input.push({ type: 'text', text: block.text })
      text += `${block.text}\n`
    } else if (block.type === 'image-ref' && block.path) {
      input.push({ type: 'localImage', path: block.path })
    } else if (block.type === 'image-ref' && block.url) {
      input.push({ type: 'image', url: block.url })
    }
  }
  // Unknown skill paths suppress plain $name resolution, so send only loaded files when known.
  for (const skill of pickedSkillsInText(text, body.skills ?? [])) {
    if (host.skillReport?.hasSkillPath(skill.path) !== false) {
      input.push({ type: 'skill', name: skill.name, path: skill.path })
    }
  }
  return input
}
