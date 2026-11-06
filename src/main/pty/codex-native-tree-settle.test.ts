import { describe, expect, it } from 'vitest'
import type { WindowsProcessIdentityRow } from '../windows/windows-process-table'
import {
  waitForStableTrees,
  type TreeWaitDependencies
} from '../../../tests/tools/windows-codex-native-runtime/runtime-tree-settle'
import type { TreeSnapshot } from '../../../tests/tools/windows-codex-native-runtime/runtime-process-trees'

const sampler = { listJobProcessIds: async (_jobId: number) => [] }

function row(pid: number, ppid: number, name: string): WindowsProcessIdentityRow {
  return { pid, ppid, name, creationTimeMs: pid * 10 }
}

function treeSnapshot(codexPid = 202): TreeSnapshot {
  const root = row(101, 1, 'powershell.exe')
  const codex = row(codexPid, root.pid, 'codex.exe')
  return {
    session: {
      pid: root.pid,
      mode: 'native',
      shell: { name: 'Windows PowerShell', kind: 'powershell', executable: 'powershell.exe' }
    },
    rows: [root, codex],
    descendants: [codex],
    jobRows: [root, codex],
    processTable: [root, codex]
  }
}

function clockDependencies(
  now: () => number,
  read: NonNullable<TreeWaitDependencies['read']>,
  delay: (milliseconds: number) => Promise<void>
): TreeWaitDependencies {
  return { now, read, delay }
}

describe('Codex native process tree settling', () => {
  it('rejects a 400ms plateau that changes before the quiet window completes', async () => {
    let now = 0
    let readCount = 0
    const dependencies = clockDependencies(
      () => now,
      async () => {
        readCount++
        return [treeSnapshot(readCount <= 3 ? 202 : 202 + readCount)]
      },
      async (milliseconds) => {
        now += milliseconds
      }
    )

    await expect(waitForStableTrees([], sampler, 1_400, dependencies)).rejects.toThrow(
      'Codex process trees did not reach a settled state'
    )
    expect(readCount).toBe(7)
    expect(now).toBe(1_400)
  })

  it('returns the latest tree after exactly three seconds without a signature change', async () => {
    let now = 0
    let latest: TreeSnapshot | undefined
    const dependencies = clockDependencies(
      () => now,
      async () => {
        latest = treeSnapshot()
        return [latest]
      },
      async (milliseconds) => {
        now += milliseconds
      }
    )

    const result = await waitForStableTrees([], sampler, 3_200, dependencies)

    expect(now).toBe(3_000)
    expect(result[0]).toBe(latest)
  })

  it('restarts the quiet window after a late tree change', async () => {
    let now = 0
    let readCount = 0
    const dependencies = clockDependencies(
      () => now,
      async () => {
        readCount++
        return [treeSnapshot(now < 2_800 ? 202 : 203)]
      },
      async (milliseconds) => {
        now += milliseconds
      }
    )

    const result = await waitForStableTrees([], sampler, 6_000, dependencies)

    expect(result[0]?.rows.at(-1)?.pid).toBe(203)
    expect(now).toBe(5_800)
    expect(readCount).toBe(30)
  })

  it('does not pass when the three-second quiet period ends at the overall deadline', async () => {
    let now = 0
    let readCount = 0
    const dependencies = clockDependencies(
      () => now,
      async () => {
        readCount++
        return [treeSnapshot()]
      },
      async (milliseconds) => {
        now += milliseconds
      }
    )

    await expect(waitForStableTrees([], sampler, 3_000, dependencies)).rejects.toThrow(
      'Codex process trees did not reach a settled state'
    )
    expect(now).toBe(3_000)
    expect(readCount).toBe(15)
  })

  it('rejects a read that crosses the deadline even when the prior samples were stable', async () => {
    let now = 0
    const dependencies = clockDependencies(
      () => now,
      async () => {
        const snapshot = treeSnapshot()
        if (now === 3_000) {
          now = 3_200
        }
        return [snapshot]
      },
      async (milliseconds) => {
        now += milliseconds
      }
    )

    await expect(waitForStableTrees([], sampler, 3_200, dependencies)).rejects.toThrow(
      'Codex process trees did not reach a settled state'
    )
    expect(now).toBe(3_200)
  })

  it('resets after a slow in-budget read instead of accepting two distant observations', async () => {
    let now = 0
    let readCount = 0
    const dependencies = clockDependencies(
      () => now,
      async () => {
        readCount++
        if (readCount === 2) {
          now += 3_000
        }
        return [treeSnapshot(now < 3_400 ? 202 : 203)]
      },
      async (milliseconds) => {
        now += milliseconds
      }
    )

    const result = await waitForStableTrees([], sampler, 10_000, dependencies)

    expect(now).toBe(6_400)
    expect(result[0]?.rows.at(-1)?.pid).toBe(203)
  })

  it('passes remaining budget to reads and caps the settle deadline at fifteen seconds', async () => {
    let now = 0
    let readCount = 0
    const readBudgets: number[] = []
    const dependencies = clockDependencies(
      () => now,
      async (_sessions, _sampler, remainingMs) => {
        readCount++
        readBudgets.push(remainingMs)
        return [treeSnapshot(202 + readCount)]
      },
      async (milliseconds) => {
        now += milliseconds
      }
    )

    await expect(waitForStableTrees([], sampler, 20_000, dependencies)).rejects.toThrow(
      'Codex process trees did not reach a settled state'
    )
    expect(readBudgets[0]).toBe(15_000)
    expect(readBudgets.at(-1)).toBe(200)
    expect(readCount).toBe(75)
    expect(now).toBe(15_000)
  })

  it('does not accept a tree when the remaining budget is shorter than the quiet window', async () => {
    let now = 0
    let readCount = 0
    let lastReadBudget = 0
    const dependencies = clockDependencies(
      () => now,
      async (_sessions, _sampler, remainingMs) => {
        readCount++
        lastReadBudget = remainingMs
        return [treeSnapshot()]
      },
      async (milliseconds) => {
        now += milliseconds
      }
    )

    await expect(waitForStableTrees([], sampler, 2_999, dependencies)).rejects.toThrow(
      'Codex process trees did not reach a settled state'
    )
    expect(lastReadBudget).toBe(199)
    expect(readCount).toBe(15)
    expect(now).toBe(2_999)
  })

  it('propagates snapshot read failures unchanged', async () => {
    const failure = new Error('process snapshot unavailable')
    const dependencies = clockDependencies(
      () => 0,
      async () => {
        throw failure
      },
      async () => {}
    )

    await expect(waitForStableTrees([], sampler, 5_000, dependencies)).rejects.toBe(failure)
  })

  it('preserves tree validation failures', async () => {
    const invalid = treeSnapshot()
    invalid.descendants = []
    const dependencies = clockDependencies(
      () => 0,
      async () => [invalid],
      async () => {}
    )

    await expect(waitForStableTrees([], sampler, 5_000, dependencies)).rejects.toThrow(
      'Windows PowerShell has no live Codex executable'
    )
  })
})
