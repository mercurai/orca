import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CODEX_SPEED_SELECTION_RUNTIME_CAPABILITY } from '../../../shared/agent-session-create-capabilities'
import { prepareCodexSpeedWireOptions } from './codex-speed-selection'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('./runtime-rpc-client', () => ({ callRuntimeRpc: mocks.call }))
const TARGET = { kind: 'local' } as const
const FAST = 'synthetic-fast-exact-id'
const catalog = {
  origin: 'probe', fetchedAt: 1_000, listingNamesConfiguredModel: true,
  models: [
    { id: 'model-default', isDefault: true, efforts: [], serviceTiers: [{ value: FAST, label: 'Fast' }] },
    { id: 'model-other', isDefault: false, efforts: [], serviceTiers: [] }
  ]
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  mocks.call.mockReset()
  mocks.call.mockImplementation(async (_target, method) => {
    if (method === 'status.get') {
      return { runtimeId: 'synthetic-runtime', capabilities: [] }
    }
    if (method === 'agentSession.options') {
      return { current: { model: 'model-other' } }
    }
    return catalog
  })
})
afterEach(() => vi.useRealTimers())

describe('catalog proof for legacy Codex speed requests', () => {
  it('maps only an exact advertised Fast id for an explicitly selected model', async () => {
    expect(await prepareCodexSpeedWireOptions({
      target: TARGET, worktree: 'id:synthetic', options: { model: 'model-default', serviceTier: FAST }
    })).toMatchObject({ options: { model: 'model-default', fastMode: 'true' } })
  })

  it('does not authorize Fast from a stale catalog', async () => {
    vi.setSystemTime(11 * 60_000)
    await expect(prepareCodexSpeedWireOptions({
      target: TARGET, worktree: 'id:synthetic', options: { model: 'model-default', serviceTier: FAST }
    })).rejects.toThrow(/speed|tier|host|catalog/i)
  })

  it('uses the pinned session model rather than the configured default for a tier-only pick', async () => {
    await expect(prepareCodexSpeedWireOptions({
      target: TARGET, sessionId: 'synthetic-session', options: { serviceTier: FAST }
    })).rejects.toThrow(/speed|tier|host|catalog/i)
    expect(mocks.call).toHaveBeenCalledWith(TARGET, 'agentSession.options',
      { sessionId: 'synthetic-session' }, expect.anything())
  })

  it('refuses Fast when account catalog refresh is unavailable', async () => {
    mocks.call.mockImplementation(async (_target, method) => method === 'status.get'
      ? { runtimeId: 'synthetic-runtime', capabilities: [] }
      : { ...catalog, unavailable: { reason: 'synthetic-refresh-failure' } })
    await expect(prepareCodexSpeedWireOptions({
      target: TARGET, worktree: 'id:synthetic', options: { model: 'model-default', serviceTier: FAST }
    })).rejects.toThrow(/speed|tier|host|catalog/i)
  })

  it.each(['loading', 'unknown'] as const)('rejects explicit %s catalog confidence despite fresh rows', async (catalogState) => {
    mocks.call.mockImplementation(async (_target, method) => method === 'status.get'
      ? { runtimeId: 'synthetic-runtime', capabilities: [] }
      : { ...catalog, catalogState })
    await expect(prepareCodexSpeedWireOptions({
      target: TARGET, worktree: 'id:synthetic', options: { model: 'model-default', serviceTier: FAST }
    })).rejects.toThrow(/speed|tier|host|catalog/i)
  })

  it('retains exact modern tier ids and does not substitute a legacy toggle', async () => {
    mocks.call.mockResolvedValue({ runtimeId: 'synthetic-runtime',
      capabilities: [CODEX_SPEED_SELECTION_RUNTIME_CAPABILITY] })
    const options = { model: 'model-other', serviceTier: 'synthetic-ultrafast-id' }
    expect(await prepareCodexSpeedWireOptions({ target: TARGET, options })).toMatchObject({ options })
    expect(mocks.call).toHaveBeenCalledTimes(1)
  })
})

describe('frozen Fast wire requests across host upgrades', () => {
  it('replays legacy true after an upgrade when the exact canonical Fast id is still advertised', async () => {
    mocks.call.mockImplementation(async (_target, method) => method === 'status.get'
      ? { runtimeId: 'synthetic-runtime', capabilities: [CODEX_SPEED_SELECTION_RUNTIME_CAPABILITY] }
      : catalog)
    const frozenOptions = { model: 'model-default', fastMode: 'true' }
    expect(await prepareCodexSpeedWireOptions({ target: TARGET, worktree: 'id:synthetic',
      options: { model: 'model-default', serviceTier: FAST }, frozenOptions
    })).toMatchObject({ options: frozenOptions })
  })

  it('does not send a frozen canonical request after a downgrade that requires boolean encoding', async () => {
    const options = { model: 'model-default', serviceTier: FAST }
    await expect(prepareCodexSpeedWireOptions({ target: TARGET, worktree: 'id:synthetic',
      options, frozenOptions: options
    })).rejects.toThrow(/speed|tier|replay/i)
  })
})
