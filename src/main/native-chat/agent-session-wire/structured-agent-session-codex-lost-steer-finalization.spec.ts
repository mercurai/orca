import type { codexInputFinalizationFixture } from './structured-agent-session-codex-input-host.test'
import { expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  continuingStructuredAgentSessionInput,
  finalizingStructuredAgentSessionInput
} from './structured-agent-session-handing-over'
import { CodexAppServerTimeoutError } from '../../codex/codex-app-server-session'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'

export function registerCodexLostSteerFinalization(current: typeof codexInputFinalizationFixture) {
  it('bounds lost-steer without replaying possibly written input', async () => {
    const { host, codex, turns, permissionSend, pick, row, starts, began } = current()
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    await began(await permissionSend('running', { personality: 'friendly' }))
    const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
    const persisted = vi.spyOn(journal, 'resolveDispatch')
    const reply = Promise.withResolvers<unknown>()
    const observedReply = reply.promise.catch(() => {})
    codex.routes['turn/steer'] = () => reply.promise
    try {
      const configReads = codex.connections[0]!.calls.filter(
        (call) => call.method === 'config/read'
      ).length
      const id = await permissionSend('preserve me', { personality: 'friendly' })
      await vi.waitFor(() =>
        expect(
          codex.connections[0]!.calls.filter((call) => call.method === 'turn/steer')
        ).toHaveLength(1)
      )
      expect(
        codex.connections[0]!.calls.find((call) => call.method === 'turn/steer')?.params
      ).toMatchObject({
        clientUserMessageId: id,
        expectedTurnId: turns.turnId
      })
      expect(
        codex.connections[0]!.calls.filter((call) => call.method === 'config/read')
      ).toHaveLength(configReads)
      await pick('auto')
      reply.reject(new CodexAppServerTimeoutError('lost turn reply'))
      await vi.waitFor(() => expect(finalizingStructuredAgentSessionInput(journal, id)).toBe(false))
      const writes = await Promise.allSettled(persisted.mock.results.map((result) => result.value))
      expect(writes.filter((result) => result.status === 'rejected')).toEqual([])
      await vi.waitFor(async () => expect((await row(id))?.dispatchState).toBe('unknown'))
      expect(journal.submission(id)).toMatchObject({ options: { personality: 'friendly' } })
      expect(journal.itemBody(agentJournalSubmissionKey(id))).toEqual(
        hostTestMessage('preserve me')
      )
      expect(continuingStructuredAgentSessionInput(journal, id)).toBe(false)
      expect(starts()).toHaveLength(1)
      expect(codex.connections).toHaveLength(1)
      expect(
        codex.connections[0]!.calls.filter((call) => call.method === 'turn/steer')
      ).toHaveLength(1)
    } finally {
      reply.reject(new CodexAppServerTimeoutError('lost turn reply'))
      await observedReply
    }
  })
}
