import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'

let rig: QueuedMessageTestRig
beforeEach(async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
})
afterEach(() => rig.dispose())

// Choices now travel with the durable submission, rather than mutating a live child
// through setOption. A refusal must still settle that submission without fallback.
describe('message-carried speed admission', () => {
  it.each([
    ['serviceTier', 'synthetic-fast-request-id'],
    ['fastMode', 'true']
  ] as const)('retains captured %s through dispatch and a provider refusal', async (key, value) => {
    const requested = { [key]: value }
    rig.dispatch.mockResolvedValueOnce({
      state: 'rejected',
      ...agentSessionFailureWords(
        agentSessionFailureFact('speedUnavailable', { neverReachedAgent: true }),
        { provider: 'codex', surface: 'rejection' }
      )
    })
    const send = rig.send('requested speed', undefined, { carried: requested })
    expect(await send.result).toMatchObject({ ok: true })
    await eventually(async () =>
      expect(await rig.submission(send.id)).toMatchObject({
        dispatchState: 'rejected',
        rejection: { kind: 'speedUnavailable', neverReachedAgent: true }
      })
    )
    expect(rig.dispatch).toHaveBeenCalledOnce()
    expect(rig.dispatch.mock.calls[0]?.[0].executionOptions).toEqual(requested)
    expect(rig.setOption).not.toHaveBeenCalled()
    expect((await rig.submission(send.id))?.options).toEqual(requested)
    expect(rig.store.getRecord(SESSION)?.options?.[key]).not.toBe(value)
  })
})
