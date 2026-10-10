import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from './child-process/run-process'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))

vi.mock('./child-process/run-process', () => ({
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

beforeEach(() => {
  runProcessMock.mockReset()
  // Every icacls run succeeds but writes no descriptor for `/save`, so a read-back must fail.
  runProcessMock.mockImplementation(async ({ args }: { args: readonly string[] }) =>
    args[0] === '/user' ? exited(`"DOMAIN\\alice","${SID}"\r\n`) : exited()
  )
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  delete process.env.ORCA_SECURE_FILE_VERIFY
  vi.resetModules()
})

describe('restrictNewFileAsync', () => {
  it('runs reset and grant only, and trusts them', async () => {
    const { restrictNewFileAsync } = await import('./secure-path-windows-acl.js')

    await expect(restrictNewFileAsync('C:\\a.json')).resolves.toBe(true)

    const icacls = runProcessMock.mock.calls.filter(([spec]) => spec.args[0] === 'C:\\a.json')
    expect(icacls.map(([spec]) => spec.args[1])).toEqual(['/reset', '/inheritance:r'])
  })

  it('fails closed on a bad read-back when ORCA_SECURE_FILE_VERIFY=1', async () => {
    process.env.ORCA_SECURE_FILE_VERIFY = '1'
    const { restrictNewFileAsync } = await import('./secure-path-windows-acl.js')

    await expect(restrictNewFileAsync('C:\\a.json')).resolves.toBe(false)

    expect(console.warn).toHaveBeenCalledWith(
      '[secure-path.windows-acl] failed to restrict path',
      expect.objectContaining({ stage: 'verify' })
    )
  })

  it('reports an icacls run cut off by the timeout as a timeout, not as an exit', async () => {
    runProcessMock.mockImplementation(async ({ args }: { args: readonly string[] }) =>
      args[0] === '/user'
        ? exited(`"DOMAIN\\alice","${SID}"\r\n`)
        : { ...exited(), code: null, timedOut: true }
    )
    const { restrictNewFileAsync } = await import('./secure-path-windows-acl.js')

    await expect(restrictNewFileAsync('C:\\a.json')).resolves.toBe(false)

    expect(console.warn).toHaveBeenCalledWith(
      '[secure-path.windows-acl] failed to restrict path',
      expect.objectContaining({ detail: expect.stringContaining('timed out') })
    )
  })
})
