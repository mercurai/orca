import { toast } from 'sonner'
import { useCallback, useMemo, type MutableRefObject } from 'react'
import { CODEX_SERVICE_TIER_OPTION_ID } from '../../../../shared/codex-service-tier-presentation'
import { codexSpeedLines } from '../../../../shared/codex-speed-facts-presentation'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import type { StructuredAgentSessionOptionState } from '../../../../shared/structured-agent-session-options'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { readStructuredAgentSessionCodexSpeedSupport } from '@/runtime/structured-agent-session-client'
import type { StructuredAgentSessionHostCapabilityState } from '@/runtime/structured-agent-session-host-capability'
import { nativeChatSpeedHostRefusalText } from './native-chat-session-option-labels'

function refuseSpeedWrite(support: StructuredAgentSessionHostCapabilityState): void {
  toast.error(nativeChatSpeedHostRefusalText(support))
}

/** Admission of canonical speed tiers for one session's execution host. Only an affirmative
 *  capability lets a tier be held or sent; every other answer refuses it with the reason, and
 *  the older Fast toggle stays as it was. */
export function useStructuredAgentSessionSpeedGate(args: {
  target: RuntimeClientTarget
  codexSpeedHost: StructuredAgentSessionHostCapabilityState
  optionState: StructuredAgentSessionOptionState
  optionStateRef: MutableRefObject<StructuredAgentSessionOptionState>
  pendingOptionRef: MutableRefObject<string | null>
  optionSnapshot: readonly SessionOptionDescriptor[]
}) {
  const { codexSpeedHost, optionSnapshot, optionState, optionStateRef, pendingOptionRef, target } =
    args
  const speedLines = useMemo(
    () =>
      codexSpeedLines(
        optionSnapshot.find((descriptor) => descriptor.id === CODEX_SERVICE_TIER_OPTION_ID),
        optionState.speed
      ),
    [optionSnapshot, optionState.speed]
  )
  /** Before a pick is held or dispatched, from the last answer this render has. */
  const admitPick = useCallback(
    (id: string): boolean => {
      if (id !== CODEX_SERVICE_TIER_OPTION_ID || codexSpeedHost === 'supported') {
        return true
      }
      refuseSpeedWrite(codexSpeedHost)
      return false
    },
    [codexSpeedHost]
  )
  /** Immediately before the write: the host may have changed since the pick was admitted, and an
   *  older one drops a canonical tier. Holds the pending slot while it asks; false when the session
   *  moved on meanwhile or the host does not affirm the capability. */
  const admitSend = useCallback(
    async (id: string): Promise<boolean> => {
      if (id !== CODEX_SERVICE_TIER_OPTION_ID) {
        return true
      }
      const admittedRecord = optionStateRef.current.record
      pendingOptionRef.current = id
      const support = await readStructuredAgentSessionCodexSpeedSupport(target)
      if (optionStateRef.current.record !== admittedRecord) {
        return false
      }
      if (support !== 'supported') {
        pendingOptionRef.current = null
        refuseSpeedWrite(support)
        return false
      }
      return true
    },
    [optionStateRef, pendingOptionRef, target]
  )
  return { speedLines, admitPick, admitSend }
}
