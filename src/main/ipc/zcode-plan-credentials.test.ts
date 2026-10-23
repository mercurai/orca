import { createEmptyRateLimitState } from '../../shared/rate-limit-state-factory'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerZcodePlanCredentialsHandlers } from './zcode-plan-credentials'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  hasKey: vi.fn(() => false),
  protection: vi.fn<() => 'sealed' | 'plaintext' | null>(() => null),
  hasCli: vi.fn(() => false),
  save: vi.fn(),
  clear: vi.fn()
}))
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../zcode/zcode-plan-api-key-store', () => ({
  hasZcodePlanApiKey: mocks.hasKey,
  getZcodePlanApiKeyProtection: mocks.protection,
  saveZcodePlanApiKey: mocks.save,
  clearZcodePlanApiKey: mocks.clear,
  API_KEY_ENVELOPE_PREFIX: 'zcode:',
  getZcodePlanApiKeyPath: () => 'zcode-key-path'
}))
// The files are mocked away; readability has its own coverage in the RPC test.
vi.mock('../credentials/saved-credential-readability', () => ({
  savedCredentialUnreadable: () => undefined,
  refuseCredentialSealedElsewhere: () => {
    throw new Error('unused')
  }
}))
vi.mock('../rate-limits/zcode-usage-fetcher', () => ({ hasZcodeCliPlanCredentials: mocks.hasCli }))

function handler(channel: string) {
  const registration = mocks.handle.mock.calls.findLast(([name]) => name === channel)
  if (!registration) {
    throw new Error('Handler missing')
  }
  return registration[1]
}

describe('GLM credential IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.hasKey.mockReturnValue(false)
    mocks.hasCli.mockReturnValue(false)
    mocks.protection.mockReturnValue(null)
    registerZcodePlanCredentialsHandlers(null)
  })

  it('waits for durable save before returning status', async () => {
    const refresh = vi.fn(() => Promise.resolve(createEmptyRateLimitState()))
    const invalidateZcodeCredentialState = vi.fn()
    registerZcodePlanCredentialsHandlers({
      refresh,
      invalidateZcodeCredentialState
    })
    let release!: () => void
    mocks.save.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    let acknowledged = false
    const pending = Promise.resolve(
      handler('zcodePlanCredentials:saveApiKey')(null, 'synthetic-key')
    ).then((value) => {
      acknowledged = true
      return value
    })
    await Promise.resolve()
    expect(mocks.save).toHaveBeenCalledWith('synthetic-key')
    expect(mocks.hasKey).not.toHaveBeenCalled()
    expect(acknowledged).toBe(false)
    expect(refresh).not.toHaveBeenCalled()
    expect(invalidateZcodeCredentialState).not.toHaveBeenCalled()
    release()
    await pending
    expect(mocks.hasKey).toHaveBeenCalledTimes(1)
    expect(acknowledged).toBe(true)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(invalidateZcodeCredentialState).toHaveBeenCalledTimes(1)
  })

  it('propagates durable save failure without reading status or refreshing', async () => {
    const refresh = vi.fn(() => Promise.resolve(createEmptyRateLimitState()))
    const invalidateZcodeCredentialState = vi.fn()
    registerZcodePlanCredentialsHandlers({
      refresh,
      invalidateZcodeCredentialState
    })
    mocks.save.mockRejectedValueOnce(new Error('synthetic persistence failure'))
    await expect(handler('zcodePlanCredentials:saveApiKey')(null, 'synthetic-key')).rejects.toThrow(
      'synthetic persistence failure'
    )
    expect(refresh).not.toHaveBeenCalled()
    expect(invalidateZcodeCredentialState).not.toHaveBeenCalled()
    expect(mocks.hasKey).not.toHaveBeenCalled()
  })

  it('returns only presence and protection without exposing the key', () => {
    mocks.hasKey.mockReturnValue(true)
    mocks.hasCli.mockReturnValue(true)
    mocks.protection.mockReturnValue('sealed')
    expect(handler('zcodePlanCredentials:getStatus')()).toEqual({
      apiKeyConfigured: true,
      zcodeCliConfigured: true,
      apiKeyProtection: 'sealed',
      apiKeyUnreadable: undefined
    })
  })

  it('validates an untyped IPC key before persistence', async () => {
    await expect(handler('zcodePlanCredentials:saveApiKey')(null, 42)).rejects.toThrow(
      'must be a string'
    )
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('saves and removes keys while returning status only', async () => {
    mocks.save.mockImplementationOnce(async () => {
      mocks.hasKey.mockReturnValue(true)
    })
    mocks.clear.mockImplementationOnce(() => mocks.hasKey.mockReturnValue(false))
    expect(await handler('zcodePlanCredentials:saveApiKey')(null, 'synthetic-key')).toEqual({
      apiKeyConfigured: true,
      zcodeCliConfigured: false,
      apiKeyProtection: null,
      apiKeyUnreadable: undefined
    })
    expect(handler('zcodePlanCredentials:clearApiKey')()).toEqual({
      apiKeyConfigured: false,
      zcodeCliConfigured: false,
      apiKeyProtection: null,
      apiKeyUnreadable: undefined
    })
  })
})
