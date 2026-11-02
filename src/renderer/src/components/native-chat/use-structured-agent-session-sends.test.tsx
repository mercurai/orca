// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import { resetStructuredAgentSessionSendsForTests } from './structured-agent-session-message-sender'
import { useStructuredAgentSessionSends } from './use-structured-agent-session-sends'
import { CodexSpeedSelectionError } from '@/runtime/codex-speed-selection'
import { getStructuredAgentSessionPendingSends } from './structured-agent-session-pending-sends'

const QUEUEING = {
  capability: 'supported',
  followUpsQueue: true,
  isWorking: true,
  stopping: false,
  session: { queuedMessages: [] },
  prompts: []
} as const

afterEach(() => {
  resetStructuredAgentSessionSendsForTests()
})

it('takes no second send while the first is out', () => {
  mocks.call.mockImplementation(() => new Promise(() => {}))
  const { result } = renderHook(() =>
    useStructuredAgentSessionSends({
      sessionId: 'session-1',
      target: { kind: 'local' },
      fence: 1,
      submissions: [],
      queuedMessageIds: [],
      queue: QUEUEING,
      historyLoaded: false,
      isWorking: true
    })
  )
  let first: boolean | 'queued' = false
  let second: boolean | 'queued' = true
  act(() => {
    first = result.current.send('one')
    second = result.current.send('two')
  })
  expect(first).toBe('queued')
  expect(second).toBe(false)
})

it('retains the composer message and reports a speed selection refusal before queueing or RPC', () => {
  mocks.call.mockClear()
  const reason = 'Speed support is unknown. Refresh the speed choices and retry.'
  const { result, unmount } = renderHook(() =>
    useStructuredAgentSessionSends({
      sessionId: 'session-speed-refusal',
      target: { kind: 'local' },
      fence: 7,
      submissions: [],
      queuedMessageIds: [],
      queue: QUEUEING,
      historyLoaded: false,
      sendOptions: () => {
        throw new CodexSpeedSelectionError(reason)
      }
    })
  )
  let admitted: boolean | 'queued' = true
  try {
    act(() => {
      admitted = result.current.send('keep this unsent composer text')
    })
    // The composer clears its input only when send accepts it.
    expect(admitted).toBe(false)
    expect(result.current.error).toContain(reason)
    expect(getStructuredAgentSessionPendingSends('session-speed-refusal')).toEqual([])
    expect(mocks.call).not.toHaveBeenCalled()
  } finally {
    unmount()
  }
})
