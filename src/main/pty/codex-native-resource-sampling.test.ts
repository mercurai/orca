import { describe, expect, it } from 'vitest'
import type { ProcessIdentity } from '../../../tests/tools/windows-codex-native-runtime/process-tree-identity'
import type { ProcessMetrics } from '../../../tests/tools/windows-codex-native-runtime/process-metrics-client'
import {
  collectStableResourceWindow,
  type ResourceWindowDependencies,
  type ResourceWindowSnapshot
} from '../../../tests/tools/windows-codex-native-runtime/runtime-resource-window'

function identity(pid: number, creationTimeMs: number): ProcessIdentity {
  return { pid, creationTimeMs }
}

function snapshot(
  helper: ProcessIdentity,
  codex = identity(202, 2002),
  marker = 2
): ResourceWindowSnapshot {
  const processes = [
    { name: 'bash.exe', identity: identity(101, 1001) },
    { name: 'codex.exe', identity: codex },
    { name: 'conhost.exe', identity: helper }
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
    expect(readCount).toBe(5)
    expect(sampleCount).toBe(6)
    expect(sampledHelperPids).toEqual([303, 303, 304, 304, 304, 304])
    expect(result.samples).toHaveLength(4)
    expect(result.samples.map((sample) => sample.privateBytes)).toEqual([2, 2, 2, 2])
    expect(result.idleCpuCorePercent).toBeCloseTo(20)
    expect(result.restarts).toBe(1)
    expect(result.restartSettleMs).toBe(300)
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
        throw new Error('metrics unavailable')
      },
      now: () => 0,
      delay: async () => {}
    }

    await expect(collectStableResourceWindow(dependencies)).rejects.toThrow('metrics unavailable')
    expect(settleCount).toBe(1)
    expect(readCount).toBe(0)
    expect(sampleCount).toBe(1)
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
})
