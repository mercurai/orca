import type { NativeChatSessionOptionRecord } from '../../../src/shared/native-chat-session-option-state'

/** The record without any pick the host never reported back. */
export function reportedOptionRecord(
  record: NativeChatSessionOptionRecord
): NativeChatSessionOptionRecord {
  return {
    agent: record.agent,
    ...(record.model?.source === 'reported' ? { model: record.model } : {}),
    valuesByModel: Object.fromEntries(
      Object.entries(record.valuesByModel).map(([modelId, values]) => [
        modelId,
        Object.fromEntries(
          Object.entries(values).filter(([, entry]) => entry.source === 'reported')
        )
      ])
    )
  }
}
