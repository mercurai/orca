import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { hostTestMessage, hostTestOperationId } from './structured-agent-session-host-test-data'

export function conversationStopTestRequests(
  host: StructuredAgentSessionHost,
  sessionId: string,
  caller: Parameters<StructuredAgentSessionHost['send']>[0]
) {
  function send(text: string, options?: Readonly<Record<string, string>>) {
    const body = hostTestMessage(text)
    const clientOperationId = hostTestOperationId()
    const result = host.send(caller, {
      envelope: {
        sessionId: sessionId,
        clientOperationId,
        expectedRuntimeFence: 1,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId: sessionId,
          fields: { body, ...(options ? { options } : {}) }
        })
      },
      body,
      ...(options ? { options } : {})
    })
    return { id: clientOperationId, result }
  }

  function stop(turnId?: string, clientOperationId = hostTestOperationId()) {
    const fields = turnId === undefined ? {} : { turnId }
    return host.cancel(caller, {
      envelope: {
        sessionId: sessionId,
        clientOperationId,
        expectedRuntimeFence: null,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.cancel',
          sessionId: sessionId,
          fields
        })
      },
      ...fields
    })
  }

  function pickOption(key: string, value: string) {
    const fields = { key, value }
    return host.setOption(caller, {
      envelope: {
        sessionId: sessionId,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: 1,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.setOption',
          sessionId: sessionId,
          fields
        })
      },
      ...fields
    })
  }

  return { send, stop, pickOption }
}
