import { runProcess, runProcessSync } from '@orca/process-host'
import { expect, vi } from 'vitest'
import {
  resetWindowsSecurityLoadForTests,
  setWindowsSecurityForTests
} from './windows-security-addon'
import { createFakeWindowsSecurity } from './windows-security-addon.test-fixture'

const OK = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }

/**
 * Runs `run` as on win32 with the in-process ACL addon faked, and asserts the secure-file lane
 * started no process at all. The caller's file must `vi.mock('@orca/process-host', ...)` with
 * vi.fn() twins of `runProcess` and `runProcessSync`.
 */
export async function expectNoSyncSpawnOnWin32(run: () => Promise<void>): Promise<void> {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  vi.mocked(runProcess).mockReset()
  vi.mocked(runProcessSync).mockReset()
  vi.mocked(runProcess).mockResolvedValue(OK)
  resetWindowsSecurityLoadForTests()
  setWindowsSecurityForTests(createFakeWindowsSecurity())
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  try {
    await run()
    expect(runProcessSync).not.toHaveBeenCalled()
    expect(runProcess).not.toHaveBeenCalled()
  } finally {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    resetWindowsSecurityLoadForTests()
    setWindowsSecurityForTests(null)
    vi.mocked(runProcess).mockReset()
    vi.mocked(runProcessSync).mockReset()
  }
}
