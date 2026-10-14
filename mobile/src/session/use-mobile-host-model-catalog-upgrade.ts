import { useEffect, type MutableRefObject } from 'react'
import type { AgentSessionModelCatalogResult } from '../../../src/shared/agent-session-wire'
import type { AgentSessionOptionCatalog } from '../../../src/shared/agent-session-option-catalog'
import type { CodexSpeedHostSupport } from '../../../src/shared/codex-service-tier-presentation'
import type { NativeChatSessionOptionRecord } from '../../../src/shared/native-chat-session-option-state'
import {
  applyStructuredAgentSessionModelCatalog,
  settleStructuredAgentSessionBuiltinCatalog,
  type StructuredAgentSessionOptionState
} from '../../../src/shared/structured-agent-session-options'
import type { RpcClient } from '../transport/rpc-client'
import { callAgentSession } from './mobile-structured-agent-session-rpc'

// The host answers a waiting read when its first listing lands, within its own 30s picker wait.
const LISTING_WAIT_TIMEOUT_MS = 45_000

/**
 * The desktop's host-catalog upgrade on the phone: the picker lists the account's models from the
 * host store while the session's own options read may still wait on its attach. Until the host
 * answers it shows the quiet placeholder; it never waits on a listing: a first listing still
 * running lands in place. An older host refuses the method, and the built-in list stands, naming
 * nothing, until the options read lands.
 */
export function useMobileHostModelCatalogUpgrade(args: {
  agent: string | null
  client: RpcClient | null
  sessionId: string | null
  /** Host and workspace of the session: the same client and ids may stand for another source,
   *  whose list is read again. */
  sourceIdentity?: string
  enabled: boolean
  /** This phone created the chat, so it launches the listed default; a reopened one may not. */
  newLaunch: boolean
  /** Where a new chat runs: the host names no default its config could replace. */
  worktree?: string
  fence: number | null
  optionCatalog: AgentSessionOptionCatalog | null
  /** The host's speed capability: shapes the speed control, and a change reads the list again. */
  codexSpeedHost: CodexSpeedHostSupport
  activeOptionRecordRef: MutableRefObject<NativeChatSessionOptionRecord>
  updateOptionState: (
    update: (current: StructuredAgentSessionOptionState) => StructuredAgentSessionOptionState
  ) => void
}): void {
  const {
    activeOptionRecordRef,
    agent,
    client,
    codexSpeedHost,
    enabled,
    fence,
    newLaunch,
    optionCatalog,
    sessionId,
    sourceIdentity,
    updateOptionState,
    worktree
  } = args
  useEffect(() => {
    if (!client || !sessionId || !enabled || !agent || !optionCatalog) {
      return
    }
    let stale = false
    const params = { agent, sessionId, ...(newLaunch && worktree ? { worktree } : {}) }
    const read = (waitForListing: boolean): Promise<AgentSessionModelCatalogResult> =>
      waitForListing
        ? callAgentSession(
            client,
            'agentSession.modelCatalog',
            { ...params, waitForListing },
            LISTING_WAIT_TIMEOUT_MS
          )
        : callAgentSession(client, 'agentSession.modelCatalog', params)
    // A pick made meanwhile stays on the record; a listing only replaces the list it is picked from.
    const apply = (catalog: AgentSessionModelCatalogResult): void => {
      if (stale) {
        return
      }
      updateOptionState((current) =>
        current.record === activeOptionRecordRef.current
          ? applyStructuredAgentSessionModelCatalog(current, optionCatalog, catalog, {
              newLaunch,
              codexSpeedHost
            })
          : current
      )
    }
    // A refused or failed read is no list: the built-in one becomes usable, naming nothing.
    const settleBuiltin = (): void => {
      if (!stale) {
        updateOptionState((current) =>
          current.record === activeOptionRecordRef.current
            ? settleStructuredAgentSessionBuiltinCatalog(current)
            : current
        )
      }
    }
    void read(false)
      .then((catalog) => {
        if (catalog.origin === 'unknown' && catalog.listingInProgress === true && !stale) {
          // Usable on the built-in list while the listing runs; it lands in place.
          apply(catalog)
          return read(true).then(apply)
        }
        apply(catalog)
        return undefined
      })
      .catch(settleBuiltin)
    return () => {
      stale = true
    }
  }, [
    activeOptionRecordRef,
    agent,
    client,
    codexSpeedHost,
    enabled,
    fence,
    newLaunch,
    optionCatalog,
    sessionId,
    sourceIdentity,
    updateOptionState,
    worktree
  ])
}
