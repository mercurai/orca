// @vitest-environment happy-dom

// Behavioral reds for the speed picker's loading phases. They drive the public options hook over
// the real capability owner, real catalog application and real joined-listing waits; only the
// lowest primitives (local status bridge, remote RPC, remote capability probe, contact signal)
// are deferred promises, so each phase is observed while its real promise is pending, rejected
// or settled. No wall-clock thresholds and no fake timers: desktop retry is contact regained.

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'

const mocks = vi.hoisted(() => ({
  callRpc:
    vi.fn<(target: RuntimeClientTarget, method: string, params?: unknown) => Promise<unknown>>(),
  supports: vi.fn<(environmentId: string, capability: string) => Promise<boolean>>(),
  contactRegained: new Map<string, () => void>(),
  enqueue: vi.fn(),
  hold: vi.fn<(sessionId: string, id: string, encoded: string) => Promise<unknown> | null>(),
  toastError: vi.fn<(message: string) => void>()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.callRpc,
  runtimeEnvironmentSupportsCapability: mocks.supports
}))

vi.mock('@/runtime/runtime-host-contact-regained', () => ({
  subscribeRuntimeHostContactRegained: (environmentId: string, listener: () => void) => {
    mocks.contactRegained.set(environmentId, listener)
    return () => mocks.contactRegained.delete(environmentId)
  }
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

const CAPABILITY = AGENT_SESSION_CODEX_SERVICE_TIERS_RUNTIME_CAPABILITY
const LOCAL: RuntimeClientTarget = { kind: 'local' }
const ENV_A: RuntimeClientTarget = { kind: 'environment', environmentId: 'server-a' }
const ENV_B: RuntimeClientTarget = { kind: 'environment', environmentId: 'server-b' }

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

const SAVED_ULTRA_OPTIONS = {
  ...TIERED_OPTIONS,
  current: { model: MODEL_ID, serviceTier: ULTRAFAST.value, confirmed: ['model', 'serviceTier'] },
  speed: { selection: { tierId: ULTRAFAST.value, state: 'ready' } }
}

const LEGACY_SAVED_ULTRA_OPTIONS = {
  ...TIERED_OPTIONS,
  current: {
    model: MODEL_ID,
    serviceTier: ULTRAFAST.value,
    fastMode: true,
    confirmed: ['model', 'serviceTier', 'fastMode']
  }
}

const LIVE_CATALOG = {
  origin: 'live-session',
  models: TIERED_OPTIONS.models,
  fastModeSupport: { supported: true },
  fetchedAt: 1
}

// Public CodexSpeedLine discriminants (client presentation only, not wire fields).
const LOADING_LINE = 'loading'
const UNVERIFIED_LINE = 'support-unverified'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

type RpcCall = {
  targetKey: string
  method: string
  params: unknown
  reply: Deferred<unknown>
  done: boolean
}
type SupportProbe = { environmentId: string; reply: Deferred<boolean>; done: boolean }
type StatusRead = { reply: Deferred<{ capabilities?: string[] }>; done: boolean }

const rpcCalls: RpcCall[] = []
const supportProbes: SupportProbe[] = []
const statusReads: StatusRead[] = []
const unmounts: (() => void)[] = []
let sessions = 0

function targetKey(target: RuntimeClientTarget): string {
  return target.kind === 'local' ? 'local' : target.environmentId
}

async function flushMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 6; tick += 1) {
    await Promise.resolve()
  }
}

function latestRpc(method: string, key: string): RpcCall | undefined {
  const open = rpcCalls.filter(
    (call) => call.method === method && call.targetKey === key && !call.done
  )
  return open.at(-1)
}

async function pendingRpc(method: string, key: string): Promise<RpcCall> {
  await waitFor(() => expect(latestRpc(method, key)).toBeDefined())
  const call = latestRpc(method, key)
  if (!call) {
    throw new Error(`no pending ${method} for ${key}`)
  }
  return call
}

async function answer(method: string, key: string, value: unknown): Promise<void> {
  const call = await pendingRpc(method, key)
  call.done = true
  await act(async () => {
    call.reply.resolve(value)
    await flushMicrotasks()
  })
}

async function failRpc(method: string, key: string): Promise<void> {
  const call = await pendingRpc(method, key)
  call.done = true
  await act(async () => {
    call.reply.reject(new Error('synthetic_rpc_failure'))
    await flushMicrotasks()
  })
}

async function settleProbe(index: number, result: boolean | 'reject'): Promise<void> {
  await waitFor(() => expect(supportProbes.length).toBeGreaterThan(index))
  const probe = supportProbes[index]
  if (!probe) {
    throw new Error(`no support probe ${index}`)
  }
  probe.done = true
  await act(async () => {
    if (result === 'reject') {
      probe.reply.reject(new Error('synthetic_probe_failure'))
    } else {
      probe.reply.resolve(result)
    }
    await flushMicrotasks()
  })
}

async function settleStatus(result: { capabilities: string[] } | 'reject'): Promise<void> {
  await waitFor(() => expect(statusReads.length).toBeGreaterThan(0))
  const read = statusReads[0]
  if (!read) {
    throw new Error('no local status read')
  }
  read.done = true
  await act(async () => {
    if (result === 'reject') {
      read.reply.reject(new Error('synthetic_status_failure'))
    } else {
      read.reply.resolve(result)
    }
    await flushMicrotasks()
  })
}

function stubLocalStatusBridge(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      runtime: {
        getStatus: () => {
          const reply = deferred<{ capabilities?: string[] }>()
          statusReads.push({ reply, done: false })
          return reply.promise
        }
      }
    }
  })
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

