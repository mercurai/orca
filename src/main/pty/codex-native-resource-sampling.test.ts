import { describe, expect, it, vi } from 'vitest'
import type { ProcessIdentity } from '../../../tests/tools/windows-codex-native-runtime/process-tree-identity'
import type { ProcessMetrics } from '../../../tests/tools/windows-codex-native-runtime/process-metrics-client'
import { ProcessMetricsIncompleteError } from '../../../tests/tools/windows-codex-native-runtime/process-metric-failure'
import {
  collectStableResourceWindow,
  type ResourceWindowDependencies,
  type ResourceWindowSnapshot
} from '../../../tests/tools/windows-codex-native-runtime/runtime-resource-window'

function identity(pid: number, creationTimeMs: number): ProcessIdentity {
  return { pid, creationTimeMs }
}

function snapshot(
  helper: ProcessIdentity | null,
  codex = identity(202, 2002),
  marker = 2
): ResourceWindowSnapshot {
  const processes = [
    { name: 'bash.exe', identity: identity(101, 1001) },
    { name: 'codex.exe', identity: codex },
    ...(helper ? [{ name: 'conhost.exe', identity: helper }] : [])
  ]
  const criticalProcesses = processes.slice(0, 2)
  return {
    shell: 'Git Bash',
    mode: 'native',
    signature: processes
      .map(({ identity: item }) => `${item.pid}:${item.creationTimeMs}`)
      .join(','),
    processes,
    criticalProcesses,
    identities: processes.map(({ identity: item }) => item),
    measure: (metrics) => ({
      privateBytes: marker,
      workingSetBytes: marker,
      handleCount: marker,
      nodeCount: 0,
      cmdCount: 0,
      cpu100ns: metrics.reduce((total, row) => total + row.kernel100ns + row.user100ns, 0)
    })
  }
}

function metricsFor(identities: ProcessIdentity[], cpu100ns: number): ProcessMetrics[] {
  return identities.map((item, index) => ({
    ...item,
    imagePath: 'codex.exe',
    privateBytes: 1,
    workingSetBytes: 1,
    handleCount: 1,
    kernel100ns: index === 0 ? cpu100ns : 0,
    user100ns: 0
  }))
}

