import { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { spawnProcess } from '../../../shared/child-process/run-process'
import type * as NodeChildProcess from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, admitMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  admitMock: vi.fn((_kill: { pid: number; site: string; scope: string }) => true)
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeChildProcess>()),
  spawn: spawnMock
}))
vi.mock('../../own-chromium-tree-kill-guard', () => ({
  admitSelfInitiatedTreeKill: admitMock
}))

import { setProcessTreeKillGate } from '../../../shared/child-process/process-tree-kill-gate'
import { execFileCapture } from './exec-file-capture'
import { installSpawnWorkerTreeKillGate } from './git-spawn-worker-kill'
import { restoreGitSpawnMode, useGitSpawnMode } from './git-spawn-worker-test-fixture'
import { killSpawnedCommandTree } from './spawned-command-tree-kill'

const originalPlatform = process.platform

function childWithPid(pid: number): ChildProcess {
  const child = new ChildProcess()
  Object.defineProperty(child, 'pid', { value: pid })
  vi.spyOn(child, 'kill').mockReturnValue(true)
  vi.spyOn(child, 'unref').mockImplementation(() => {})
  return child
}

describe('Git command tree termination', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    spawnMock.mockReset()
    admitMock.mockReset().mockReturnValue(true)
    // Main installs this gate at startup; the guard decision is what these cases pin.
    setProcessTreeKillGate((kill) => admitMock(kill))
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    setProcessTreeKillGate(null)
    vi.restoreAllMocks()
  })

  it.each([0, 128])(
    'never taskkills a child that exited with code %i before close',
    async (code) => {
      const child = childWithPid(1234)
      Object.defineProperty(child, 'exitCode', { value: code })

      await killSpawnedCommandTree(child)

      expect(spawnMock).not.toHaveBeenCalled()
      expect(admitMock).not.toHaveBeenCalled()
      expect(child.kill).toHaveBeenCalledOnce()
    }
  )

  it('never taskkills a child that exited by signal before close', async () => {
    const child = childWithPid(1234)
    Object.defineProperty(child, 'signalCode', { value: 'SIGTERM' })

    await killSpawnedCommandTree(child)

    expect(spawnMock).not.toHaveBeenCalled()
    expect(admitMock).not.toHaveBeenCalled()
  })

  it('still waits for tree termination when the Windows root has not exited', async () => {
    const child = childWithPid(1234)
    const killer = childWithPid(5678)
    spawnMock.mockReturnValue(killer)
    let settled = false
    const pending = killSpawnedCommandTree(child).then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)
    expect(spawnMock).toHaveBeenCalledWith('taskkill', ['/pid', '1234', '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true
    })
    killer.emit('close', 0)
    await pending
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('preserves handle termination on POSIX', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const child = childWithPid(1234)

    await killSpawnedCommandTree(child)

    expect(child.kill).toHaveBeenCalledOnce()
    expect(spawnMock).not.toHaveBeenCalled()
  })
  it.skipIf(originalPlatform !== 'win32').each([0, 128])(
    'does not taskkill an actual native Windows child after exit %i',
    async (exitCode) => {
      const original = await vi.importActual<typeof NodeChildProcess>('node:child_process')
      spawnMock.mockImplementation((program, args, options) => {
        if (program !== process.execPath) {
          throw new Error('Unexpected external process in native exit probe')
        }
        return original.spawn(program, args, options)
      })
      const child = spawnProcess({
        program: process.execPath,
        args: ['-e', `process.exit(${exitCode})`]
      })
      const closed = once(child, 'close')
      await once(child, 'exit')
      expect(child.exitCode).toBe(exitCode)
      expect(child.pid).toBeGreaterThan(0)
      spawnMock.mockClear()
      await killSpawnedCommandTree(child)
      expect(spawnMock).not.toHaveBeenCalled()
      expect(admitMock).not.toHaveBeenCalled()
      await closed
    }
  )
})

// Why (#1085): in worker mode the taskkill runs on the worker thread, but the own-Chromium
// guard must still be main's decision, taken before the pid-addressed walk.
describe('Git command tree termination through the spawn worker', () => {
  const sleepForever = ['-e', 'setTimeout(() => {}, 5000)']

  function fakeTaskkill(): void {
    spawnMock.mockImplementation(() => {
      const killer = childWithPid(5678)
      queueMicrotask(() => killer.emit('close', 0))
      return killer
    })
  }

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    spawnMock.mockReset()
    admitMock.mockReset().mockReturnValue(true)
    installSpawnWorkerTreeKillGate()
    useGitSpawnMode('worker')
  })

  afterEach(() => {
    restoreGitSpawnMode()
    setProcessTreeKillGate(null)
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    vi.restoreAllMocks()
  })

  it('walks the tree after main admits the pid on abort', async () => {
    fakeTaskkill()
    const controller = new AbortController()
    const pending = execFileCapture(process.execPath, sleepForever, { signal: controller.signal })
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(admitMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ site: 'git-command-tree-kill', scope: 'win-taskkill-tree' })
    )
    expect(spawnMock).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', String(admitMock.mock.calls[0]?.[0]?.pid), '/t', '/f'],
      expect.anything()
    )
  })

  it('kills only the root handle when main refuses the pid', async () => {
    admitMock.mockReturnValue(false)
    const controller = new AbortController()
    const pending = execFileCapture(process.execPath, sleepForever, { signal: controller.signal })
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(admitMock).toHaveBeenCalledOnce()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('applies the same guard when the worker deadline fires', async () => {
    admitMock.mockReturnValue(false)
    await expect(
      execFileCapture(process.execPath, sleepForever, {
        timeout: 100,
        createTimeoutError: () => new Error('deadline 1085')
      })
    ).rejects.toThrow('deadline 1085')
    expect(admitMock).toHaveBeenCalledOnce()
    expect(spawnMock).not.toHaveBeenCalled()
  })
})
