import { MAX_PROMPT_BYTES } from '../../../../shared/rpc-contract/structured-agent-session-params'
import {
  disposedDraftScopes,
  hasLocalChange,
  load,
  nextSavedAt,
  notifyScope,
  records,
  type DraftRecord
} from './native-chat-composer-draft-memory'
import {
  nativeChatComposerDraftStorage,
  parseStoredNativeChatComposerDraft,
  type NativeChatComposerDraftOwner,
  type StoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'
import {
  broadcastNativeChatComposerDraftChange,
  nativeChatComposerDraftWriteSettled,
  persistNativeChatComposerDraft
} from './native-chat-composer-draft-persistence'
import { hydrateNativeChatComposerDrafts } from './native-chat-composer-draft-load'
import {
  readDraftRecoveryReceipts,
  unionDraftRecoveryReceipts
} from './native-chat-composer-draft-recovery-receipts'

export type DraftRecoveryMessage = { clientMessageId: string; text: string }
type Recovery = {
  scopeKey: string
  cancelled: boolean
  base: StoredNativeChatComposerDraft
  added: readonly DraftRecoveryMessage[]
}
const active = new Set<Recovery>()
const empty = (): StoredNativeChatComposerDraft => ({ text: '', images: [], savedAt: 0 })

function appendMessages<T extends StoredNativeChatComposerDraft>(
  draft: T,
  messages: readonly DraftRecoveryMessage[]
): T {
  const seen = new Set(draft.recoveredMessageIds)
  const pending = messages.filter((message) => !seen.has(message.clientMessageId))
  const recoveredMessageIds = unionDraftRecoveryReceipts(
    draft.recoveredMessageIds,
    pending.map((message) => message.clientMessageId)
  )
  if (!pending.length) {
    return draft
  }
  const addition = pending.map((message) => message.text).join('\n\n')
  return {
    ...draft,
    document: undefined,
    text: draft.text.trimEnd() ? `${draft.text.trimEnd()}\n\n${addition}` : addition,
    recoveredMessageIds
  }
}

/** An ordinary write racing a committed recovery must include its not-yet-rendered text. */
export function includeCommittedDraftRecoveries(
  scopeKey: string,
  draft: StoredNativeChatComposerDraft | null,
  stored: StoredNativeChatComposerDraft | null
): StoredNativeChatComposerDraft | null {
  let next = draft
  const durable = new Set(stored?.recoveredMessageIds)
  for (const recovery of active) {
    if (recovery.scopeKey === scopeKey && !recovery.cancelled) {
      const added = recovery.added.filter((message) => durable.has(message.clientMessageId))
      if (added.length) {
        next = appendMessages(next ?? empty(), added)
      }
    }
  }
  return next
}

/** Disposal wins even when recovery has not installed a visible draft yet. */
export function cancelNativeChatDraftRecoveries(
  matches: (scopeKey: string, draft: StoredNativeChatComposerDraft | undefined) => boolean
): string[] {
  const scopes: string[] = []
  for (const recovery of active) {
    if (matches(recovery.scopeKey, recovery.base)) {
      recovery.cancelled = true
      scopes.push(recovery.scopeKey)
    }
  }
  return scopes
}

function validMessages(messages: readonly DraftRecoveryMessage[]): boolean {
  if (messages.length > 32 || messages.some((message) => typeof message.text !== 'string')) {
    return false
  }
  try {
    readDraftRecoveryReceipts(messages.map((message) => message.clientMessageId))
    return (
      new TextEncoder().encode(messages.map((message) => message.text).join('\n\n')).length <=
      MAX_PROMPT_BYTES
    )
  } catch {
    return false
  }
}

/** True only after a backend transaction committed text and exact-message receipts together. */
export async function recoverNativeChatDraftMessages(
  scopeKey: string,
  messages: readonly DraftRecoveryMessage[],
  owner?: NativeChatComposerDraftOwner
): Promise<boolean> {
  if (disposedDraftScopes.has(scopeKey) || !validMessages(messages)) {
    return false
  }
  if (!messages.length) {
    return true
  }
  const recovery: Recovery = {
    scopeKey,
    cancelled: false,
    added: [],
    base: records.get(scopeKey) ?? { ...empty(), ...(owner ? { owner } : {}) }
  }
  active.add(recovery)
  try {
    await hydrateNativeChatComposerDrafts()
    if (
      !load.hydrated ||
      recovery.cancelled ||
      disposedDraftScopes.has(scopeKey) ||
      !(await nativeChatComposerDraftWriteSettled(scopeKey))
    ) {
      return false
    }
    const committed: { value?: StoredNativeChatComposerDraft } = {}
    let observed: DraftRecord | undefined
    let callbackFailed = false
    await nativeChatComposerDraftStorage().update(scopeKey, (raw) => {
      try {
        if (recovery.cancelled || disposedDraftScopes.has(scopeKey)) {
          throw new Error('Composer recovery was disposed')
        }
        const stored = parseStoredNativeChatComposerDraft(raw)
        observed = records.get(scopeKey)
        const base = hasLocalChange(scopeKey)
          ? (observed ?? empty())
          : (stored ?? observed ?? empty())
        const ids = unionDraftRecoveryReceipts(
          base.recoveredMessageIds,
          stored?.recoveredMessageIds
        )
        const seen = new Set(ids)
        recovery.added = messages.filter((message) => !seen.has(message.clientMessageId))
        committed.value = {
          ...appendMessages({ ...base, recoveredMessageIds: ids }, recovery.added),
          savedAt: nextSavedAt(),
          ...(base.owner || !owner ? {} : { owner })
        }
        return committed.value
      } catch (error) {
        callbackFailed = true
        throw error
      }
    })
    if (
      callbackFailed ||
      !committed.value ||
      recovery.cancelled ||
      disposedDraftScopes.has(scopeKey)
    ) {
      return false
    }
    const durable = committed.value
    const latest = records.get(scopeKey)
    const next = latest === observed ? durable : appendMessages(latest ?? empty(), recovery.added)
    records.set(scopeKey, {
      ...next,
      recoveredMessageIds: unionDraftRecoveryReceipts(
        next.recoveredMessageIds,
        durable.recoveredMessageIds
      ),
      savedAt: nextSavedAt(),
      ...(next.owner || !durable.owner ? {} : { owner: durable.owner })
    })
    notifyScope(scopeKey)
    broadcastNativeChatComposerDraftChange(scopeKey)
    if (latest !== observed) {
      persistNativeChatComposerDraft(scopeKey, 'immediate')
      return (await nativeChatComposerDraftWriteSettled(scopeKey)) && !recovery.cancelled
    }
    return !recovery.cancelled
  } catch {
    return false
  } finally {
    active.delete(recovery)
  }
}
