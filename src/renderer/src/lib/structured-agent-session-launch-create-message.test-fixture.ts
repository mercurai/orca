import { vi, type Mock } from 'vitest'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionHistoryPage } from '../../../shared/agent-session-wire'
import type { CreateIntentParams } from '../../../shared/rpc-contract/structured-agent-session-params'
import type { HostCreateSupport } from './structured-agent-session-host-admission'
import { resetStructuredAgentLaunchRegistryForTests } from './agent-session/launch/structured-agent-session-launch-registry'
import { resetStructuredAgentLaunchPersistenceForTests } from './agent-session/launch/structured-agent-session-launch-persistence'
import { resetStructuredAgentSessionSendsForTests } from '@/components/native-chat/structured-agent-session-message-sender'
import { resetStructuredAgentSessionReadOwnersForTests } from '@/components/native-chat/structured-agent-session-read-owner'
import { clearNativeChatDraftCacheForTests } from '@/components/native-chat/native-chat-draft-cache'

export function deferred<T>() {
  let resolve = (_value: T): void => {}
  let reject = (_error: unknown): void => {}
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
export function submission(clientMessageId: string): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'a'.repeat(64),
    dispatchState: 'pending',
    handoverRecorded: true,
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null
  }
}
export function createdMessageReply(params: ReturnType<typeof CreateIntentParams.parse>) {
  const rows = params.firstMessage ? [submission(params.firstMessage.clientMessageId)] : []
  const cursor = { epoch: 'epoch-1', sequence: rows.length }
  const page: AgentSessionHistoryPage = {
    sessionId: params.envelope.sessionId,
    epoch: cursor.epoch,
    fence: 1,
    direction: 'tail',
    items: [],
    removedItemIds: [],
    submissions: rows,
    window: { oldest: null, newest: null, nextCursor: cursor },
    liveCursor: cursor,
    hasOlder: false,
    hasNewer: false,
    latestTurn: null
  }
  return {
    ok: true,
    replayed: false,
    value: { sessionId: page.sessionId, fence: 1, page, unconfirmedClientMessageIds: [] }
  }
}
type CreateMessageTestMocks = {
  supports: Mock<() => Promise<boolean>>
  supportsMode: Mock<() => Promise<boolean>>
  admit: Mock<() => Promise<HostCreateSupport>>
  inventory: Mock
}

export function resetCreateMessageTestState(mocks: CreateMessageTestMocks): void {
  vi.useFakeTimers()
  vi.clearAllMocks()
  localStorage.clear()
  resetStructuredAgentLaunchRegistryForTests()
  resetStructuredAgentLaunchPersistenceForTests()
  resetStructuredAgentSessionSendsForTests()
  resetStructuredAgentSessionReadOwnersForTests()
  clearNativeChatDraftCacheForTests()
  mocks.supports.mockResolvedValue(true)
  mocks.supportsMode.mockResolvedValue(true)
  mocks.admit.mockResolvedValue({ kind: 'admitted' })
  mocks.inventory.mockRejectedValue(new Error('an extra inventory read must not gate create'))
}

export function disposeCreateMessageTestState(): void {
  resetStructuredAgentSessionSendsForTests()
  resetStructuredAgentSessionReadOwnersForTests()
  vi.useRealTimers()
}