// A rerender that omits fence or turnId keeps the defaults the earlier cases rely on.
type RenderProps = { target: RuntimeClientTarget; fence?: number; turnId?: string | null }

function renderOptions(target: RuntimeClientTarget, mutate = mutateWith(async () => null).mutate) {
  const sessionId = `codex-speed-loading-${++sessions}`
  const initialProps: RenderProps = { target }
  const view = renderHook(
    (props: RenderProps) =>
      useStructuredAgentSessionOptions({
        agent: 'codex',
        sessionId,
        target: props.target,
        transportEnabled: true,
        isVisible: true,
        providerVisible: true,
        fence: props.fence ?? 1,
        turnId: props.turnId ?? null,
        unloadedTurnRevisions: undefined,
        mutate
      }),
    { initialProps }
  )
  unmounts.push(view.unmount)
  return view
}

type OptionsView = ReturnType<typeof renderOptions>['result']

function descriptor(result: OptionsView, id: string): SessionOptionDescriptor | undefined {
  return result.current.optionSnapshot.find((entry) => entry.id === id)
}

function speedSelect(result: OptionsView) {
  const speed = descriptor(result, 'serviceTier')
  return speed?.kind.type === 'select' ? speed.kind : undefined
}

function hasSpeedLine(result: OptionsView, kind: string): boolean {
  return result.current.optionSurface.getSpeedLines().some((line) => line.kind === kind)
}

function setOptionCalls(calls: ReturnType<typeof vi.fn<MutateCall>>): unknown[] {
  return calls.mock.calls
    .filter(([method]) => method === 'agentSession.setOption')
    .map(([, , fields]) => fields)
}

beforeEach(() => {
  mocks.callRpc.mockImplementation((target, method, params) => {
    const reply = deferred<unknown>()
    rpcCalls.push({ targetKey: targetKey(target), method, params, reply, done: false })
    return reply.promise
  })
  mocks.supports.mockImplementation((environmentId) => {
    const reply = deferred<boolean>()
    supportProbes.push({ environmentId, reply, done: false })
    return reply.promise
  })
  resetHostModelCatalogSnapshotsForTests()
})

afterEach(() => {
  // Unmount first, then settle every leftover so no joined listing wait outlives its test.
  unmounts.splice(0).forEach((unmount) => unmount())
  for (const open of [...rpcCalls, ...supportProbes, ...statusReads]) {
    if (!open.done) {
      open.reply.reject(new Error('teardown'))
    }
  }
  rpcCalls.length = 0
  supportProbes.length = 0
  statusReads.length = 0
  mocks.contactRegained.clear()
  mocks.callRpc.mockReset()
  mocks.supports.mockReset()
  mocks.enqueue.mockReset()
  mocks.hold.mockReset()
  mocks.toastError.mockReset()
  setLocalRuntimeCapabilitiesForTests(null)
  Reflect.deleteProperty(window, 'api')
})

