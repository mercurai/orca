import { toast } from 'sonner'
import { useCallback, useMemo, type MutableRefObject } from 'react'
import type { AgentSessionOptionsResult } from '../../../../shared/agent-session-wire'
import type { AgentSessionOptionCatalog } from '../../../../shared/agent-session-option-catalog'
import { CODEX_SERVICE_TIER_OPTION_ID } from '../../../../shared/codex-service-tier-presentation'
import { codexSpeedLines } from '../../../../shared/codex-speed-facts-presentation'
import type { NativeChatSessionOptionRecord } from '../../../../shared/native-chat-session-option-state'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import {
  applyStructuredAgentSessionOptions,
  type StructuredAgentSessionOptionState
} from '../../../../shared/structured-agent-session-options'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  callStructuredAgentSession,
  readStructuredAgentSessionCodexSpeedSupport
} from '@/runtime/structured-agent-session-client'
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
  sessionId: string
  optionCatalog: AgentSessionOptionCatalog | null
  codexSpeedHost: StructuredAgentSessionHostCapabilityState
  optionState: StructuredAgentSessionOptionState
  optionStateRef: MutableRefObject<StructuredAgentSessionOptionState>
  pendingOptionRef: MutableRefObject<string | null>
  optionSnapshot: readonly SessionOptionDescriptor[]
  updateOptionState: (
    update: (current: StructuredAgentSessionOptionState) => StructuredAgentSessionOptionState
  ) => void
}) {
  const {
    codexSpeedHost,
    optionCatalog,
    optionSnapshot,
    optionState,
    optionStateRef,
    pendingOptionRef,
    sessionId,
    target,
    updateOptionState
  } = args
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
  /** After an accepted write: the host's own read replaces the committed guess, and its speed
   *  facts (the request it saw, what it applied) follow the write. Ignored once the session, host
   *  or generation the write was made for is gone. */
  const refreshAfterWrite = useCallback(
    (targetRecord: NativeChatSessionOptionRecord, isCurrent: () => boolean): void => {
      void callStructuredAgentSession<AgentSessionOptionsResult>(target, 'agentSession.options', {
        sessionId
      })
        .then((refreshed) => {
          if (isCurrent()) {
            updateOptionState((latest) =>
              latest.record === targetRecord && optionCatalog
                ? applyStructuredAgentSessionOptions(
                    latest,
                    optionCatalog,
                    refreshed,
                    codexSpeedHost
                  )
                : latest
            )
          }
        })
        .catch(() => {})
    },
    [codexSpeedHost, optionCatalog, sessionId, target, updateOptionState]
  )
  return { speedLines, admitPick, admitSend, refreshAfterWrite }
}
