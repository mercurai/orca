import { afterEach, expect, it, vi } from 'vitest'
import { pendingPathWritePaths, serializePathWrite } from '../../shared/path-write-serializer'
import { drainPathWritesForQuit } from './path-write-quit-drain'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.restoreAllMocks()
})

it('resolves only after a write already in flight has finished', async () => {
  const gate = deferred()
  const events: string[] = []
  const write = serializePathWrite('/profile/session.json', async () => {
    await gate.promise
    events.push('write-done')
  })

  const drain = drainPathWritesForQuit(5_000).then(() => events.push('drained'))
  await Promise.resolve()
  expect(events).toEqual([])

  gate.resolve()
  await Promise.all([write, drain])
  expect(events).toEqual(['write-done', 'drained'])
})

it('gives up on a hung write at the bound and logs its path, never its payload', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const hang = deferred()
  const write = serializePathWrite('/profile/api-key', () => hang.promise)

  await drainPathWritesForQuit(20)

  expect(warn).toHaveBeenCalledOnce()
  expect(warn.mock.calls[0]).toEqual([
    '[shutdown] Secure file writes still pending at quit',
    { paths: ['/profile/api-key'] }
  ])
  hang.resolve()
  await write
  expect(pendingPathWritePaths()).toEqual([])
})

it('stays quiet when nothing is pending', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await drainPathWritesForQuit(20)
  expect(warn).not.toHaveBeenCalled()
})
