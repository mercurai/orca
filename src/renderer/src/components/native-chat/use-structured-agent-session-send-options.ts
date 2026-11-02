import { useCallback } from 'react'
import { translate } from '@/i18n/i18n'
import { CodexSpeedSelectionError } from '@/runtime/codex-speed-selection'
import type { StructuredAgentSessionSendControl } from '../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import {
  structuredAgentSessionMessageSelection,
  structuredAgentSessionSendSelection
} from '../../../../shared/agent-session/options/structured-agent-session-option-view'
import { getStructuredAgentSessionLaunchSelection } from '@/lib/agent-session/launch/structured-agent-session-launch-options'
import type { StructuredAgentSessionLaunchView } from './use-native-chat-provisional-launch'
import type { useStructuredAgentSessionOptionState } from './use-structured-agent-session-option-state'

/** What each send carries to a host that takes it: the chat's own model and effort, picks over them. */
export function useStructuredAgentSessionSendOptions(
  sessionId: string,
  launch: StructuredAgentSessionLaunchView | undefined,
  source: Pick<
    ReturnType<typeof useStructuredAgentSessionOptionState>,
    'optionStateRef' | 'optionView' | 'takesSendOptions' | 'takesSelection'
  > &
    Partial<Pick<ReturnType<typeof useStructuredAgentSessionOptionState>, 'controller'>>
): () => Pick<StructuredAgentSessionSendControl, 'options' | 'selection'> {
  const { optionStateRef, optionView, takesSendOptions, takesSelection, controller } = source
  return useCallback(() => {
    if (!takesSendOptions && !takesSelection) {
      // A host that takes no options cannot carry a speed still being changed; sending would
      // silently run the turn at the old speed.
      if (
        optionStateRef.current.record.agent === 'codex' &&
        (controller?.isPending('serviceTier') || controller?.isPending('fastMode'))
      ) {
        throw new CodexSpeedSelectionError(
          translate(
            'components.native-chat.composer.speedStatus.waitForChange',
            'Wait for the speed change to finish before sending, or update Orca on the execution host.'
          )
        )
      }
      return {}
    }
    // Read held picks directly because launch acceptance can precede this render’s props.
    const selection = getStructuredAgentSessionLaunchSelection(sessionId)
    // A pick on its way resolves as the picker shows it.
    const view = optionView(
      optionStateRef.current,
      selection?.seed ?? launch?.seedOptions,
      selection?.explicit ?? launch?.explicitOptions
    )
    return takesSelection
      ? { selection: structuredAgentSessionMessageSelection(view) }
      : { options: structuredAgentSessionSendSelection(view) }
  }, [controller, launch, optionStateRef, optionView, sessionId, takesSendOptions, takesSelection])
}
