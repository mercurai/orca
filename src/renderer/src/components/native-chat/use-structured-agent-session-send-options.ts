import { useCallback } from 'react'
import { translate } from '@/i18n/i18n'
import { CodexSpeedSelectionError } from '@/runtime/codex-speed-selection'
import { structuredAgentSessionOptionSnapshot } from '../../../../shared/structured-agent-session-options'
import { structuredAgentSessionSendSelection } from '../../../../shared/structured-agent-session-option-view'
import { getStructuredAgentSessionLaunchSelection } from '@/lib/structured-agent-session-launch-options'
import type { StructuredAgentSessionLaunchView } from './use-native-chat-provisional-launch'
import type { useStructuredAgentSessionOptionState } from './use-structured-agent-session-option-state'

/** What each send carries to a host that takes it: the model and effort the composer shows now. */
export function useStructuredAgentSessionSendOptions(
  sessionId: string,
  launch: StructuredAgentSessionLaunchView | undefined,
  source: Pick<
    ReturnType<typeof useStructuredAgentSessionOptionState>,
    'optionStateRef' | 'pendingOptionsRef' | 'optionView' | 'takesSendOptions'
  >
): () => Readonly<Record<string, string>> | undefined {
  const { optionStateRef, optionView, pendingOptionsRef, takesSendOptions } = source
  return useCallback(() => {
    // Read, not rendered: a pick the launch just took is not in this render's props yet.
    const selection = getStructuredAgentSessionLaunchSelection(sessionId)
    const held = { ...(selection?.held ?? launch?.heldOptions), ...pendingOptionsRef.current }
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
    // A pick on its way resolves as the picker shows it, so a gone model it names is replaced too.
    const view = optionView(optionStateRef.current, selection?.seed ?? launch?.seedOptions, held)
    return structuredAgentSessionSendSelection(
      view.record.agent,
      structuredAgentSessionOptionSnapshot(view)
    )
  }, [launch, optionStateRef, optionView, pendingOptionsRef, sessionId, takesSendOptions])
}
