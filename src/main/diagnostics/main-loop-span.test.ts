import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { breadcrumbMock, writeLineMock } = vi.hoisted(() => ({
  breadcrumbMock: vi.fn(),
  writeLineMock: vi.fn()
}))
vi.mock('../crash-reporting/durable-crash-breadcrumb', () => ({
  recordCoalescedDurableCrashBreadcrumb: breadcrumbMock
}))
vi.mock('../startup/startup-diagnostics', () => ({
  writeStartupDiagnosticLine: writeLineMock
}))

import { _resetTracerForTests, setActiveSink, type TracerSink } from '../observability/tracer'
import { recordGitExecForWindow } from '../observability/git-exec-window-aggregate'
import { MAIN_THREAD_DIAGNOSTICS_ENV } from './main-thread-churn-probe'
import {
  drainSubprocessSpawnStats,
  recordSubprocessSpawn,
  startMainThreadChurnProbe
} from './main-thread-churn-probe'

type Pushed = { name: string; attributes: Record<string, unknown> }

const TICK_MS = 25
let pushed: Pushed[]
let fakeNow: number

// Why: a fake clock cannot make a timer fire late, so performance.now is driven by hand;
// each call fires exactly one probe tick and moves the clock by `elapsedMs`.
function tick(elapsedMs: number): void {
  fakeNow += elapsedMs
  vi.advanceTimersByTime(TICK_MS)
}

function runUntilWindowRolls(): void {
  while (fakeNow < 60_000) {
    tick(TICK_MS)
  }
  tick(TICK_MS)
}

beforeEach(() => {
  pushed = []
  fakeNow = 0
  breadcrumbMock.mockClear()
  writeLineMock.mockClear()
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  vi.spyOn(performance, 'now').mockImplementation(() => fakeNow)
  const sink: TracerSink = {
    push: (record) => pushed.push(record as Pushed),
    flush: () => undefined,
    close: () => undefined
  }
  setActiveSink(sink)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  _resetTracerForTests()
  drainSubprocessSpawnStats()
})

describe('main.loop span', () => {
  it('emits one span per 60s window with gaps, spawn stats and the git aggregate', () => {
    startMainThreadChurnProbe()
    recordSubprocessSpawn('git', ['status'], 4)
    recordSubprocessSpawn('git', ['status'], 2)
    recordSubprocessSpawn('gh', ['pr', 'view'], 1)
    recordGitExecForWindow('status', 40)
    recordGitExecForWindow('status', 60)
    tick(325) // gap 300: over 50 and 250
    tick(1026) // gap 1001: also a stall
    runUntilWindowRolls()

    const spans = pushed.filter((s) => s.name === 'main.loop')
    expect(spans).toHaveLength(1)
    expect(spans[0].attributes).toMatchObject({
      maxGapMs: 1001,
      gapsOver50Ms: 2,
      gapsOver250Ms: 2,
      spawnCount: 3,
      spawnBlockMsTotal: 7,
      spawnBlockMsMax: 4,
      'spawns.git.status': 2,
      'spawns.gh.pr': 1,
      'git.status.count': 2,
      'git.status.execMsSum': 100
    })
  })

  it('starts a fresh window after the roll and keeps only the top 5 spawn keys', () => {
    startMainThreadChurnProbe()
    for (const [i, bin] of ['a', 'b', 'c', 'd', 'e', 'f', 'g'].entries()) {
      for (let n = 0; n <= i; n++) {
        recordSubprocessSpawn(bin, [], 1)
      }
    }
    runUntilWindowRolls()
    const first = pushed.find((s) => s.name === 'main.loop')
    const spawnKeys = Object.keys(first?.attributes ?? {}).filter((k) => k.startsWith('spawns.'))
    expect(spawnKeys.sort()).toEqual(['spawns.c', 'spawns.d', 'spawns.e', 'spawns.f', 'spawns.g'])

    pushed.length = 0
    fakeNow += 60_000
    tick(TICK_MS)
    const second = pushed.find((s) => s.name === 'main.loop')
    expect(second?.attributes).toMatchObject({ spawnCount: 0, gapsOver250Ms: 1 })
  })

  it('writes the stderr line only when ORCA_MAIN_THREAD_DIAGNOSTICS=1', () => {
    vi.stubEnv(MAIN_THREAD_DIAGNOSTICS_ENV, '')
    startMainThreadChurnProbe()
    for (let i = 0; i < 400; i++) {
      tick(TICK_MS)
    }
    expect(writeLineMock).not.toHaveBeenCalled()

    vi.stubEnv(MAIN_THREAD_DIAGNOSTICS_ENV, '1')
    for (let i = 0; i < 400; i++) {
      tick(TICK_MS)
    }
    expect(writeLineMock).toHaveBeenCalled()
  })
})

describe('main_loop_stall breadcrumb', () => {
  it('fires for a gap of at least 1s and not for a shorter one', () => {
    startMainThreadChurnProbe()
    tick(TICK_MS + 999)
    expect(breadcrumbMock).not.toHaveBeenCalled()

    tick(TICK_MS + 1500)
    expect(breadcrumbMock).toHaveBeenCalledTimes(1)
    expect(breadcrumbMock).toHaveBeenCalledWith({
      name: 'main_loop_stall',
      data: { gapMs: 1500 },
      coalesceKey: 'main_loop_stall',
      minIntervalMs: 10_000
    })
  })
})
