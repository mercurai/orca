// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), call: vi.fn(), toast: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: mocks.toast } }))
vi.mock('@/runtime/codex-speed-selection', () => ({
  prepareCodexSpeedWireOptions: mocks.prepare,
  CodexSpeedSelectionError: class extends Error {}
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  supportsStructuredAgentSessionQuietRepeatedStop: async () => true
}))
import { useStructuredAgentSessionMutate } from './use-structured-agent-session-mutate'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const fields = { key: 'serviceTier', value: 'synthetic-exact-tier' }
const local: RuntimeClientTarget = { kind: 'local' }
function render() {
  const stateRef = { current: { fence: 7 } }
  return renderHook(
    ({ sessionId, target }: { sessionId: string; target: RuntimeClientTarget }) =>
      useStructuredAgentSessionMutate({ sessionId, target, stateRef }),
    { initialProps: { sessionId: 'synthetic-session-a', target: local } }
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.call.mockResolvedValue({ ok: true, value: {} })
})

describe('speed negotiation retains its action context', () => {
  it.each(['session', 'target', 'unmount'] as const)(
    'issues no old action after %s changes while negotiation waits at the same fence',
    async (change) => {
      const negotiation = deferred<{ options: Record<string, string> }>()
      mocks.prepare.mockReturnValue(negotiation.promise)
      const hook = render()
      const pending = hook.result.current.write(
        'agentSession.setOption',
        'agentSession.setOption',
        fields
      )
      expect(mocks.prepare).toHaveBeenCalledOnce()
      if (change === 'unmount') {
        hook.unmount()
      } else {
        hook.rerender({
          sessionId: change === 'session' ? 'synthetic-session-b' : 'synthetic-session-a',
          target:
            change === 'target' ? { kind: 'environment', environmentId: 'synthetic-host' } : local
        })
      }
      let outcome: unknown
      await act(async () => {
        negotiation.resolve({ options: { serviceTier: fields.value } })
        outcome = await pending
      })
      expect(outcome).toEqual({ kind: 'dropped' })
      expect(mocks.call).not.toHaveBeenCalled()
      expect(mocks.toast).not.toHaveBeenCalled()
    }
  )

  it('drops an old host reply after switching sessions without changing the numeric fence', async () => {
    const reply = deferred<{ ok: true; value: object }>()
    mocks.prepare.mockResolvedValue({ options: { serviceTier: fields.value } })
    mocks.call.mockReturnValue(reply.promise)
    const hook = render()
    const pending = hook.result.current.write(
      'agentSession.setOption',
      'agentSession.setOption',
      fields
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(mocks.call).toHaveBeenCalledOnce()
    hook.rerender({ sessionId: 'synthetic-session-b', target: local })
    let outcome: unknown
    await act(async () => {
      reply.resolve({ ok: true, value: {} })
      outcome = await pending
    })
    expect(outcome).toEqual({ kind: 'dropped' })
    expect(mocks.toast).not.toHaveBeenCalled()
  })
})
