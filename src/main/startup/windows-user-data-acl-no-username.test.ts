import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ProcessResult } from '../../shared/child-process/run-process'

const { runProcessMock, runProcessSyncMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  runProcessSyncMock: vi.fn()
}))

vi.mock('../../shared/child-process/run-process', () => ({
  runProcess: runProcessMock,
  runProcessSync: runProcessSyncMock
}))

const originalUsername = process.env.USERNAME
let userDataPath: string

beforeEach(() => {
  userDataPath = mkdtempSync(join(os.tmpdir(), 'orca-acl-no-username-'))
  vi.resetModules()
  runProcessMock.mockReset()
  runProcessSyncMock.mockReset()
})

afterEach(() => {
  if (originalUsername === undefined) {
    delete process.env.USERNAME
  } else {
    process.env.USERNAME = originalUsername
  }
  rmSync(userDataPath, { recursive: true, force: true })
})

it('grants on a host without USERNAME by resolving the identity through an async whoami', async () => {
  delete process.env.USERNAME
  const whoami: ProcessResult = {
    code: 0,
    signal: null,
    stdout: '"DOMAIN\\alice","S-1-5-21-456"\r\n',
    stderr: '',
    timedOut: false
  }
  runProcessMock.mockResolvedValue(whoami)
  const spawned: string[][] = []
  const spawnFn = (_command: string, args: readonly string[] = []): EventEmitter => {
    spawned.push([...args])
    const child = Object.assign(new EventEmitter(), { kill: () => undefined })
    setImmediate(() => child.emit('exit', 0))
    return child
  }
  const { ensureWindowsUserDataAclGrant } = await import('./windows-user-data-acl')

  const result = await new Promise((resolve) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the grant reads only the exit event of the child, which this double emits.
    ensureWindowsUserDataAclGrant(userDataPath, { spawnFn: spawnFn as never, onDone: resolve })
  })

  expect(result).toEqual({ mode: 'granted' })
  expect(spawned).toHaveLength(2)
  expect(spawned[0]).toContain('*S-1-5-21-456:(OI)(CI)(F)')
  expect(runProcessSyncMock).not.toHaveBeenCalled()
})
