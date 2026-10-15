import { toast } from 'sonner'
import { useCallback, useMemo } from 'react'
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

/** Admission of canonical speed tiers for one session's execution host, and the speed facts the
 *  picker captions. Only an affirmative capability lets a tier be held or sent; every other answer
 *  refuses it with the reason, and the older Fast toggle stays as it was. */
export function useStructuredAgentSessionSpeedGate(args: {
  target: RuntimeClientTarget
  codexSpeedHost: StructuredAgentSessionHostCapabilityState
  optionState: StructuredAgentSessionOptionState
  optionSnapshot: readonly SessionOptionDescriptor[]
  /** Requests the options owner's next read. */
  refreshOptions: () => void
}) {
  const { codexSpeedHost, optionSnapshot, optionState, refreshOptions, target } = args
  const { capabilityPhase, catalogPhase, optionsPhase, speed } = optionState
  const speedLines = useMemo(
    () =>
      codexSpeedLines(
        optionSnapshot.find((descriptor) => descriptor.id === CODEX_SERVICE_TIER_OPTION_ID),
        speed,
        { capabilityPhase, optionsPhase, catalogPhase }
      ),
    [capabilityPhase, catalogPhase, optionSnapshot, optionsPhase, speed]
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
   *  older one drops a canonical tier. The caller already owns the pending slot and generation, so
   *  `isCurrent` says whether the session, host or generation moved on while it asked; false then,
   *  or when the host does not affirm the capability (the caller releases the slot). */
  const admitSend = useCallback(
    async (id: string, isCurrent: () => boolean): Promise<boolean> => {
      if (id !== CODEX_SERVICE_TIER_OPTION_ID) {
        return true
      }
      const support = await readStructuredAgentSessionCodexSpeedSupport(target)
      if (!isCurrent()) {
        return false
      }
      if (support !== 'supported') {
        refuseSpeedWrite(support)
        return false
      }
      return true
    },
    [target]
  )
  /** After an accepted write: the host's own read replaces the committed guess, and its speed
   *  facts (the request it saw, what it applied) follow the write. The options owner runs that read
   *  (its phase, coalescing and generation guard); nothing is requested once the session, host or
   *  generation the write was made for is gone. */
  const refreshAfterWrite = useCallback(
    (isCurrent: () => boolean): void => {
      if (isCurrent()) {
        refreshOptions()
      }
    },
    [refreshOptions]
  )
  return { speedLines, admitPick, admitSend, refreshAfterWrite }
}
