import { describe, expect, it, vi } from 'vitest'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { AgentSessionOptionRejectedError } from './structured-agent-session-option-error'
import {
  CALLER,
  attach,
  attachParams,
  envelope,
  hostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'

const SPEEDS = [
  ['serviceTier', 'synthetic-fast-request-id'],
  ['fastMode', 'true']
] as const
const CLAUDE_SESSION = '019fd532-7c11-7a90-b6de-4e1a2c3d5f61'

async function readyChild(provider: 'codex' | 'claude' = 'codex'): Promise<void> {
  const { host, acquire, dispatch } = hostTestState()
  if (provider === 'claude') {
    acquire.mockImplementation(async ({ fence, spawnToken }) => ({
      process: { hostId: 'local', pid: 4242, processStartTimeMs: NOW, spawnToken },
      link: {
        linkId: `claude-message-options-${fence}`,
        handle: claudeProviderHandle(CLAUDE_SESSION, 'synthetic-leaf'),
        origin: 'resumed',
        mintedAtFence: fence,
        observedAt: NOW
      }
    }))
    dispatch.mockResolvedValue({ state: 'admitted' })
    expect(await host.attach(CALLER, attachParams({
      provider: 'claude',
      agent: 'claude',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/synthetic/claude-home' },
      providerHandle: { kind: 'claude', sessionId: CLAUDE_SESSION, leafUuid: 'synthetic-leaf' }
    }))).toMatchObject({ ok: true })
  } else {
    await attach()
  }
  await vi.waitFor(() => expect(host.readStatusSummary(SESSION)?.hostExecutionPhase).toBe('ready'))
}

async function sendWith(options: Readonly<Record<string, string>>): Promise<void> {
  const { host } = hostTestState()
  const body = hostTestMessage('run with this selection')
  expect(await host.send(CALLER, {
    envelope: envelope('agentSession.send', { body, options }),
    body,
    options
  })).toMatchObject({ ok: true })
}

async function rejectedSubmission(): Promise<void> {
  const { host } = hostTestState()
  await vi.waitFor(async () => {
    const submissions = (await host.journalSnapshot(SESSION)).submissions
    expect(submissions).toHaveLength(1)
    expect(submissions[0]).toMatchObject({ dispatchState: 'rejected' })
  })
}

describe('message-carried speed mutations', () => {
  it.each(SPEEDS)('does not dispatch after the provider refuses %s', async (key, value) => {
    await readyChild()
    const { setOption, dispatch, store } = hostTestState()
    setOption.mockRejectedValueOnce(new AgentSessionOptionRejectedError('Synthetic speed refusal'))

    await sendWith({ [key]: value })
    await rejectedSubmission()

    expect(setOption).toHaveBeenCalledWith(expect.objectContaining({ key, value }))
    expect(dispatch).not.toHaveBeenCalled()
    expect(store.getRecord(SESSION)?.options?.[key]).not.toBe(value)
  })

  it.each(SPEEDS)('does not swallow an unexpected %s write error', async (key, value) => {
    await readyChild()
    const { setOption, dispatch, store, log } = hostTestState()
    const failure = new Error('Synthetic speed transport failure')
    setOption.mockRejectedValueOnce(failure)

    await sendWith({ [key]: value })
    await rejectedSubmission()

    expect(dispatch).not.toHaveBeenCalled()
    expect(store.getRecord(SESSION)?.options?.[key]).not.toBe(value)
    expect(log.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: 'delivering a queued message failed',
        fields: expect.objectContaining({ scope: 'delivery-loop', error: failure })
      })
    ]))
  })

  it.each(SPEEDS)('persists a successful %s change before one dispatch', async (key, value) => {
    await readyChild()
    const { setOption, dispatch, store, host } = hostTestState()
    setOption.mockResolvedValueOnce({ [key]: value })
    dispatch.mockImplementationOnce(async () => {
      expect(store.getRecord(SESSION)?.options?.[key]).toBe(value)
      return { state: 'admitted' }
    })

    await sendWith({ [key]: value })
    await vi.waitFor(async () => {
      expect((await host.journalSnapshot(SESSION)).submissions[0]?.dispatchState).toBe('accepted')
    })

    expect(setOption).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledOnce()
    expect(setOption.mock.invocationCallOrder[0]).toBeLessThan(dispatch.mock.invocationCallOrder[0])
    expect(store.getRecord(SESSION)?.options?.[key]).toBe(value)
  })
})

describe('legacy message option failure policy', () => {
  it.each([['model', 'synthetic-model'], ['effort', 'high']])(
    'preserves Claude delivery after a failed %s mutation',
    async (key, value) => {
      await readyChild('claude')
      const { setOption, dispatch, store } = hostTestState()
      setOption.mockRejectedValueOnce(new Error('Synthetic legacy option failure'))

      await sendWith({ [key]: value })
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())

      expect(setOption).toHaveBeenCalledWith(expect.objectContaining({ key, value }))
      expect(store.getRecord(SESSION)?.options?.[key]).not.toBe(value)
    }
  )
})
