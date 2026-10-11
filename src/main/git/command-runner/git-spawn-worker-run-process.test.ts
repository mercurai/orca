import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../../shared/child-process/run-process'
import { setRunProcessRoute } from '../../../shared/child-process/run-process-worker-route'
import { setSpawnObserver } from '../../../shared/child-process/spawn-observer'
import { installRunProcessWorkerRoute } from './git-spawn-worker-access'
import {
  createThreadWorkerFactory,
  restoreGitSpawnMode,
  useGitSpawnMode
} from './git-spawn-worker-test-fixture'

const SPAWN_COUNT = 30
const CONCURRENCY = 4
const TICK_MS = 5
const MAX_CUMULATIVE_BLOCK_MS = 200
// Windows timers tick at about 15.6 ms, so only a gap beyond this is a stall of the loop.
const STALL_THRESHOLD_MS = 20
const HANG = ['-e', 'setTimeout(() => {}, 60000)']

type LoopBlock = { cumulativeBlockMs: number; maxGapMs: number; wallMs: number }

async function measureLoopBlockDuringRunProcess(): Promise<LoopBlock> {
  let last = performance.now()
  let cumulativeBlockMs = 0
  let maxGapMs = 0
  const timer = setInterval(() => {
    const now = performance.now()
    const gap = now - last
    last = now
    maxGapMs = Math.max(maxGapMs, gap)
    cumulativeBlockMs += gap > STALL_THRESHOLD_MS ? gap - TICK_MS : 0
  }, TICK_MS)
  const startedAt = performance.now()
  let remaining = SPAWN_COUNT
  const lane = async (): Promise<void> => {
    while (remaining > 0) {
      remaining -= 1
      await runProcess({ program: process.execPath, args: ['--version'] })
    }
  }
  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, lane))
  } finally {
    clearInterval(timer)
  }
  return { cumulativeBlockMs, maxGapMs, wallMs: performance.now() - startedAt }
}

function describeBlock(label: string, block: LoopBlock): string {
  return (
    `${label}: ${SPAWN_COUNT} stub-binary runProcess spawns, ${CONCURRENCY}-wide, ${TICK_MS} ms lag timer, stalls over ${STALL_THRESHOLD_MS} ms: ` +
    `cumulative loop block ${block.cumulativeBlockMs.toFixed(1)} ms, ` +
    `max gap ${block.maxGapMs.toFixed(1)} ms, wall ${block.wallMs.toFixed(0)} ms`
  )
}

describe('runProcess on a real spawn worker thread', () => {
  let bundle: ReturnType<typeof createThreadWorkerFactory>

  beforeAll(() => {
    bundle = createThreadWorkerFactory()
  })
  afterAll(() => bundle.cleanup())
  beforeEach(() => {
    useGitSpawnMode('worker', bundle.factory)
    installRunProcessWorkerRoute()
  })
  afterEach(() => {
    setRunProcessRoute(null)
    setSpawnObserver(null)
    restoreGitSpawnMode()
    delete process.env.ORCA_SPAWN_WORKER
  })

  it('keeps the main loop free while 30 stub-binary spawns run four wide', async () => {
    await runProcess({ program: process.execPath, args: ['--version'] })
    const worker = await measureLoopBlockDuringRunProcess()
    setRunProcessRoute(null)
    const inProcess = await measureLoopBlockDuringRunProcess()
    console.info(`${describeBlock('worker', worker)}\n${describeBlock('in-process', inProcess)}`)
    expect(worker.cumulativeBlockMs).toBeLessThanOrEqual(MAX_CUMULATIVE_BLOCK_MS)
  }, 120_000)

  it('returns exit code, text, stdin and bytes like the in-process path', async () => {
    const echo = await runProcess({
      program: process.execPath,
      args: [
        '-e',
        'process.stdin.pipe(process.stdout); process.stderr.write("e"); process.exitCode = 3'
      ],
      input: 'hello worker'
    })
    expect(echo).toMatchObject({ code: 3, stdout: 'hello worker', stderr: 'e', timedOut: false })
    const bytes = await runProcess({
      program: process.execPath,
      args: ['-e', 'process.stdout.write(Buffer.from([1, 2, 3]))'],
      captureStdoutAsBytes: true
    })
    expect(Buffer.isBuffer(bytes.stdoutBytes)).toBe(true)
    expect([...(bytes.stdoutBytes ?? [])]).toEqual([1, 2, 3])
  })

  it('rejects an unstartable program with the spawn error code', async () => {
    const onChildTerminated = vi.fn()
    await expect(
      runProcess({ program: 'orca-no-such-binary-1091', onChildTerminated })
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await vi.waitFor(() => expect(onChildTerminated).toHaveBeenCalledOnce())
  })

  it('ends a child at its deadline and reports it timed out', async () => {
    const onChildTerminated = vi.fn()
    const result = await runProcess({
      program: process.execPath,
      args: HANG,
      timeoutMs: 300,
      onChildTerminated
    })
    expect(result.timedOut).toBe(true)
    await vi.waitFor(() => expect(onChildTerminated).toHaveBeenCalledOnce(), { timeout: 10_000 })
  })

  it('ends a child when the caller aborts', async () => {
    const controller = new AbortController()
    const onChildTerminated = vi.fn()
    const pending = runProcess({
      program: process.execPath,
      args: HANG,
      signal: controller.signal,
      onChildTerminated
    })
    setTimeout(() => controller.abort(), 200)
    const result = await pending
    expect(result.timedOut).toBe(false)
    await vi.waitFor(() => expect(onChildTerminated).toHaveBeenCalledOnce(), { timeout: 10_000 })
  })

  it('still reports the child terminated when a descendant holds the pipes past the result', async () => {
    const onChildTerminated = vi.fn()
    // Why: the root exits at once but its child keeps stdout open, so `close` can trail the result.
    const holder =
      "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], { stdio: 'inherit' })"
    const result = await runProcess({
      program: process.execPath,
      args: ['-e', holder],
      timeoutMs: 300,
      onChildTerminated
    })
    expect(result.timedOut).toBe(true)
    await vi.waitFor(() => expect(onChildTerminated).toHaveBeenCalledOnce(), { timeout: 20_000 })
  })

  it('counts the spawn for the probes with no main-thread block attributed', async () => {
    const observer = vi.fn()
    setSpawnObserver(observer)
    await runProcess({ program: process.execPath, args: ['--version'] })
    expect(observer).toHaveBeenCalledExactlyOnceWith(process.execPath, ['--version'], 0)
  })

  it('spawns in-process when ORCA_SPAWN_WORKER=0', async () => {
    process.env.ORCA_SPAWN_WORKER = '0'
    const observer = vi.fn()
    setSpawnObserver(observer)
    await runProcess({ program: process.execPath, args: ['--version'] })
    expect(observer).toHaveBeenCalledOnce()
    expect(observer.mock.calls[0][2]).toBeGreaterThan(0)
  })

  it('keeps a streaming stdio layout in-process', async () => {
    const result = await runProcess({
      program: process.execPath,
      args: ['--version'],
      stdio: ['ignore', 'pipe', 'pipe']
    })
    expect(result.code).toBe(0)
  })
})
