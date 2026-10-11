import { expect, vi } from 'vitest'
import { runProcess, runProcessSync } from './child-process/run-process'
import { resetSecureFileWindowsUserSidForTests } from './secure-path-windows-acl'

const OK = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }

/** The caller's file must `vi.mock('<rel>/shared/child-process/run-process', ...)` with vi.fn() twins. */
export async function expectNoSyncSpawnOnWin32(run: () => Promise<void>): Promise<void> {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  vi.mocked(runProcess).mockReset()
  vi.mocked(runProcessSync).mockReset()
  vi.mocked(runProcess).mockImplementation(async (spec) =>
    spec.program.endsWith('whoami.exe') ? { ...OK, stdout: '"USER","S-1-5-21-1000"' } : OK
  )
  resetSecureFileWindowsUserSidForTests()
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  try {
    await run()
    expect(runProcessSync).not.toHaveBeenCalled()
  } finally {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    resetSecureFileWindowsUserSidForTests()
    vi.mocked(runProcess).mockReset()
    vi.mocked(runProcessSync).mockReset()
  }
}