describe('speed picker loading phases', () => {
  it('shows loading while a cold local capability, options read and catalog read are pending', async () => {
    setLocalRuntimeCapabilitiesForTests(null)
    stubLocalStatusBridge()
    const { result } = renderOptions(LOCAL)
    await waitFor(() => expect(statusReads).toHaveLength(1))

    expect(hasSpeedLine(result, LOADING_LINE)).toBe(true)
    expect(speedSelect(result)).toBeUndefined()
  })

  it.each(['options', 'catalog'] as const)(
    'stays loading until both reads answer when the %s read answers first',
    async (first) => {
      setLocalRuntimeCapabilitiesForTests([CAPABILITY])
      const { result } = renderOptions(LOCAL)
      const reads = {
        options: ['agentSession.options', TIERED_OPTIONS],
        catalog: ['agentSession.modelCatalog', LIVE_CATALOG]
      } as const
      const second = first === 'options' ? 'catalog' : 'options'
      await waitFor(() => expect(hasSpeedLine(result, LOADING_LINE)).toBe(true))

      await answer(reads[first][0], 'local', reads[first][1])
      expect(hasSpeedLine(result, LOADING_LINE)).toBe(true)

      await answer(reads[second][0], 'local', reads[second][1])
      await waitFor(() => expect(hasSpeedLine(result, LOADING_LINE)).toBe(false))
      expect(speedSelect(result)).toBeDefined()
    }
  )

  it('reads a failed probe and failed reads as unverified, never as stuck loading', async () => {
    setLocalRuntimeCapabilitiesForTests(null)
    stubLocalStatusBridge()
    const { mutate, calls } = mutateWith(async () => null)
    const { result } = renderOptions(LOCAL, mutate)
    await waitFor(() => expect(statusReads).toHaveLength(1))
    expect(hasSpeedLine(result, LOADING_LINE)).toBe(true)

    await settleStatus('reject')
    await failRpc('agentSession.options', 'local')
    await failRpc('agentSession.modelCatalog', 'local')

    await waitFor(() => expect(hasSpeedLine(result, LOADING_LINE)).toBe(false))
    expect(hasSpeedLine(result, UNVERIFIED_LINE)).toBe(true)
    let applied = true
    await act(async () => {
      applied = await result.current.setStructuredOption('serviceTier', FAST.value)
    })
    expect(applied).toBe(false)
    expect(calls).not.toHaveBeenCalled()
  })

  it('becomes pending again on regained contact after a failed remote probe, then settles', async () => {
    const { result } = renderOptions(ENV_A)
    await settleProbe(0, 'reject')
    await answer('agentSession.options', 'server-a', TIERED_OPTIONS)
    await answer('agentSession.modelCatalog', 'server-a', LIVE_CATALOG)
    await waitFor(() => expect(hasSpeedLine(result, LOADING_LINE)).toBe(false))
    // The saved canonical Standard is retained but visibly disabled while support is unknown.
    const unverified = speedSelect(result)
    expect(unverified?.currentValue).toBe(STANDARD.value)
    expect(unverified?.choices.find((choice) => choice.value === STANDARD.value)?.disabled).toBe(
      true
    )

    act(() => {
      mocks.contactRegained.get('server-a')?.()
    })
    await waitFor(() => expect(supportProbes).toHaveLength(2))
    expect(hasSpeedLine(result, LOADING_LINE)).toBe(true)

    await settleProbe(1, true)
    await answer('agentSession.options', 'server-a', TIERED_OPTIONS)
    await answer('agentSession.modelCatalog', 'server-a', LIVE_CATALOG)
    await waitFor(() => expect(hasSpeedLine(result, LOADING_LINE)).toBe(false))
    const supported = speedSelect(result)
    expect(supported?.currentValue).toBe(STANDARD.value)
    expect(supported?.choices.find((choice) => choice.value === STANDARD.value)?.disabled).not.toBe(
      true
    )
  })

  it('exits loading when a joined listing wait fails and keeps the answered choices', async () => {
    setLocalRuntimeCapabilitiesForTests([CAPABILITY])
    const { result } = renderOptions(LOCAL)
    await answer('agentSession.options', 'local', TIERED_OPTIONS)
    await answer('agentSession.modelCatalog', 'local', { ...LIVE_CATALOG, listingInProgress: true })
    await waitFor(() =>
      expect(
        rpcCalls.some(
          (call) =>
            call.method === 'agentSession.modelCatalog' &&
            JSON.stringify(call.params).includes('waitForListing')
        )
      ).toBe(true)
    )
    expect(hasSpeedLine(result, LOADING_LINE)).toBe(true)

    await failRpc('agentSession.modelCatalog', 'local')

    await waitFor(() => expect(hasSpeedLine(result, LOADING_LINE)).toBe(false))
    expect(speedSelect(result)?.choices).toEqual([STANDARD, FAST, ULTRAFAST])
  })

  it('keeps loading through a supported settlement until the shaped reads answer, with exact choices', async () => {
    const { result } = renderOptions(ENV_A)
    await answer('agentSession.options', 'server-a', TIERED_OPTIONS)
    await answer('agentSession.modelCatalog', 'server-a', LIVE_CATALOG)
    expect(hasSpeedLine(result, LOADING_LINE)).toBe(true)

    await settleProbe(0, true)
    // The host now shapes the list, so it is read again; the old answer is not the settled one.
    expect(hasSpeedLine(result, LOADING_LINE)).toBe(true)
    await answer('agentSession.options', 'server-a', TIERED_OPTIONS)
    await answer('agentSession.modelCatalog', 'server-a', LIVE_CATALOG)

    await waitFor(() => expect(hasSpeedLine(result, LOADING_LINE)).toBe(false))
    expect(speedSelect(result)?.choices).toEqual([STANDARD, FAST, ULTRAFAST])
    expect(descriptor(result, 'fastMode')).toBeUndefined()
  })

  it.each([true, 'reject'] as const)(
    'ignores a previous host probe that completes (%s) after the session moved hosts',
    async (late) => {
      const { result, rerender } = renderOptions(ENV_A)
      await waitFor(() => expect(supportProbes).toHaveLength(1))
      rerender({ target: ENV_B })
      await waitFor(() => expect(supportProbes).toHaveLength(2))
      expect(supportProbes[1]?.environmentId).toBe('server-b')

      await settleProbe(0, late)
      expect(hasSpeedLine(result, LOADING_LINE)).toBe(true)
      expect(speedSelect(result)).toBeUndefined()

      await settleProbe(1, false)
      await answer('agentSession.options', 'server-b', TIERED_OPTIONS)
      await answer('agentSession.modelCatalog', 'server-b', LIVE_CATALOG)
      await waitFor(() => expect(hasSpeedLine(result, LOADING_LINE)).toBe(false))
      expect(descriptor(result, 'fastMode')).toBeDefined()
      expect(speedSelect(result)).toBeUndefined()
    }
  )

  it.each(['pending', 'failed'] as const)(
    'keeps a saved opaque Ultra visible as a disabled canonical row while the capability is %s',
    async (unresolved) => {
      const { mutate, calls } = mutateWith(async () => null)
      const { result } = renderOptions(ENV_A, mutate)
      if (unresolved === 'failed') {
        await settleProbe(0, 'reject')
      }
      await answer('agentSession.options', 'server-a', SAVED_ULTRA_OPTIONS)
      await answer('agentSession.modelCatalog', 'server-a', LIVE_CATALOG)

      const select = speedSelect(result)
      expect(select?.currentValue).toBe(ULTRAFAST.value)
      expect(select?.choices.find((choice) => choice.value === ULTRAFAST.value)?.disabled).toBe(
        true
      )
      expect(
        result.current.optionSurface
          .getSpeedLines()
          .some((line) => ['stored', 'requested', 'pending'].includes(line.kind))
      ).toBe(true)

      let applied = true
      await act(async () => {
        applied = await result.current.setStructuredOption('serviceTier', STANDARD.value)
      })
      expect(applied).toBe(false)
      expect(calls).not.toHaveBeenCalled()
      expect(mocks.hold).not.toHaveBeenCalled()
    }
  )

  it('retains the Fast control and explicit legacy recovery once an older host is confirmed', async () => {
    const { mutate, calls } = mutateWith(async () => ({
      key: 'fastMode',
      value: 'false',
      options: { model: MODEL_ID, serviceTier: ULTRAFAST.value, fastMode: 'false' }
    }))
    const { result } = renderOptions(ENV_A, mutate)
    await answer('agentSession.options', 'server-a', LEGACY_SAVED_ULTRA_OPTIONS)
    await answer('agentSession.modelCatalog', 'server-a', LIVE_CATALOG)
    expect(speedSelect(result)?.currentValue).toBe(ULTRAFAST.value)

    await settleProbe(0, false)
    await answer('agentSession.options', 'server-a', LEGACY_SAVED_ULTRA_OPTIONS)
    await answer('agentSession.modelCatalog', 'server-a', LIVE_CATALOG)

    await waitFor(() => expect(hasSpeedLine(result, LOADING_LINE)).toBe(false))
    await waitFor(() => expect(descriptor(result, 'fastMode')).toBeDefined())
    expect(speedSelect(result)).toBeUndefined()
    let applied = false
    await act(async () => {
      applied = await result.current.setStructuredOption('fastMode', false)
    })
    expect(applied).toBe(true)
    expect(setOptionCalls(calls)).toEqual([{ key: 'fastMode', value: 'false' }])
    expect(mocks.toastError).not.toHaveBeenCalled()
  })
})

