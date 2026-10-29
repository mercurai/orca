import { toast } from 'sonner'
import type { StructuredLaunchOptionOutcome } from '@/lib/structured-agent-session-launch-options'
import { agentSessionWriteFailureText } from './agent-session-write-notice-text'

/** Only an accepted pick writes preferences; callers read their current view when it settles. */
export function settleNativeChatLaunchOptionPick(
  outcome: StructuredLaunchOptionOutcome,
  remember: (options: Readonly<Record<string, string>>) => void
): void {
  if (outcome.kind === 'refused') {
    toast.error(agentSessionWriteFailureText(outcome.failure, 'option'))
  } else if (outcome.kind === 'accepted') {
    remember(outcome.options)
  }
}
