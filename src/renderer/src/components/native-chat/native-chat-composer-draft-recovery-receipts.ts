import type { StoredNativeChatComposerDraft } from './native-chat-composer-draft-storage'

export const MAX_DRAFT_RECOVERY_RECEIPTS = 256

export function readDraftRecoveryReceipts(value: unknown): readonly string[] {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value) || value.length > MAX_DRAFT_RECOVERY_RECEIPTS ||
    value.some((id) => typeof id !== 'string' || !id.trim() || id.length > 256 || Array.from(id).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) ||
    new Set(value).size !== value.length) {
    throw new Error('Invalid composer recovery receipts')
  }
  return value
}

/** Receipts never expire while a source may still exist; capacity refuses the entire mutation. */
export function unionDraftRecoveryReceipts(...groups: (readonly string[] | undefined)[]): string[] {
  const ids = [...new Set(groups.flatMap((group) => readDraftRecoveryReceipts(group)))]
  if (ids.length > MAX_DRAFT_RECOVERY_RECEIPTS) {
    throw new Error('Composer recovery receipt capacity reached')
  }
  return ids
}

export function preserveDraftRecoveryReceipts(
  draft: StoredNativeChatComposerDraft | null,
  previous: StoredNativeChatComposerDraft | null
): StoredNativeChatComposerDraft | null {
  const ids = unionDraftRecoveryReceipts(draft?.recoveredMessageIds, previous?.recoveredMessageIds)
  return ids.length === 0 ? draft : {
    ...(draft ?? { text: '', images: [], savedAt: previous?.savedAt ?? 0, owner: previous?.owner }),
    recoveredMessageIds: ids
  }
}
