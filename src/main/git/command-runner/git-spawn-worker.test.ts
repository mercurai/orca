import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileCapture } from './exec-file-capture'
import { gitExecFileAsync, gitExecFileAsyncBuffer } from './git-exec-file'
import {
  createThreadWorkerFactory,
  restoreGitSpawnMode,
  useGitSpawnMode
} from './git-spawn-worker-test-fixture'
import { getGitSpawnWorkerClient } from './git-spawn-worker-access'
import { gitStreamStdout } from './git-stream-stdout'

const SPAWN_COUNT = 30
const CONCURRENCY = 4
const TICK_MS = 5
const MAX_CUMULATIVE_BLOCK_MS = 200
const MAX_GAP_MS = 50
// Windows timers tick at about 15.6 ms, so a 5 ms timer idles at ~15 ms gaps; only
// a gap beyond this threshold is a stall of the loop rather than timer granularity.
const STALL_THRESHOLD_MS = 20

type LoopBlock = { cumulativeBlockMs: number; maxGapMs: number; wallMs: number }

async function measureLoopBlockDuringGitSpawns(): Promise<LoopBlock> {
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
      await gitExecFileAsync(['--version'], { cwd: process.cwd() })
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
    `${label}: ${SPAWN_COUNT} git --version spawns, ${CONCURRENCY}-wide, ${TICK_MS} ms lag timer, stalls over ${STALL_THRESHOLD_MS} ms: ` +
    `cumulative loop block ${block.cumulativeBlockMs.toFixed(1)} ms, ` +
    `max gap ${block.maxGapMs.toFixed(1)} ms, wall ${block.wallMs.toFixed(0)} ms`
  )
}

describe('git spawn worker on a real worker thread', () => {
  let bundle: ReturnType<typeof createThreadWorkerFactory>

  beforeAll(() => {
    bundle = createThreadWorkerFactory()
  })
  afterAll(() => bundle.cleanup())
  beforeEach(() => useGitSpawnMode('worker', bundle.factory))
  afterEach(() => restoreGitSpawnMode())

  it('keeps the main loop free while 30 git spawns run four wide', async () => {
    await gitExecFileAsync(['--version'], { cwd: process.cwd() })
    const worker = await measureLoopBlockDuringGitSpawns()
    useGitSpawnMode('in-process')
    await gitExecFileAsync(['--version'], { cwd: process.cwd() })
    const inProcess = await measureLoopBlockDuringGitSpawns()
    console.info(`${describeBlock('worker', worker)}\n${describeBlock('in-process', inProcess)}`)
    expect(worker.cumulativeBlockMs).toBeLessThanOrEqual(MAX_CUMULATIVE_BLOCK_MS)
    expect(worker.maxGapMs).toBeLessThanOrEqual(MAX_GAP_MS)
  })

  it('returns text and binary output like the in-process path', async () => {
    const text = await gitExecFileAsync(['--version'], { cwd: process.cwd() })
    expect(text.stdout).toMatch(/^git version /)
    const { stdout } = await gitExecFileAsyncBuffer(['--version'], { cwd: process.cwd() })
    expect(Buffer.isBuffer(stdout)).toBe(true)
    expect(stdout.toString('utf8')).toMatch(/^git version /)
  })

  it('rejects a failing command with the exit code and stderr callers read', async () => {
    await expect(
      gitExecFileAsync(['definitely-not-a-git-command'], { cwd: process.cwd() })
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('not a git command') })
  })

  it('reports a missing binary as ENOENT and still reports the child terminated', async () => {
    const onChildTerminated = vi.fn()
    await expect(
      execFileCapture('orca-no-such-binary-1085', [], { onChildTerminated })
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await vi.waitFor(() => expect(onChildTerminated).toHaveBeenCalledOnce())
  })

  it('writes stdin to the child', async () => {
    const result = await execFileCapture(
      process.execPath,
      ['-e', 'process.stdin.pipe(process.stdout)'],
      { stdin: 'hello worker', encoding: 'utf8' }
    )
    expect(result.stdout).toBe('hello worker')
  })

  it('ends a child that outlives its deadline with the caller timeout error', async () => {
    const onChildTerminated = vi.fn()
    await expect(
      execFileCapture(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
        timeout: 300,
        createTimeoutError: () => new Error('deadline 1085'),
        onChildTerminated
      })
    ).rejects.toThrow('deadline 1085')
    await vi.waitFor(() => expect(onChildTerminated).toHaveBeenCalledOnce(), { timeout: 10_000 })
  })

  it('ends a child when the caller aborts and rejects with an AbortError', async () => {
    const controller = new AbortController()
    const onChildTerminated = vi.fn()
    const pending = execFileCapture(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      signal: controller.signal,
      onChildTerminated
    })
    setTimeout(() => controller.abort(), 200)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(onChildTerminated).toHaveBeenCalledOnce(), { timeout: 10_000 })
  })

  it('kills a running child when the worker is torn down', async () => {
    const client = getGitSpawnWorkerClient()
    expect(client).not.toBeNull()
    const handle = client?.stream(
      {
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 60000)'],
        cwd: process.cwd()
      },
      { onChunk: () => {}, onError: () => {}, onClose: () => {} }
    )
    await vi.waitFor(() => expect(handle?.pid).toBeGreaterThan(0), { timeout: 10_000 })
    const pid = handle?.pid
    if (pid === undefined) {
      throw new Error('stream never reported a pid')
    }
    client?.dispose()
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 10_000 })
  })

  it('streams stdout through the worker', async () => {
    let output = ''
    await expect(
      gitStreamStdout(['rev-parse', 'HEAD'], {
        cwd: process.cwd(),
        onStdout: (chunk) => {
          output += chunk
        }
      })
    ).resolves.toEqual({ stoppedEarly: false })
    expect(output.trim()).toMatch(/^[0-9a-f]{40}$/)
  })

  it('stops a stream early when the parser asks', async () => {
    await expect(
      gitStreamStdout(['log', '--oneline', '-n', '200'], {
        cwd: process.cwd(),
        onStdout: () => true
      })
    ).resolves.toEqual({ stoppedEarly: true })
  })
})
