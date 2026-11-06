import { describe, expect, it } from 'vitest'
import {
  waitForProcessTreeExit,
  type ProcessIdentity
} from '../../../tests/tools/windows-codex-native-runtime/process-tree-identity'
import type { WindowsProcessIdentityRow } from '../windows/windows-process-table'

function row(
  pid: number,
  ppid: number,
  creationTimeMs?: number,
  name = 'codex.exe'
): WindowsProcessIdentityRow {
  return creationTimeMs === undefined ? { pid, ppid, name } : { pid, ppid, name, creationTimeMs }
}

function clockOptions(
  readRows: () => Promise<WindowsProcessIdentityRow[]>,
  now: () => number,
  pause: (milliseconds: number) => Promise<void>
): {
  timeoutMs: number
  intervalMs: number
  label: string
  readRows: () => Promise<WindowsProcessIdentityRow[]>
  now: () => number
  pause: (milliseconds: number) => Promise<void>
} {
  return { timeoutMs: 30, intervalMs: 10, label: 'runtime shell', readRows, now, pause }
}

describe('native process-tree exit evidence', () => {
  it('retries an incomplete descendant snapshot until the child disappears', async () => {
    let now = 0
    let readCount = 0
    const snapshots = [[row(601, 501, undefined)], []]

    await waitForProcessTreeExit(501, 100, [], {
      ...clockOptions(
        async () => snapshots[readCount++] ?? [],
        () => now,
        async (milliseconds) => {
          now += milliseconds
        }
      )
    })

    expect(readCount).toBe(2)
  })

  it('does not accept a descendant that persistently lacks creation time', async () => {
    let now = 0
    let readCount = 0

    await expect(
      waitForProcessTreeExit(501, 100, [], {
        ...clockOptions(
          async () => {
            readCount++
            return [row(601, 501, undefined)]
          },
          () => now,
          async (milliseconds) => {
            now += milliseconds
          }
        )
      })
    ).rejects.toThrow('runtime shell process identity remained incomplete at close')
    expect(readCount).toBe(3)
  })

  it('does not treat a root row without creation time as exited', async () => {
    let now = 0
    let readCount = 0
    const rootIdentity: ProcessIdentity = { pid: 501, creationTimeMs: 100 }

    await expect(
      waitForProcessTreeExit(501, 100, [rootIdentity], {
        ...clockOptions(
          async () => {
            readCount++
            return [row(501, 1, undefined, 'bash.exe')]
          },
          () => now,
          async (milliseconds) => {
            now += milliseconds
          }
        )
      })
    ).rejects.toThrow('runtime shell process identity remained incomplete at close')
    expect(readCount).toBe(3)
  })

  it('does not count known PIDs reused by a later process generation', async () => {
    let now = 0
    let readCount = 0
    const observed: ProcessIdentity[] = [
      { pid: 501, creationTimeMs: 100 },
      { pid: 601, creationTimeMs: 700 }
    ]

    await waitForProcessTreeExit(501, 100, observed, {
      ...clockOptions(
        async () => {
          readCount++
          return [row(501, 1, 900, 'bash.exe'), row(601, 1, 800), row(602, 501, 901)]
        },
        () => now,
        async (milliseconds) => {
          now += milliseconds
        }
      )
    })

    expect(readCount).toBe(1)
  })

  it('does not pass when a detached observed PID has no creation time', async () => {
    let now = 0
    let readCount = 0
    const observed: ProcessIdentity[] = [{ pid: 601, creationTimeMs: 700 }]

    await expect(
      waitForProcessTreeExit(501, 100, observed, {
        ...clockOptions(
          async () => {
            readCount++
            return [row(601, 1, undefined)]
          },
          () => now,
          async (milliseconds) => {
            now += milliseconds
          }
        )
      })
    ).rejects.toThrow('runtime shell process identity remained incomplete at close')
    expect(readCount).toBe(3)
  })

  it('does not accept clear evidence returned after the deadline', async () => {
    let now = 0
    let readCount = 0

    await expect(
      waitForProcessTreeExit(501, 100, [], {
        ...clockOptions(
          async () => {
            readCount++
            now = 30
            return []
          },
          () => now,
          async (milliseconds) => {
            now += milliseconds
          }
        )
      })
    ).rejects.toThrow('runtime shell process identity check exceeded its close deadline')
    expect(readCount).toBe(1)
  })
})
