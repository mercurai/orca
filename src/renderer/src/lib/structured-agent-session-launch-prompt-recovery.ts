import {
  recoverNativeChatComposerDraftMessages,
  structuredAgentSessionDraftScopeKey
} from '@/components/native-chat/native-chat-composer-draft-store'

export type StructuredLaunchPromptDraft = {
  clientMessageId: string
  text: string
}

/** A failed transaction leaves the launch record as the durable source for explicit Retry. */
export function recoverStructuredLaunchPromptDrafts(
  sessionId: string,
  drafts: readonly StructuredLaunchPromptDraft[]
): Promise<boolean> {
  return recoverNativeChatComposerDraftMessages(
    structuredAgentSessionDraftScopeKey(sessionId),
    drafts
  )
}