describe('Codex native runtime resource sampling', () => {
  it('discards a partial window when a peripheral identity changes', async () => {
    let now = 0
    let settleCount = 0
    let readCount = 0
    let sampleCount = 0
    const sampledHelperPids: number[] = []
    const first = snapshot(identity(303, 3003), undefined, 1)
    const settledAfterRestart = snapshot(identity(304, 3004), undefined, 2)
    const cpuCounters = [50_000_000, 55_000_000, 2_000_000, 4_000_000, 6_000_000, 8_000_000]
    const dependencies: ResourceWindowDependencies = {
      settle: async () => {
        settleCount++
        now += settleCount === 1 ? 100 : 300
        return settleCount === 1 ? first : settledAfterRestart
      },
      read: async () => {
        readCount++
        return readCount === 1 ? first : settledAfterRestart
      },
      sample: async (identities) => {
        sampleCount++
        const helper = identities.at(-1)
        if (!helper) {
          throw new Error('The test process identities were empty')
        }
        sampledHelperPids.push(helper.pid)
        const cpu100ns = cpuCounters[sampleCount - 1]
        if (cpu100ns === undefined) {
          throw new Error('The test CPU counters were exhausted')
        }
        return metricsFor(identities, cpu100ns)
      },
      now: () => now,
      delay: async (milliseconds) => {
        now += milliseconds
      }
    }

    const result = await collectStableResourceWindow(dependencies)

    expect(settleCount).toBe(2)
    expect(readCount).toBe(6)
    expect(sampleCount).toBe(6)
    expect(sampledHelperPids).toEqual([303, 303, 304, 304, 304, 304])
    expect(result.samples).toHaveLength(4)
    expect(result.samples.map((sample) => sample.privateBytes)).toEqual([2, 2, 2, 2])
    expect(result.idleCpuCorePercent).toBeCloseTo(20)
    expect(result.restarts).toBe(1)
    expect(result.restartSettleMs).toBe(300)
  })

  it('restarts when a peripheral identity appears during the final sample', async () => {
    let now = 0
    let settleCount = 0
    let readCount = 0
    let sampleCount = 0
    const first = snapshot(identity(303, 3003), undefined, 1)
    const afterSpawn = snapshot(identity(304, 3004), undefined, 2)
    const dependencies: ResourceWindowDependencies = {
      settle: async () => {
        settleCount++
        return settleCount === 1 ? first : afterSpawn
      },
      read: async () => {
        readCount++
        return readCount <= 3 ? first : afterSpawn
      },
      sample: async (identities) => {
        sampleCount++
        return metricsFor(identities, sampleCount * 1_000_000)
      },
      now: () => now,
      delay: async (milliseconds) => {
        now += milliseconds
      }
    }

    const result = await collectStableResourceWindow(dependencies)

    expect(settleCount).toBe(2)
    expect(readCount).toBe(8)
    expect(sampleCount).toBe(8)
    expect(result.samples.map((sample) => sample.privateBytes)).toEqual([2, 2, 2, 2])
    expect(result.restarts).toBe(1)
  })

  it('fails immediately when a critical Codex identity changes', async () => {
    let now = 0
    let sampleCount = 0
    let settleCount = 0
    const original = snapshot(identity(303, 3003))
    const replacedCodex = snapshot(identity(303, 3003), identity(205, 2005))
    const dependencies: ResourceWindowDependencies = {
      settle: async () => {
        settleCount++
        return original
      },
      read: async () => replacedCodex,
      sample: async (identities) => {
        sampleCount++
        return metricsFor(identities, 1_000_000)
      },
      now: () => now,
      delay: async (milliseconds) => {
        now += milliseconds
      }
    }

    await expect(collectStableResourceWindow(dependencies)).rejects.toThrow(
      'Git Bash native critical process identity changed; removed=[codex.exe] added=[codex.exe]'
    )
    expect(settleCount).toBe(1)
    expect(sampleCount).toBe(1)
  })

  it('bounds repeated peripheral changes and reports only sanitized names', async () => {
    let now = 0
    let settleCount = 0
    let readCount = 0
    let sampleCount = 0
    const snapshots = Array.from({ length: 5 }, (_, index) =>
      snapshot(identity(303 + index, 3003 + index))
    )
    const dependencies: ResourceWindowDependencies = {
      settle: async () => {
        const result = snapshots[settleCount]
        settleCount++
        if (!result) {
          throw new Error('The test snapshots were exhausted')
        }
        return result
      },
      read: async () => {
        const result = snapshots[readCount + 1]
        readCount++
        if (!result) {
          throw new Error('The test snapshots were exhausted')
        }
        return result
      },
      sample: async (identities) => {
        sampleCount++
        return metricsFor(identities, 1_000_000)
      },
      now: () => now,
      delay: async (milliseconds) => {
        now += milliseconds
      }
    }

    await expect(collectStableResourceWindow(dependencies)).rejects.toThrow(
      'Git Bash native resource window process membership kept changing after 3 restarts; removed=[conhost.exe] added=[conhost.exe]'
    )
    expect(settleCount).toBe(4)
    expect(readCount).toBe(4)
    expect(sampleCount).toBe(4)
  })

  it('does not retry a sampler failure', async () => {
    let settleCount = 0
    let sampleCount = 0
    let readCount = 0
    const original = snapshot(identity(303, 3003))
    const dependencies: ResourceWindowDependencies = {
      settle: async () => {
        settleCount++
        return original
      },
      read: async () => {
        readCount++
        return original
      },
      sample: async () => {
        sampleCount++
        throw new Error('Python metrics sampler returned invalid data')
      },
      now: () => 0,
      delay: async () => {}
    }

    await expect(collectStableResourceWindow(dependencies)).rejects.toThrow(
      'Python metrics sampler returned invalid data'
    )
    expect(settleCount).toBe(1)
    expect(readCount).toBe(0)
    expect(sampleCount).toBe(1)
  })

  it('classifies one bounded tree read after an incomplete process metric failure', async () => {
    const original = snapshot(identity(303, 3003))
    const metricFailure = new ProcessMetricsIncompleteError({
      operation: 'get_process_memory_info',
      failedIdentity: identity(303, 3003),
      expectedCount: 3,
      measuredCount: 2,
      errorCode: 31
    })
    const cases: {
      expected: string
      read: () => Promise<ResourceWindowSnapshot>
      exhaustDeadline?: boolean
      expectedReadCount?: number
    }[] = [
      { expected: 'unchanged', read: async () => original },
      {
        expected: 'peripheral-change',
        read: async () => snapshot(identity(304, 3004))
      },
      {
        expected: 'critical-change',
        read: async () => snapshot(identity(303, 3003), identity(205, 2005))
      },
      {
        expected: 'unavailable',
        read: async () => {
          throw new Error('private read failure')
        }
      },
      {
        expected: 'unavailable',
        exhaustDeadline: true,
        expectedReadCount: 0,
        read: async () => original
      }
    ]
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      for (const testCase of cases) {
        let settleCount = 0
        let readCount = 0
        let sampleCount = 0
        let now = 0
        const dependencies: ResourceWindowDependencies = {
          settle: async () => {
            settleCount++
            return original
          },
          read: async (timeoutMs) => {
            readCount++
            expect(timeoutMs).toBe(60_000)
            return testCase.read()
          },
          sample: async () => {
            sampleCount++
            if (testCase.exhaustDeadline) {
              now = 60_000
            }
            throw metricFailure
          },
          now: () => now,
          delay: async () => {}
        }

        let caught: unknown
        try {
          await collectStableResourceWindow(dependencies)
        } catch (error) {
          caught = error
        }

        expect(caught).toBe(metricFailure)
        expect([settleCount, readCount, sampleCount]).toEqual([
          1,
          testCase.expectedReadCount ?? 1,
          1
        ])
        expect(log.mock.calls.at(-1)?.[0]).toContain(`tree=${testCase.expected}`)
        expect(log.mock.calls.at(-1)?.[0]).toContain(
          'operation=get_process_memory_info measured=2/3 error=31'
        )
        expect(log.mock.calls.at(-1)?.[0]).not.toContain('private')
        expect(log.mock.calls.at(-1)?.[0]).not.toContain('303')
      }
    } finally {
      log.mockRestore()
    }
  })

  it('restarts with a full fresh window when the sole failed peripheral identity disappeared', async () => {
    const failedIdentity = identity(303, 3003)
    const original = snapshot(failedIdentity, undefined, 1)
    const replacement = snapshot(null, undefined, 9)
    let now = 0
    let settleCount = 0
    let readCount = 0
    let sampleCount = 0
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const dependencies: ResourceWindowDependencies = {
      settle: async () => {
        settleCount++
        return settleCount === 1 ? original : replacement
      },
      read: async () => {
        readCount++
        return readCount === 1 ? original : replacement
      },
      sample: async (identities) => {
        sampleCount++
        if (sampleCount === 2) {
          throw new ProcessMetricsIncompleteError({
            operation: 'query_full_process_image_name',
            failedIdentity,
            expectedCount: identities.length,
            measuredCount: identities.length - 1,
            errorCode: 31
          })
        }
        const counterIndex = sampleCount === 1 ? 0 : sampleCount - 2
        return metricsFor(
          identities,
          sampleCount === 1 ? 900_000_000_000 : counterIndex * 10_000_000
        )
      },
      now: () => now,
      delay: async (milliseconds) => {
        now += milliseconds
      }
    }

    try {
      const result = await collectStableResourceWindow(dependencies)
      expect(result.samples.map((sample) => sample.privateBytes)).toEqual([9, 9, 9, 9])
      expect(result.idleCpuCorePercent).toBeCloseTo(100)
      expect(result.restarts).toBe(1)
      expect([settleCount, readCount, sampleCount]).toEqual([2, 6, 6])
      expect(log).toHaveBeenCalledOnce()
      expect(log.mock.calls[0]?.[0]).toContain('tree=peripheral-change')
      expect(log.mock.calls[0]?.[0]).not.toContain('303')
      expect(log.mock.calls[0]?.[0]).not.toContain('3003')
    } finally {
      log.mockRestore()
    }
  })

  it('keeps incomplete metric failures when the removal is not the sole failed peripheral', async () => {
    const failedHelper = identity(303, 3003)
    const original = snapshot(failedHelper)
    const cases = [
      { name: 'identity remains', failedIdentity: failedHelper, current: original, measured: 2 },
      {
        name: 'critical identity changed',
        failedIdentity: identity(202, 2002),
        current: snapshot(failedHelper, identity(205, 2005)),
        measured: 2
      },
      {
        name: 'failed critical identity remains while a peripheral leaves',
        failedIdentity: identity(202, 2002),
        current: snapshot(null),
        measured: 2
      },
      {
        name: 'extra identity appeared',
        failedIdentity: failedHelper,
        current: snapshot(identity(304, 3004)),
        measured: 2
      },
      {
        name: 'multiple metrics failed',
        failedIdentity: failedHelper,
        current: snapshot(null),
        measured: 1
      }
    ]
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      for (const testCase of cases) {
        let settleCount = 0
        let readCount = 0
        let sampleCount = 0
        const failure = new ProcessMetricsIncompleteError({
          operation: 'query_full_process_image_name',
          failedIdentity: testCase.failedIdentity,
          expectedCount: 3,
          measuredCount: testCase.measured,
          errorCode: 31
        })
        const dependencies: ResourceWindowDependencies = {
          settle: async () => {
            settleCount++
            return original
          },
          read: async () => {
            readCount++
            return testCase.current
          },
          sample: async () => {
            sampleCount++
            throw failure
          },
          now: () => 0,
          delay: async () => {}
        }

        let caught: unknown
        try {
          await collectStableResourceWindow(dependencies)
        } catch (error) {
          caught = error
        }
        expect(caught).toBe(failure)
        expect([settleCount, readCount, sampleCount]).toEqual([1, 1, 1])
      }
    } finally {
      log.mockRestore()
    }
  })

  it('does not restart when the sole failed identity disappears at the window deadline', async () => {
    const failedIdentity = identity(303, 3003)
    const original = snapshot(failedIdentity)
    const failure = new ProcessMetricsIncompleteError({
      operation: 'query_full_process_image_name',
      failedIdentity,
      expectedCount: 3,
      measuredCount: 2,
      errorCode: 31
    })
    let now = 0
    let readCount = 0
    let sampleCount = 0
    let settleCount = 0
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const dependencies: ResourceWindowDependencies = {
      settle: async () => {
        settleCount++
        return original
      },
      read: async () => {
        readCount++
        if (readCount === 2) {
          now = 60_000
          return snapshot(null)
        }
        return original
      },
      sample: async (identities) => {
        sampleCount++
        if (sampleCount === 2) {
          throw failure
        }
        return metricsFor(identities, 1_000_000)
      },
      now: () => now,
      delay: async () => {
        now = 59_000
      }
    }

    try {
      let caught: unknown
      try {
        await collectStableResourceWindow(dependencies)
      } catch (error) {
        caught = error
      }
      expect(caught).toBe(failure)
      expect([settleCount, readCount, sampleCount]).toEqual([1, 2, 2])
      expect(log.mock.calls[0]?.[0]).toContain('tree=unavailable')
    } finally {
      log.mockRestore()
    }
  })

  it('stops at the existing whole-window restart cap', async () => {
    const helpers = [303, 304, 305, 306].map((pid) => identity(pid, pid * 10))
    const failures: ProcessMetricsIncompleteError[] = []
    let settleCount = 0
    let readCount = 0
    let sampleCount = 0
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const dependencies: ResourceWindowDependencies = {
      settle: async () => {
        const helper = helpers[settleCount]
        settleCount++
        if (!helper) {
          throw new Error('The race fixture was exhausted')
        }
        return snapshot(helper)
      },
      read: async () => {
        readCount++
        return snapshot(null)
      },
      sample: async (identities) => {
        sampleCount++
        const failedIdentity = identities.at(-1)
        if (!failedIdentity) {
          throw new Error('The race fixture has no peripheral process')
        }
        const failure = new ProcessMetricsIncompleteError({
          operation: 'query_full_process_image_name',
          failedIdentity,
          expectedCount: identities.length,
          measuredCount: identities.length - 1,
          errorCode: 31
        })
        failures.push(failure)
        throw failure
      },
      now: () => 0,
      delay: async () => {}
    }

    try {
      let caught: unknown
      try {
        await collectStableResourceWindow(dependencies)
      } catch (error) {
        caught = error
      }
      expect(caught).toBe(failures[3])
      expect([settleCount, readCount, sampleCount]).toEqual([4, 4, 4])
      expect(log).toHaveBeenCalledTimes(4)
      expect(log.mock.calls.every(([message]) => message.includes('tree=peripheral-change'))).toBe(
        true
      )
      expect(log.mock.calls.some(([message]) => message.includes('303'))).toBe(false)
    } finally {
      log.mockRestore()
    }
  })

  it('ends collection when settling consumes the remaining deadline', async () => {
    let now = 0
    const original = snapshot(identity(303, 3003))
    const dependencies: ResourceWindowDependencies = {
      settle: async (remainingMs) => {
        now += remainingMs
        return original
      },
      read: async () => original,
      sample: async () => {
        throw new Error('An expired window must not request metrics')
      },
      now: () => now,
      delay: async (milliseconds) => {
        now += milliseconds
      }
    }

    await expect(collectStableResourceWindow(dependencies)).rejects.toThrow(
      'Git Bash native resource window deadline expired while settling after 0 restarts'
    )
  })

  it('does not start verification after a sample consumes the remaining deadline', async () => {
    let now = 0
    let readCount = 0
    let sampleCount = 0
    const original = snapshot(identity(303, 3003))
    const dependencies: ResourceWindowDependencies = {
      settle: async () => original,
      read: async () => {
        readCount++
        return original
      },
      sample: async (identities, remainingMs) => {
        sampleCount++
        now += remainingMs
        return metricsFor(identities, 1_000_000)
      },
      now: () => now,
      delay: async (milliseconds) => {
        now += milliseconds
      }
    }

    await expect(collectStableResourceWindow(dependencies)).rejects.toThrow(
      'Git Bash native resource window deadline expired during sampling after 0 restarts'
    )
    expect(sampleCount).toBe(1)
    expect(readCount).toBe(0)
  })
})
