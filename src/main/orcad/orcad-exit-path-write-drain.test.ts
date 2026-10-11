// orcad's shutdown drains the async secure-file lanes after rpc.stop: these pin that the drain-then-
// exit sequence ends only after a write queued behind a slow one has landed, and stays bounded.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { serializePathWrite } from '../../shared/path-write-serializer'
import { writeSecureJsonFileAsync } from '../../shared/secure-file-async-write'
import {
  drainPathWritesForQuit,
  PATH_WRITE_QUIT_DEADLINE_MS
} from '../startup/path-write-quit-drain'
import { ORCAD_SHUTDOWN_DEADLINE_MS } from './orcad-lifecycle'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), 'orcad-exit-drain-'))
  roots.push(root)
  return root
}

it('ends the exit path only after a write queued behind a slow one has landed', async () => {
  const path = join(directory(), 'devices.json')
  // A slow earlier write on the same path (an ACL spawn on Windows) holds the lane.
  let releaseEarlier!: () => void
  const earlier = serializePathWrite(
    path,
    () =>
      new Promise<void>((resolve) => {
        releaseEarlier = resolve
      })
  )
  const revoke = writeSecureJsonFileAsync(path, [{ deviceId: 'kept-device' }])
  const exit = vi.fn()
  // orcad's shutdown: rpc.stop, the dismissal flush, the drain, then process.exit.
  const exitPath = drainPathWritesForQuit().then(() => exit(existsSync(path)))

  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(exit).not.toHaveBeenCalled()

  releaseEarlier()
  await Promise.all([earlier, revoke, exitPath])
  expect(exit).toHaveBeenCalledWith(true)
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([{ deviceId: 'kept-device' }])
})

it('bounds the drain well inside the orcad shutdown deadline', () => {
  // orcad calls the drain with its default bound; a hung write must not outlast the deadline that
  // would otherwise end the process with exit code 1.
  expect(PATH_WRITE_QUIT_DEADLINE_MS).toBeLessThan(ORCAD_SHUTDOWN_DEADLINE_MS)
})