async function answerInitialLocalReads(result: OptionsView): Promise<void> {
  await answer('agentSession.options', 'local', TIERED_OPTIONS)
  await answer('agentSession.modelCatalog', 'local', LIVE_CATALOG)
  await waitFor(() => expect(hasSpeedLine(result, LOADING_LINE)).toBe(false))
  expect(speedSelect(result)?.choices).toEqual([STANDARD, FAST, ULTRAFAST])
}

function isOpenListingWait(call: RpcCall): boolean {
  return (
    call.method === 'agentSession.modelCatalog' &&
    !call.done &&
    JSON.stringify(call.params).includes('waitForListing')
  )
}

// After the first answers every phase is settled, so each later real read must track its own wait
// rather than inherit the earlier answer: pending while out, failed (never settled) on rejection.
describe('speed picker phases after the first answers settled', () => {
  it('shows loading while a turn re-read of settled options is out, then unverified when it fails', async () => {
    setLocalRuntimeCapabilitiesForTests([CAPABILITY])
    const { result, rerender } = renderOptions(LOCAL)
    await answerInitialLocalReads(result)

    rerender({ target: LOCAL, turnId: 'turn-2' })
    await pendingRpc('agentSession.options', 'local')
    expect(hasSpeedLine(result, LOADING_LINE)).toBe(true)

    await failRpc('agentSession.options', 'local')
    await waitFor(() => expect(hasSpeedLine(result, LOADING_LINE)).toBe(false))
    expect(hasSpeedLine(result, UNVERIFIED_LINE)).toBe(true)
    expect(speedSelect(result)?.choices).toEqual([STANDARD, FAST, ULTRAFAST])
  })

  it.each(['re-read', 'joined listing wait'] as const)(
    'shows loading while only a settled catalog is read again, then unverified when its %s fails',
    async (failing) => {
      setLocalRuntimeCapabilitiesForTests([CAPABILITY])
      const { result, rerender } = renderOptions(LOCAL)
      await answerInitialLocalReads(result)

      // A new fence reads the same-shaped catalog again; answering options leaves only that wait.
      rerender({ target: LOCAL, fence: 2 })
      await answer('agentSession.options', 'local', TIERED_OPTIONS)
      await pendingRpc('agentSession.modelCatalog', 'local')
      expect(hasSpeedLine(result, LOADING_LINE)).toBe(true)

      if (failing === 'joined listing wait') {
        await answer('agentSession.modelCatalog', 'local', {
          ...LIVE_CATALOG,
          listingInProgress: true
        })
        await waitFor(() => expect(rpcCalls.some(isOpenListingWait)).toBe(true))
        expect(hasSpeedLine(result, LOADING_LINE)).toBe(true)
      }

      await failRpc('agentSession.modelCatalog', 'local')
      await waitFor(() => expect(hasSpeedLine(result, LOADING_LINE)).toBe(false))
      expect(hasSpeedLine(result, UNVERIFIED_LINE)).toBe(true)
    }
  )

  it('shows loading while the options read after an accepted speed write is out, then unverified when it fails', async () => {
    setLocalRuntimeCapabilitiesForTests([CAPABILITY])
    const { mutate, calls } = mutateWith(async () => ({
      key: 'serviceTier',
      value: FAST.value,
      options: { model: MODEL_ID, serviceTier: FAST.value }
    }))
    const { result } = renderOptions(LOCAL, mutate)
    await answerInitialLocalReads(result)

    let applied = false
    await act(async () => {
      applied = await result.current.setStructuredOption('serviceTier', FAST.value)
    })
    expect(applied).toBe(true)
    await pendingRpc('agentSession.options', 'local')
    expect(hasSpeedLine(result, LOADING_LINE)).toBe(true)

    await failRpc('agentSession.options', 'local')
    await waitFor(() => expect(hasSpeedLine(result, LOADING_LINE)).toBe(false))
    expect(hasSpeedLine(result, UNVERIFIED_LINE)).toBe(true)
    // The refused read is not evidence about the write: no second request, no requested tier.
    expect(setOptionCalls(calls)).toEqual([{ key: 'serviceTier', value: FAST.value }])
    expect(hasSpeedLine(result, 'requested')).toBe(false)
    expect(speedSelect(result)?.choices).toEqual([STANDARD, FAST, ULTRAFAST])
    expect(mocks.toastError).not.toHaveBeenCalled()
  })
})

