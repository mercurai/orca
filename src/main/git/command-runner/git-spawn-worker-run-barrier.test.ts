import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runWslProcessMock } = vi.hoisted(() => ({ runWslProcessMock: vi.fn() }))

vi.mock('../../wsl/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))

import { runProcess } from '../../../shared/child-process/run-process'
import { setRunProcessRoute } from '../../../shared/child-process/run-process-worker-route'
import { createWslProcessGroupTermination } from '../wsl-process-group-termination'
import { installRunProcessWorkerRoute } from './git-spawn-worker-access'
import { restoreGitSpawnMode, useGitSpawnMode } from './git-spawn-worker-test-fixture'

describe('WSL termination barrier through the spawn worker', () => {
  let directory = ''

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'orca-run-barrier-'))
    runWslProcessMock.mockReset()
    runWslProcessMock.mockResolvedValue({ code: 0, timedOut: false })
    useGitSpawnMode('worker')
    installRunProcessWorkerRoute()
  })
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
    setRunProcessRoute(null)
    restoreGitSpawnMode()
  })

  it('learns the guest process group on the worker and ends it through the WSL runner on abort', async () => {
    const termination = createWslProcessGroupTermination('Ubuntu')
    const mainSignal = vi.spyOn(termination, 'signal')
    const onChildTerminated = vi.fn()
    const controller = new AbortController()
    const ready = path.join(directory, 'ready')
    // Why a ready file: the marker must have reached the worker's stderr reader before the abort.
    const marker = JSON.stringify(termination.worker?.marker)
    const script = `process.stderr.write(${marker} + '4321' + String.fromCharCode(10));
      setTimeout(() => require('fs').writeFileSync(${JSON.stringify(ready)}, ''), 300);
      setTimeout(() => {}, 5000)`
    const pending = runProcess({
      program: process.execPath,
      args: ['-e', script],
      terminationBarrier: termination,
      signal: controller.signal,
      onChildTerminated
    })
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 20_000 })
    controller.abort()
    await pending

    const spec = runWslProcessMock.mock.calls[0]?.[0]
    expect(spec).toMatchObject({ distro: 'Ubuntu', args: ['4321'] })
    expect(spec.script).toContain('kill -TERM')
    // Why: the barrier main created only wraps argv and strips output; the worker's copy kills.
    expect(mainSignal).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(onChildTerminated).toHaveBeenCalledOnce(), { timeout: 10_000 })
  })

  it('reports a boolean barrier the same as in-process', async () => {
    const result = await runProcess({
      program: process.execPath,
      args: ['-e', 'process.exitCode = 2'],
      terminationBarrier: true
    })
    expect(result.code).toBe(2)
  })
})
