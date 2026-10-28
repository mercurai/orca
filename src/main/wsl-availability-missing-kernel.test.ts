import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  runProcess,
  type ProcessResult,
  type ProcessSpec
} from '../shared/child-process/run-process'
import { _resetWslAvailabilityCacheForTests, isWslAvailableAsync } from './wsl-availability'

vi.mock('../shared/child-process/run-process', () => ({
  runProcess: vi.fn(),
  runProcessSync: vi.fn()
}))
vi.mock('./wsl-interop-spawn-directory', () => ({
  resolveWslInteropSpawnCwd: () => 'C:\\Windows'
}))

const originalPlatform = process.platform
const success: ProcessResult = {
  code: 0,
  signal: null,
  stdout: '',
  stderr: '',
  timedOut: false
}

beforeEach(() => {
  vi.resetAllMocks()
  Object.defineProperty(process, 'platform', { value: 'win32' })
  _resetWslAvailabilityCacheForTests()
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  _resetWslAvailabilityCacheForTests()
})

describe('WSL1 availability without WSL2 kernel', () => {
  const probe = () => isWslAvailableAsync()
  // The guest spawn is identified by argv.
  const guestCalls = () =>
    vi.mocked(runProcess).mock.calls.filter(([spec]) => spec.args?.includes('/bin/true'))

  /** `--status` exits `code`; the guest probe answers with `guest` (thrown/rejected if an Error). */
  function wire(code: number, guest: ProcessResult | Error): void {
    const answer = (spec: ProcessSpec): ProcessResult => {
      if (spec.args?.[0] === '--status') {
        return { ...success, code }
      }
      if (guest instanceof Error) {
        throw guest
      }
      return guest
    }
    vi.mocked(runProcess).mockImplementation((spec) => {
      try {
        return Promise.resolve(answer(spec))
      } catch (error) {
        return Promise.reject(error)
      }
    })
  }

  // Node reports the Windows DWORD; the console prints its signed equivalent.
  for (const status of [-444, 4_294_966_852]) {
    it(`requires guest execution and caches its success for ${status}`, async () => {
      wire(status, success)
      expect(await probe()).toBe(true)
      expect(await probe()).toBe(true)
      expect(guestCalls()).toHaveLength(1)
      expect(guestCalls()[0]).toEqual([
        expect.objectContaining({
          program: 'wsl.exe',
          args: ['--exec', '/bin/true'],
          timeoutMs: 5000,
          cwd: 'C:\\Windows'
        })
      ])
    })
  }

  for (const result of [
    { ...success, code: 1 },
    { ...success, code: null, timedOut: true }
  ]) {
    it(`keeps a failed guest unavailable: ${JSON.stringify(result)}`, async () => {
      wire(-444, result)
      expect(await probe()).toBe(false)
    })
  }

  it('stays unavailable when the guest probe cannot be spawned', async () => {
    wire(-444, new Error('EPERM'))
    expect(await probe()).toBe(false)
  })

  it('does not probe a guest for unrelated status failures', async () => {
    wire(1, success)
    expect(await probe()).toBe(false)
    expect(guestCalls()).toHaveLength(0)
  })
})
