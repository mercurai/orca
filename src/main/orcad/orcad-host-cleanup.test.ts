import { expect, it, vi } from 'vitest'
import { serializePathWrite } from '../../shared/path-write-serializer'
import { runOrcadHostCleanup } from './orcad-lifecycle'
import { PATH_WRITE_QUIT_DEADLINE_MS } from '../startup/path-write-quit-drain'

let lane = 0

it('keeps ownership fences when the secure-write drain times out', async () => {
  vi.useFakeTimers()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const gate = Promise.withResolvers<void>()
  const events: string[] = []
  const write = serializePathWrite('orcad-host-cleanup-timeout', () => gate.promise)
  try {
    const outcome = runOrcadHostCleanup(steps(events)).then(
      () => null,
      (error: unknown) => error
    )
    await vi.advanceTimersByTimeAsync(PATH_WRITE_QUIT_DEADLINE_MS)
    expect(await outcome).toBeInstanceOf(Error)
    expect(events).not.toContain('admission-released')
    expect(events).not.toContain('lock-released')
  } finally {
    gate.resolve()
    await write
    warn.mockRestore()
    vi.useRealTimers()
  }
})

// A secure-file write still in its path lane when shutdown reaches the host cleanup.
function pendingWrite(events: string[], label: string, landAfterMs = 50): Promise<void> {
  lane += 1
  return serializePathWrite(
    `orcad-host-cleanup-test-${lane}`,
    () =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          events.push(label)
          resolve()
        }, landAfterMs)
      )
  )
}

function steps(
  events: string[],
  overrides: Partial<Parameters<typeof runOrcadHostCleanup>[0]> = {}
) {
  return {
    stopBrowserProvider: async () => {
      events.push('provider-stopped')
    },
    clearBrowserCommands: () => {
      events.push('commands-cleared')
    },
    runQuitHandlers: () => {
      events.push('quit-handlers')
    },
    releaseAdmission: () => {
      events.push('admission-released')
    },
    releaseInstanceLock: () => {
      events.push('lock-released')
    },
    ...overrides
  }
}

it('lets a write in flight at shutdown land before the lock is released and the process exits', async () => {
  const events: string[] = []
  const write = pendingWrite(events, 'write-landed')

  await runOrcadHostCleanup(steps(events))
  await write

  expect(events).toEqual([
    'provider-stopped',
    'commands-cleared',
    'quit-handlers',
    'write-landed',
    'admission-released',
    'lock-released'
  ])
})

it('waits for a write a quit handler queues (push and relay stop there)', async () => {
  const events: string[] = []
  let queued: Promise<void> | null = null

  await runOrcadHostCleanup(
    steps(events, {
      runQuitHandlers: () => {
        events.push('quit-handlers')
        queued = pendingWrite(events, 'quit-handler-write-landed')
      }
    })
  )
  await queued

  expect(events.indexOf('quit-handler-write-landed')).toBeLessThan(events.indexOf('lock-released'))
})

it('still drains but keeps admission and the lock held when stopping the browser provider throws', async () => {
  const events: string[] = []
  const write = pendingWrite(events, 'write-landed')

  await expect(
    runOrcadHostCleanup(
      steps(events, {
        stopBrowserProvider: async () => {
          throw new Error('provider stop failed')
        }
      })
    )
  ).rejects.toThrow('provider stop failed')
  await write

  expect(events).toEqual(['commands-cleared', 'quit-handlers', 'write-landed'])
})
