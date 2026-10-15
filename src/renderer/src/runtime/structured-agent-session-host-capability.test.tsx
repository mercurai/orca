// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY,
  AGENT_SESSION_CODEX_SERVICE_TIERS_RUNTIME_CAPABILITY,
  AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY,
  AGENT_SESSION_REWIND_RUNTIME_CAPABILITY,
  AGENT_SESSION_REWIND_RECOVERY_CAPABILITY
} from '../../../shared/protocol-version'

const mocks = vi.hoisted(() => ({
  supports: vi.fn(),
  contactRegained: new Map<string, () => void>()
}))

vi.mock('./runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: mocks.supports
}))

vi.mock('./runtime-host-contact-regained', () => ({
  subscribeRuntimeHostContactRegained: (environmentId: string, listener: () => void) => {
    mocks.contactRegained.set(environmentId, listener)
    return () => mocks.contactRegained.delete(environmentId)
  }
}))

import { setLocalRuntimeCapabilitiesForTests } from './local-runtime-capabilities'
import type { RuntimeClientTarget } from './runtime-client-target'
import * as capabilityModule from './structured-agent-session-host-capability'
import {
  useStructuredAgentSessionHostQueuesMessagesState,
  useStructuredAgentSessionHostRecoversRewindOnSend,
  useStructuredAgentSessionHostStopsConversation
} from './structured-agent-session-host-capability'

afterEach(() => {
  setLocalRuntimeCapabilitiesForTests(null)
  vi.clearAllMocks()
})

describe('whether a host takes a Stop naming no turn', () => {
  it('reads it from the host capability of that name, not from accepting sends first', () => {
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY])
    expect(
      renderHook(() => useStructuredAgentSessionHostStopsConversation({ kind: 'local' })).result
        .current
    ).toBe(false)

    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY])
    expect(
      renderHook(() => useStructuredAgentSessionHostStopsConversation({ kind: 'local' })).result
        .current
    ).toBe(true)
  })

  it('asks a remote host for that capability', async () => {
    mocks.supports.mockResolvedValueOnce(true)
    const { result } = renderHook(() =>
      useStructuredAgentSessionHostStopsConversation({
        kind: 'environment',
        environmentId: 'env-1'
      })
    )
    await waitFor(() => expect(result.current).toBe(true))
    expect(mocks.supports).toHaveBeenCalledWith(
      'env-1',
      AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY
    )
  })
})

describe('the queued-messages capability, three-state', () => {
  it('reads a failed remote probe as unknown, and asks again once contact is regained', async () => {
    mocks.supports.mockRejectedValueOnce(new Error('unreachable'))
    const { result } = renderHook(() =>
      useStructuredAgentSessionHostQueuesMessagesState({
        kind: 'environment',
        environmentId: 'env-1'
      })
    )
    await waitFor(() => expect(mocks.supports).toHaveBeenCalledTimes(1))
    expect(result.current).toBe('unknown')

    mocks.supports.mockResolvedValueOnce(true)
    act(() => {
      mocks.contactRegained.get('env-1')?.()
    })
    await waitFor(() => expect(result.current).toBe('supported'))
    expect(mocks.supports).toHaveBeenLastCalledWith(
      'env-1',
      AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY
    )
  })

  it('reads a local runtime that has not answered as unknown', () => {
    setLocalRuntimeCapabilitiesForTests(null)
    const { result } = renderHook(() =>
      useStructuredAgentSessionHostQueuesMessagesState({ kind: 'local' })
    )
    expect(result.current).toBe('unknown')
  })
})

describe('whether a host settles an in-doubt rewind on the next send', () => {
  it('reads the local runtime, which only rewinding is not enough for', () => {
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_REWIND_RUNTIME_CAPABILITY])
    expect(
      renderHook(() => useStructuredAgentSessionHostRecoversRewindOnSend({ kind: 'local' })).result
        .current
    ).toBe(false)
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_REWIND_RECOVERY_CAPABILITY])
    expect(
      renderHook(() => useStructuredAgentSessionHostRecoversRewindOnSend({ kind: 'local' })).result
        .current
    ).toBe(true)
  })

  it.each([true, false])('asks a remote host, which answers %s', async (supported) => {
    mocks.supports.mockResolvedValueOnce(supported)
    const { result } = renderHook(() =>
      useStructuredAgentSessionHostRecoversRewindOnSend({
        kind: 'environment',
        environmentId: 'env-1'
      })
    )
    await waitFor(() =>
      expect(mocks.supports).toHaveBeenCalledWith('env-1', AGENT_SESSION_REWIND_RECOVERY_CAPABILITY)
    )
    await waitFor(() => expect(result.current).toBe(supported))
  })
})

// The detailed probes return the owner's state beside its phase, and the state-only hooks above
// keep reading the same owner. They are typed as optional future exports so a missing hook throws
// inside each case rather than failing the whole file's collection.
type DetailedCapabilityProbe = {
  state: 'supported' | 'unsupported' | 'unknown'
  phase: 'pending' | 'settled' | 'failed'
}
type FutureProbeExports = Partial<{
  useStructuredAgentSessionHostCapabilityProbe: (
    target: RuntimeClientTarget,
    capability: string
  ) => DetailedCapabilityProbe
  useStructuredAgentSessionHostCodexSpeedProbe: (
    target: RuntimeClientTarget
  ) => DetailedCapabilityProbe
}>
const futureExports: typeof capabilityModule & FutureProbeExports = capabilityModule