// A host confirmed older never offers the speed select, so its other reads failing or running again
// are not speed waits: no loading or unverified caption, and the legacy Fast control stays usable.
// A real new capability probe beside it is still a speed wait and still shows.
describe('speed captions on a host confirmed older', () => {
  async function mountOlderHost(mutate = mutateWith(async () => null).mutate) {
    const view = renderOptions(ENV_A, mutate)
    await answer('agentSession.options', 'server-a', LEGACY_SAVED_ULTRA_OPTIONS)
    await answer('agentSession.modelCatalog', 'server-a', LIVE_CATALOG)
    await settleProbe(0, false)
    return view
  }

  async function answerOlderHostReads(result: OptionsView): Promise<void> {
    await answer('agentSession.options', 'server-a', LEGACY_SAVED_ULTRA_OPTIONS)
    await answer('agentSession.modelCatalog', 'server-a', LIVE_CATALOG)
    await waitFor(() => expect(hasSpeedLine(result, LOADING_LINE)).toBe(false))
    await waitFor(() => expect(descriptor(result, 'fastMode')).toBeDefined())
  }

  function expectNoSpeedCaption(result: OptionsView): void {
    expect(hasSpeedLine(result, LOADING_LINE)).toBe(false)
    expect(hasSpeedLine(result, UNVERIFIED_LINE)).toBe(false)
    expect(descriptor(result, 'fastMode')).toBeDefined()
    expect(speedSelect(result)).toBeUndefined()
  }

  it('shows no caption when its catalog read is rejected, keeping the legacy Fast control usable', async () => {
    const { mutate, calls } = mutateWith(async () => ({
      key: 'fastMode',
      value: 'false',
      options: { model: MODEL_ID, serviceTier: ULTRAFAST.value, fastMode: 'false' }
    }))
    const { result } = await mountOlderHost(mutate)
    await answer('agentSession.options', 'server-a', LEGACY_SAVED_ULTRA_OPTIONS)
    await failRpc('agentSession.modelCatalog', 'server-a')

    await waitFor(() => expect(descriptor(result, 'fastMode')).toBeDefined())
    expectNoSpeedCaption(result)
    let applied = false
    await act(async () => {
      applied = await result.current.setStructuredOption('fastMode', false)
    })
    expect(applied).toBe(true)
    expect(setOptionCalls(calls)).toEqual([{ key: 'fastMode', value: 'false' }])
  })

  it.each(['pending', 'failed'] as const)(
    'shows no caption while a later turn options read is %s, keeping the legacy Fast control',
    async (unresolved) => {
      const { result, rerender } = await mountOlderHost()
      await answerOlderHostReads(result)
      expectNoSpeedCaption(result)

      rerender({ target: ENV_A, turnId: 'turn-2' })
      await pendingRpc('agentSession.options', 'server-a')
      if (unresolved === 'failed') {
        await failRpc('agentSession.options', 'server-a')
      }

      expectNoSpeedCaption(result)
    }
  )

  it.each(['pending', 'failed'] as const)(
    'still shows a new capability probe that is %s once contact is regained',
    async (probe) => {
      const { result } = await mountOlderHost()
      await answerOlderHostReads(result)

      act(() => {
        mocks.contactRegained.get('server-a')?.()
      })
      await waitFor(() => expect(supportProbes).toHaveLength(2))
      expect(hasSpeedLine(result, LOADING_LINE)).toBe(true)
      if (probe === 'failed') {
        // The failed probe makes the host unknown again, so both reads are asked once more.
        await settleProbe(1, 'reject')
        await answer('agentSession.options', 'server-a', LEGACY_SAVED_ULTRA_OPTIONS)
        await answer('agentSession.modelCatalog', 'server-a', LIVE_CATALOG)
        await waitFor(() => expect(hasSpeedLine(result, LOADING_LINE)).toBe(false))
        expect(hasSpeedLine(result, UNVERIFIED_LINE)).toBe(true)
      }
    }
  )
})
