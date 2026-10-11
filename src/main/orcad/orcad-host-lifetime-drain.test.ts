import { expect, it } from 'vitest'
import { serializePathWrite } from '../../shared/path-write-serializer'
import { createOrcadHostLifetime } from './orcad-lifecycle'

let lane = 0

// A secure-file write still in its path lane when shutdown reaches the host teardown.
function pendingWrite(events: string[], label: string, landAfterMs = 50): Promise<void> {
  lane += 1
  return serializePathWrite(
    `orcad-host-lifetime-test-${lane}`,
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
  overrides: Partial<Parameters<typeof createOrcadHostLifetime>[0]> = {}
): Parameters<typeof createOrcadHostLifetime>[0] {
  return {
    runtimeCleanupSucceeded: true,
    releaseInstanceLock: () => {
      events.push('lock-released')
    },
    releaseAdmission: () => {
      events.push('admission-released')
    },
    runQuitHandlers: () => {
      events.push('quit-handlers')
    },
    clearBrowserCommands: () => {
      events.push('commands-cleared')
    },
    stopBrowserProvider: async () => {
      events.push('provider-stopped')
    },
    ...overrides
  }
}

it('lets a write in flight at shutdown land before the fences drop and the process exits', async () => {
  const events: string[] = []
  const write = pendingWrite(events, 'write-landed')

  await createOrcadHostLifetime(steps(events)).stop()
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
  const queued: Promise<void>[] = []

  await createOrcadHostLifetime(
    steps(events, {
      runQuitHandlers: () => {
        events.push('quit-handlers')
        queued.push(pendingWrite(events, 'quit-handler-write-landed'))
      }
    })
  ).stop()
  await Promise.all(queued)

  expect(events.indexOf('quit-handler-write-landed')).toBeLessThan(
    events.indexOf('admission-released')
  )
})

it('still drains before the fences when stopping the browser provider throws', async () => {
  const events: string[] = []
  const write = pendingWrite(events, 'write-landed')

  await expect(
    createOrcadHostLifetime(
      steps(events, {
        stopBrowserProvider: async () => {
          throw new Error('provider stop failed')
        }
      })
    ).stop()
  ).rejects.toThrow('provider stop failed')
  await write

  // A failed teardown keeps both fences until exit, but the queued write still lands first.
  expect(events).toContain('write-landed')
  expect(events).not.toContain('admission-released')
  expect(events).not.toContain('lock-released')
})
