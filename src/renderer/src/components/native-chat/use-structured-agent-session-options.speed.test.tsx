// @vitest-environment happy-dom

import { renderHook, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  enqueue: vi.fn(),
  hold: vi.fn<(sessionId: string, id: string, encoded: string) => Promise<unknown> | null>(),
  speedSupport: vi.fn<() => Promise<'supported' | 'unsupported' | 'unknown'>>(),
  toastError: vi.fn<(message: string) => void>()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  readStructuredAgentSessionCodexSpeedSupport: mocks.speedSupport
}))

vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: mocks.enqueue
}))

vi.mock('@/lib/structured-agent-session-launch-options', () => ({
  holdStructuredAgentSessionLaunchOption: mocks.hold,
  getStructuredAgentSessionLaunchSelection: () => null
}))

import { AGENT_SESSION_CODEX_SERVICE_TIERS_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { resetHostModelCatalogSnapshotsForTests } from '@/runtime/host-model-catalog-snapshots'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'

const LOCAL_TARGET = { kind: 'local' } as const
const PAIRED_TARGET = { kind: 'environment', environmentId: 'server-1' } as const

const MODEL_ID = 'synthetic-speed-model'
const STANDARD = { value: 'default', label: 'Standard' }
const FAST = { value: 'synthetic-fast-lane', label: 'Fast' }
const ULTRAFAST = { value: 'synthetic-ultra-lane', label: 'Ultrafast' }

const TIERED_OPTIONS = {
  models: [
    {
      id: MODEL_ID,
      label: 'Synthetic Speed Model',
      isDefault: true,
      efforts: [],
      supportsFastMode: true,
      serviceTiers: [STANDARD, FAST, ULTRAFAST]
    }
  ],
  fastModeSupport: { supported: true },
  current: { model: MODEL_ID, serviceTier: 'default', confirmed: ['model', 'serviceTier'] }
}

type MutateCall = (...args: unknown[]) => Promise<unknown>

function mutateWith(reply: MutateCall): {
  mutate: StructuredAgentSessionMutate
  calls: ReturnType<typeof vi.fn<MutateCall>>
} {
  const calls = vi.fn<MutateCall>(reply)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each reply is null or the AgentSessionOptionResult shape the hook reads.
  return { mutate: calls as unknown as StructuredAgentSessionMutate, calls }
}

type RenderProps = { paired?: boolean }

function renderOptions(mutate: StructuredAgentSessionMutate, initial: RenderProps = {}) {
  return renderHook(
    (props: RenderProps) =>
      useStructuredAgentSessionOptions({
        agent: 'codex',
        sessionId: 'session-1',
        target: props.paired ? PAIRED_TARGET : LOCAL_TARGET,
        transportEnabled: true,
        isVisible: true,
        providerVisible: true,
        fence: 1,
        turnId: null,
        unloadedTurnRevisions: undefined,
        mutate
      }),
    { initialProps: initial }
  )
}

function descriptor(snapshot: readonly SessionOptionDescriptor[], id: string) {
  return snapshot.find((entry) => entry.id === id)
}

function setOptionCalls(calls: ReturnType<typeof vi.fn<MutateCall>>): unknown[] {
  return calls.mock.calls
    .filter(([method]) => method === 'agentSession.setOption')
    .map(([, , fields]) => fields)
}

function answerOptions(result: () => Promise<unknown>): void {
  mocks.call.mockImplementation((_target: unknown, method: string) =>
    method === 'agentSession.options' ? result() : new Promise(() => {})
  )
}

describe('useStructuredAgentSessionOptions speed gate', () => {
  beforeEach(() => {
    mocks.call.mockReset()
    mocks.enqueue.mockReset()
    mocks.hold.mockReset()
    mocks.speedSupport.mockReset()
    mocks.toastError.mockReset()
    resetHostModelCatalogSnapshotsForTests()
  })

  afterEach(() => {
    setLocalRuntimeCapabilitiesForTests(null)
  })

  it('offers the speed select and sends the exact tier id on a host that affirms the capability', async () => {
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_CODEX_SERVICE_TIERS_RUNTIME_CAPABILITY])
    mocks.speedSupport.mockResolvedValue('supported')
    answerOptions(() => Promise.resolve(TIERED_OPTIONS))
    const { mutate, calls } = mutateWith(async () => ({
      key: 'serviceTier',
      value: FAST.value,
      options: { serviceTier: FAST.value }
    }))
    const { result, unmount } = renderOptions(mutate)
    await waitFor(() =>
      expect(descriptor(result.current.optionSnapshot, 'serviceTier')).toBeDefined()
    )
    expect(descriptor(result.current.optionSnapshot, 'fastMode')).toBeUndefined()

    let applied = false
    await act(async () => {
      applied = await result.current.setStructuredOption('serviceTier', FAST.value)
    })

    expect(applied).toBe(true)
    expect(setOptionCalls(calls)).toEqual([{ key: 'serviceTier', value: FAST.value }])
    expect(mocks.speedSupport).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('keeps the Fast toggle and refuses a tier write on a host without the capability', async () => {
    setLocalRuntimeCapabilitiesForTests([])
    answerOptions(() => Promise.resolve(TIERED_OPTIONS))
    const { mutate, calls } = mutateWith(async () => null)
    const { result, unmount } = renderOptions(mutate)
    await waitFor(() => expect(descriptor(result.current.optionSnapshot, 'fastMode')).toBeDefined())
    expect(descriptor(result.current.optionSnapshot, 'serviceTier')).toBeUndefined()

    let applied = true
    await act(async () => {
      applied = await result.current.setStructuredOption('serviceTier', FAST.value)
    })

    expect(applied).toBe(false)
    expect(calls).not.toHaveBeenCalled()
    expect(mocks.hold).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    expect(mocks.toastError.mock.calls[0]?.[0]).toMatch(/needs an update/)
    unmount()
  })

  it.each(['unsupported', 'unknown'] as const)(
    'refuses at the write when the host answers %s after the pick was admitted',
    async (later) => {
      setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_CODEX_SERVICE_TIERS_RUNTIME_CAPABILITY])
      mocks.speedSupport.mockResolvedValue(later)
      answerOptions(() => Promise.resolve(TIERED_OPTIONS))
      const { mutate, calls } = mutateWith(async () => null)
      const { result, unmount } = renderOptions(mutate)
      await waitFor(() =>
        expect(descriptor(result.current.optionSnapshot, 'serviceTier')).toBeDefined()
      )

      let applied = true
      await act(async () => {
        applied = await result.current.setStructuredOption('serviceTier', ULTRAFAST.value)
      })

      expect(applied).toBe(false)
      expect(calls).not.toHaveBeenCalled()
      expect(mocks.toastError).toHaveBeenCalledTimes(1)
      // The refusal released the pending slot, so a later pick is judged afresh.
      await act(async () => {
        await result.current.setStructuredOption('serviceTier', 'default')
      })
      expect(mocks.speedSupport).toHaveBeenCalledTimes(2)
      unmount()
    }
  )

  it('does not let a disabled presentation row through, even on a capable host', async () => {
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_CODEX_SERVICE_TIERS_RUNTIME_CAPABILITY])
    mocks.speedSupport.mockResolvedValue('supported')
    answerOptions(() =>
      Promise.resolve({
        ...TIERED_OPTIONS,
        models: [{ ...TIERED_OPTIONS.models[0], serviceTiers: [STANDARD] }]
      })
    )
    const { mutate, calls } = mutateWith(async () => null)
    const { result, unmount } = renderOptions(mutate)
    await waitFor(() =>
      expect(descriptor(result.current.optionSnapshot, 'serviceTier')).toBeDefined()
    )
    const unavailable = descriptor(result.current.optionSnapshot, 'serviceTier')
    const row =
      unavailable?.kind.type === 'select'
        ? unavailable.kind.choices.find((choice) => choice.label === 'Ultrafast')
        : undefined
    expect(row?.disabled).toBe(true)

    let applied = true
    await act(async () => {
      applied = await result.current.setStructuredOption('serviceTier', row?.value ?? '')
    })

    expect(applied).toBe(false)
    expect(calls).not.toHaveBeenCalled()
    unmount()
  })

  it('keeps the speed select and its selection when the host catalog refresh is rejected', async () => {
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_CODEX_SERVICE_TIERS_RUNTIME_CAPABILITY])
    mocks.call.mockImplementation((_target: unknown, method: string) =>
      method === 'agentSession.options'
        ? Promise.resolve({
            ...TIERED_OPTIONS,
            current: { ...TIERED_OPTIONS.current, serviceTier: FAST.value }
          })
        : Promise.reject(new Error('method_not_found'))
    )
    const { result, unmount } = renderOptions(mutateWith(async () => null).mutate)
    await waitFor(() =>
      expect(descriptor(result.current.optionSnapshot, 'serviceTier')).toBeDefined()
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const tier = descriptor(result.current.optionSnapshot, 'serviceTier')
    expect(tier?.kind.type === 'select' ? tier.kind.currentValue : undefined).toBe(FAST.value)
    unmount()
  })

  it('shows a requested tier the host cannot send apart from the stored tier on a fresh client', async () => {
    const CUSTOM = 'synthetic-custom-lane'
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_CODEX_SERVICE_TIERS_RUNTIME_CAPABILITY])
    mocks.speedSupport.mockResolvedValue('supported')
    answerOptions(() =>
      Promise.resolve({
        ...TIERED_OPTIONS,
        current: { ...TIERED_OPTIONS.current, serviceTier: FAST.value },
        speed: { selection: { tierId: CUSTOM, state: 'unavailable' } }
      })
    )
    const { result, unmount } = renderOptions(mutateWith(async () => null).mutate)
    const lines = () => result.current.optionSurface.getSpeedLines()
    await waitFor(() => expect(lines()).toContainEqual({ kind: 'stored', label: 'Fast' }))

    const requested = lines().filter((line) => JSON.stringify(line).includes(CUSTOM))
    expect(requested).toHaveLength(1)
    expect(requested[0]?.kind).not.toBe('stored')
    unmount()
  })

  // v1.4.224 merges the prior options into every acknowledgement, so an explicit Fast-off comes
  // back beside the saved canonical tier. The action is the person's, not the stored tier.
  it('replaces a saved Ultrafast with Fast off when an older host acknowledges both together', async () => {
    setLocalRuntimeCapabilitiesForTests([])
    mocks.speedSupport.mockResolvedValue('unsupported')
    answerOptions(() =>
      Promise.resolve({
        ...TIERED_OPTIONS,
        current: {
          model: MODEL_ID,
          serviceTier: ULTRAFAST.value,
          fastMode: true,
          confirmed: ['model', 'serviceTier', 'fastMode']
        }
      })
    )
    const { mutate, calls } = mutateWith(async () => ({
      key: 'fastMode',
      value: 'false',
      options: { model: MODEL_ID, serviceTier: ULTRAFAST.value, fastMode: 'false' }
    }))
    const { result, unmount } = renderOptions(mutate)
    await waitFor(() => expect(descriptor(result.current.optionSnapshot, 'fastMode')).toBeDefined())

    let applied = false
    await act(async () => {
      applied = await result.current.setStructuredOption('fastMode', false)
    })

    expect(applied).toBe(true)
    expect(setOptionCalls(calls)).toEqual([{ key: 'fastMode', value: 'false' }])
    const picks = mocks.enqueue.mock.calls.flatMap(([, write]) => write?.picks ?? [])
    expect(picks).toContainEqual({ modelId: MODEL_ID, optionId: 'fastMode', value: false })
    expect(picks.map((pick: { optionId: string }) => pick.optionId)).not.toContain('serviceTier')
    unmount()
  })

  it('drops a response read for the previous execution host after the session moves', async () => {
    setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_CODEX_SERVICE_TIERS_RUNTIME_CAPABILITY])
    let resolveLocal: (value: unknown) => void = () => {}
    mocks.call.mockImplementation((target: { kind: string }, method: string) =>
      method === 'agentSession.options' && target.kind === 'local'
        ? new Promise((resolve) => {
            resolveLocal = resolve
          })
        : new Promise(() => {})
    )
    const { result, rerender, unmount } = renderOptions(mutateWith(async () => null).mutate)
    await waitFor(() =>
      expect(mocks.call.mock.calls.some(([, method]) => method === 'agentSession.options')).toBe(
        true
      )
    )

    rerender({ paired: true })
    await act(async () => {
      resolveLocal(TIERED_OPTIONS)
      await Promise.resolve()
    })

    // The other host's tiers must not appear under this host's session.
    expect(descriptor(result.current.optionSnapshot, 'serviceTier')).toBeUndefined()
    unmount()
  })
})