function useCapabilityProbe(target: RuntimeClientTarget, capability: string) {
  const hook = futureExports.useStructuredAgentSessionHostCapabilityProbe
  if (!hook) {
    throw new Error('useStructuredAgentSessionHostCapabilityProbe is not exported')
  }
  return hook(target, capability)
}

function useSpeedProbe(target: RuntimeClientTarget) {
  const hook = futureExports.useStructuredAgentSessionHostCodexSpeedProbe
  if (!hook) {
    throw new Error('useStructuredAgentSessionHostCodexSpeedProbe is not exported')
  }
  return hook(target)
}

function deferredAnswer(): {
  promise: Promise<boolean>
  resolve: (value: boolean) => void
  reject: () => void
} {
  let resolve: (value: boolean) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<boolean>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject: () => reject(new Error('synthetic_probe_failure')) }
}

const ENV_1: RuntimeClientTarget = { kind: 'environment', environmentId: 'env-1' }
const ENV_2: RuntimeClientTarget = { kind: 'environment', environmentId: 'env-2' }

describe('the detailed capability probe, state with phase', () => {
  it.each([
    [true, 'supported'],
    [false, 'unsupported']
  ] as const)('is pending and unknown until a remote host answers %s', async (answered, state) => {
    const answer = deferredAnswer()
    mocks.supports.mockImplementationOnce(() => answer.promise)
    const { result } = renderHook(() =>
      useCapabilityProbe(ENV_1, AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY)
    )
    expect(result.current).toEqual({ state: 'unknown', phase: 'pending' })

    await act(async () => {
      answer.resolve(answered)
    })
    await waitFor(() => expect(result.current).toEqual({ state, phase: 'settled' }))
  })

  it('fails a rejected remote probe as unknown, then pends again when contact is regained', async () => {
    const first = deferredAnswer()
    const second = deferredAnswer()
    mocks.supports.mockImplementationOnce(() => first.promise)
    mocks.supports.mockImplementationOnce(() => second.promise)
    const { result } = renderHook(() =>
      useCapabilityProbe(ENV_1, AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY)
    )
    await act(async () => {
      first.reject()
    })
    await waitFor(() => expect(result.current).toEqual({ state: 'unknown', phase: 'failed' }))

    act(() => {
      mocks.contactRegained.get('env-1')?.()
    })
    expect(result.current).toEqual({ state: 'unknown', phase: 'pending' })
    await act(async () => {
      second.resolve(true)
    })
    await waitFor(() => expect(result.current).toEqual({ state: 'supported', phase: 'settled' }))
  })

  it('settles at once from a local runtime that has already answered', () => {
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_CODEX_SERVICE_TIERS_RUNTIME_CAPABILITY])
    const { result } = renderHook(() => useSpeedProbe({ kind: 'local' }))
    expect(result.current).toEqual({ state: 'supported', phase: 'settled' })
  })

  it('fails a local runtime whose probe cannot be read, rather than leaving it pending', async () => {
    setLocalRuntimeCapabilitiesForTests(null)
    const { result } = renderHook(() => useSpeedProbe({ kind: 'local' }))
    expect(result.current).toEqual({ state: 'unknown', phase: 'pending' })
    await waitFor(() => expect(result.current).toEqual({ state: 'unknown', phase: 'failed' }))
  })

  it('binds the speed probe to the speed capability and agrees with the state-only hook', async () => {
    // One probe per hook, as each call site owns its own answer.
    mocks.supports.mockResolvedValueOnce(true)
    mocks.supports.mockResolvedValueOnce(true)
    const { result } = renderHook(() => ({
      detailed: useSpeedProbe(ENV_1),
      stateOnly: capabilityModule.useStructuredAgentSessionHostCodexSpeedState(ENV_1)
    }))
    await waitFor(() => expect(result.current.stateOnly).toBe('supported'))
    expect(result.current.detailed).toEqual({ state: 'supported', phase: 'settled' })
    expect(mocks.supports).toHaveBeenCalledWith(
      'env-1',
      AGENT_SESSION_CODEX_SERVICE_TIERS_RUNTIME_CAPABILITY
    )
  })

  it('reports a new host as pending and ignores the previous host answering late', async () => {
    const first = deferredAnswer()
    const second = deferredAnswer()
    mocks.supports.mockImplementationOnce(() => first.promise)
    mocks.supports.mockImplementationOnce(() => second.promise)
    const { result, rerender } = renderHook(
      (props: { target: RuntimeClientTarget }) => useSpeedProbe(props.target),
      { initialProps: { target: ENV_1 } }
    )
    rerender({ target: ENV_2 })
    expect(result.current).toEqual({ state: 'unknown', phase: 'pending' })

    await act(async () => {
      first.resolve(true)
    })
    expect(result.current).toEqual({ state: 'unknown', phase: 'pending' })

    await act(async () => {
      second.resolve(false)
    })
    await waitFor(() => expect(result.current).toEqual({ state: 'unsupported', phase: 'settled' }))
  })
})
