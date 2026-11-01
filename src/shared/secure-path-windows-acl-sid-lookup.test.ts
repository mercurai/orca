import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '@orca/process-host/process-spec'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))

vi.mock('@orca/process-host', () => ({
  runProcess: runProcessMock,
  runProcessSync: vi.fn()
}))

const SID = 'S-1-5-21-1-2-3-1001'

const exited = (stdout = '', code = 0): ProcessResult => ({
  code,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false
})

/** Dynamic: the module caches the SID for the process lifetime, so each test needs a fresh copy. */
async function loadModule() {
  vi.resetModules()
  return import('./windows-current-user-sid')
}

beforeEach(() => {
  runProcessMock.mockReset()
})

describe('the current-user SID lookup', () => {
  it('spawns whoami once for concurrent and repeated lookups', async () => {
    runProcessMock.mockResolvedValue(exited(`"DOMAIN\\alice","${SID}"\r\n`))
    const { getCurrentWindowsUserSidAsync } = await loadModule()

    const concurrent = await Promise.all([
      getCurrentWindowsUserSidAsync(),
      getCurrentWindowsUserSidAsync()
    ])
    const repeated = await getCurrentWindowsUserSidAsync()

    expect([...concurrent, repeated]).toEqual([SID, SID, SID])
    expect(runProcessMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry a failed whoami inside 60 s and retries after it', async () => {
    const now = vi.spyOn(performance, 'now')
    now.mockReturnValue(0)
    runProcessMock.mockResolvedValueOnce(exited('', 1))
    runProcessMock.mockResolvedValue(exited(`"DOMAIN\\alice","${SID}"\r\n`))
    const { getCurrentWindowsUserSidAsync } = await loadModule()

    expect(await getCurrentWindowsUserSidAsync()).toBeNull()
    now.mockReturnValue(59_000)
    expect(await getCurrentWindowsUserSidAsync()).toBeNull()
    expect(runProcessMock).toHaveBeenCalledTimes(1)

    now.mockReturnValue(61_000)
    expect(await getCurrentWindowsUserSidAsync()).toBe(SID)
    expect(runProcessMock).toHaveBeenCalledTimes(2)
    now.mockRestore()
  })
})
