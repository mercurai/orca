import { structuredLaunchRequestedOptions } from '../../../../shared/native-chat/input/native-chat-session-option-defaults'
import { useCallback } from 'react'
import { translate } from '@/i18n/i18n'
import { CodexSpeedSelectionError } from '@/runtime/codex-speed-selection'
import { structuredAgentSessionSendSelection } from '../../../../shared/structured-agent-session-option-view'
import { getStructuredAgentSessionLaunchSelection } from '@/lib/structured-agent-session-launch-options'
import type { StructuredAgentSessionLaunchView } from './use-native-chat-provisional-launch'
import type { useStructuredAgentSessionOptionState } from './use-structured-agent-session-option-state'

/** What each send carries to a host that takes it: the chat's own model and effort, picks over them. */
export function useStructuredAgentSessionSendOptions(
  sessionId: string,
  launch: StructuredAgentSessionLaunchView | undefined,
  source: Pick<
    ReturnType<typeof useStructuredAgentSessionOptionState>,
    'optionStateRef' | 'optionPicks' | 'optionView' | 'takesSendOptions'
  >
): () => Readonly<Record<string, string>> | undefined {
  const { optionStateRef, optionView, optionPicks, takesSendOptions } = source
  return useCallback(() => {
    // Read held picks directly because launch acceptance can precede this render’s props.
    const selection = getStructuredAgentSessionLaunchSelection(sessionId)
    const pending = optionPicks.current.pending
    const held = { ...(selection?.held ?? launch?.heldOptions), ...pending }
    if (optionStateRef.current.record.agent === 'codex') {
      if (pending.serviceTier !== undefined) {
        delete held.fastMode
      } else if (pending.fastMode !== undefined) {
        delete held.serviceTier
      }
    }
    if (!takesSendOptions) {
      if (
        optionStateRef.current.record.agent === 'codex' &&
        (held.serviceTier !== undefined || held.fastMode !== undefined)
      ) {
        throw new CodexSpeedSelectionError(
          translate(
            'components.native-chat.composer.speedStatus.waitForChange',
            'Wait for the speed change to finish before sending, or update Orca on the execution host.'
          )
        )
      }
      return undefined
    }
    const requested = structuredLaunchRequestedOptions({
      seed: selection?.seed ?? launch?.seedOptions,
      explicit: selection?.explicit ?? launch?.explicitOptions,
      held
    })
    if (requested?.model !== undefined) {
      return requested
    }
    // A pick on its way resolves as the picker shows it, keeping the model it names.
    const view = optionView(
      optionStateRef.current,
      selection?.seed ?? launch?.seedOptions,
      held,
      selection?.explicit ?? launch?.explicitOptions
    )
    return structuredAgentSessionSendSelection(view)
  }, [launch, optionStateRef, optionView, optionPicks, sessionId, takesSendOptions])
}
