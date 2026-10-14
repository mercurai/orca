// One explicit option pick on the phone, from its first synchronous step to the host's answer. A
// pick belongs to the generation it was made in (client, source, agent, session, fence): whatever
// it is answered with after the generation moved commits nothing, remembers nothing and reads
// nothing back. A speed pick is also a request that holds every send out until an accepted
// replacement, so a refusal or a lost answer never lets a turn go at the prior speed.

import { useCallback, type MutableRefObject } from 'react'
import type { AgentSessionOptionCatalog } from '../../../src/shared/agent-session-option-catalog'
import type {
  AgentSessionOptionResult,
  AgentSessionOptionsResult
} from '../../../src/shared/agent-session-wire'
import {
  CODEX_SERVICE_TIER_OPTION_ID,
  type CodexSpeedHostSupport
} from '../../../src/shared/codex-service-tier-presentation'
import type { NativeChatSessionOptionRecord } from '../../../src/shared/native-chat-session-option-state'
import type { SessionOptionValue } from '../../../src/shared/native-chat-session-options'
import {
  acknowledgeStructuredAgentSessionAction,
  acknowledgedStructuredAgentSessionOptions,
  requestStructuredAgentSessionSpeed,
  structuredAgentSessionHeldWithRequested
} from '../../../src/shared/structured-agent-session-option-acknowledgement'
import { encodeStructuredAgentSessionOptionValue } from '../../../src/shared/structured-agent-session-option-codec'
import { structuredAgentSessionOptionView } from '../../../src/shared/structured-agent-session-option-view'
import {
  applyStructuredAgentSessionOptions,
  canSetStructuredAgentSessionOption,
  commitStructuredAgentSessionOption,
  structuredAgentSessionOptionPicks,
  type StructuredAgentSessionOptionState
} from '../../../src/shared/structured-agent-session-options'
import type { RpcClient } from '../transport/rpc-client'
import { persistMobileStructuredOptionPicks } from './mobile-native-chat-session-option-persistence'
import {
  callAgentSession,
  type StructuredAgentSessionMutate
} from './mobile-structured-agent-session-rpc'

const NO_HELD_OPTIONS: Readonly<Record<string, string>> = {}

/** The options as the person sees them: what the host stores, with the speed they asked for that
 *  the host has not accepted shown over it. Derived on every read, never written to the record. */
export function mobileStructuredOptionView(
  state: StructuredAgentSessionOptionState
): StructuredAgentSessionOptionState {
  return structuredAgentSessionOptionView(
    state,
    undefined,
    structuredAgentSessionHeldWithRequested(NO_HELD_OPTIONS, state)
  )
}

/** Only an affirmative capability admits a canonical tier; every other pick is not gated here. */
function speedPickAdmitted(id: string, host: CodexSpeedHostSupport): boolean {
  return id !== CODEX_SERVICE_TIER_OPTION_ID || host === 'supported'
}

export function useMobileStructuredAgentOptionWrite(args: {
  agent: string | null
  client: RpcClient | null
  sessionId: string | null
  optionCatalog: AgentSessionOptionCatalog | null
  codexSpeedHost: CodexSpeedHostSupport
  mutate: StructuredAgentSessionMutate
  optionStateRef: MutableRefObject<StructuredAgentSessionOptionState>
  activeOptionRecordRef: MutableRefObject<NativeChatSessionOptionRecord>
  pendingOptionRef: MutableRefObject<string | null>
  optionMutationGeneration: MutableRefObject<number>
  updateOptionState: (
    update: (current: StructuredAgentSessionOptionState) => StructuredAgentSessionOptionState
  ) => void
}): (id: string, value: SessionOptionValue) => Promise<boolean> {
  const {
    activeOptionRecordRef,
    agent,
    client,
    codexSpeedHost,
    mutate,
    optionCatalog,
    optionMutationGeneration,
    optionStateRef,
    pendingOptionRef,
    sessionId,
    updateOptionState
  } = args
  return useCallback(
    async (id: string, value: SessionOptionValue): Promise<boolean> => {
      const currentState = optionStateRef.current
      const encoded = encodeStructuredAgentSessionOptionValue(id, value)
      if (
        pendingOptionRef.current !== null ||
        !client ||
        !sessionId ||
        !optionCatalog ||
        encoded === null ||
        !speedPickAdmitted(id, codexSpeedHost) ||
        !canSetStructuredAgentSessionOption(mobileStructuredOptionView(currentState), id, value)
      ) {
        return false
      }
      const targetRecord = currentState.record
      const mutationGeneration = ++optionMutationGeneration.current
      const isCurrent = (): boolean =>
        activeOptionRecordRef.current === targetRecord &&
        optionMutationGeneration.current === mutationGeneration
      pendingOptionRef.current = id
      // Synchronously, before the write: a send made in this tick already finds the request held.
      updateOptionState((current) => ({
        ...requestStructuredAgentSessionSpeed(current, id, encoded),
        pendingId: id
      }))
      try {
        const result = await mutate<AgentSessionOptionResult>(
          'agentSession.setOption',
          'agentSession.setOption',
          { key: id, value: encoded }
        )
        if (!isCurrent()) {
          return result.status !== 'rejected'
        }
        if (result.status === 'accepted') {
          // The action's own values: an older host's merged answer echoes the saved tier too.
          const committed = acknowledgedStructuredAgentSessionOptions(
            { id, value: encoded },
            result.value.options
          )
          updateOptionState((current) =>
            current.record === targetRecord && result.sameFence
              ? acknowledgeStructuredAgentSessionAction(current, id, committed)
              : current
          )
          // Only an accepted pick: an `unknown` outcome commits optimistically to the
          // visible record, and remembering one the provider refused would seed a
          // launch the user never chose.
          if (agent) {
            void persistMobileStructuredOptionPicks({
              client,
              agent,
              picks: structuredAgentSessionOptionPicks(currentState, committed)
            })
          }
          if (result.sameFence) {
            void callAgentSession<AgentSessionOptionsResult>(client, 'agentSession.options', {
              sessionId
            })
              .then((refreshed) => {
                if (isCurrent()) {
                  updateOptionState((latest) =>
                    latest.record === targetRecord
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
              .catch(() => undefined)
          }
          return true
        }
        if (result.status === 'unknown') {
          // Committed as shown, never as accepted: the request stays held until the host says so.
          updateOptionState((current) =>
            current.record === targetRecord
              ? commitStructuredAgentSessionOption(current, id, encoded)
              : current
          )
          return true
        }
        return false
      } finally {
        if (isCurrent()) {
          pendingOptionRef.current = null
          updateOptionState((current) =>
            current.record === targetRecord && current.pendingId === id
              ? { ...current, pendingId: null }
              : current
          )
        }
      }
    },
    [
      activeOptionRecordRef,
      agent,
      client,
      codexSpeedHost,
      mutate,
      optionCatalog,
      optionMutationGeneration,
      optionStateRef,
      pendingOptionRef,
      sessionId,
      updateOptionState
    ]
  )
}
