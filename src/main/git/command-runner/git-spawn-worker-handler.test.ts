import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type * as NodeChildProcess from 'node:child_process'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeChildProcess>()),
  spawn: spawnMock
}))

import { createGitSpawnWorkerHandler } from './git-spawn-worker-handler'
import {
  STREAM_HIGH_WATER_CHUNKS,
  STREAM_LOW_WATER_CHUNKS,
  type SpawnWorkerResponse
} from './git-spawn-worker-protocol'

function fakeStreamingChild(): EventEmitter & {
  pid: number
  stdout: EventEmitter & { pause: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn> }
  stderr: EventEmitter & { pause: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn> }
} {
  const stream = (): EventEmitter & {
    pause: ReturnType<typeof vi.fn>
    resume: ReturnType<typeof vi.fn>
  } => Object.assign(new EventEmitter(), { pause: vi.fn(), resume: vi.fn() })
  return Object.assign(new EventEmitter(), { pid: 4242, stdout: stream(), stderr: stream() })
}

describe('git spawn worker handler stream pacing', () => {
  it('pauses stdout past the high-water mark and resumes once main has acknowledged', () => {
    const child = fakeStreamingChild()
    spawnMock.mockReturnValue(child)
    const posted: SpawnWorkerResponse[] = []
    const handler = createGitSpawnWorkerHandler({ postMessage: (message) => posted.push(message) })

    handler.handle({ type: 'stream', id: 7, command: 'git', args: ['log'], cwd: '/repo' })
    for (let chunk = 0; chunk < STREAM_HIGH_WATER_CHUNKS; chunk += 1) {
      child.stdout.emit('data', Buffer.from('x'))
    }

    expect(child.stdout.pause).toHaveBeenCalledOnce()
    expect(posted.filter((message) => message.type === 'chunk')).toHaveLength(
      STREAM_HIGH_WATER_CHUNKS
    )

    handler.handle({
      type: 'ack',
      id: 7,
      chunks: STREAM_HIGH_WATER_CHUNKS - STREAM_LOW_WATER_CHUNKS
    })
    expect(child.stdout.resume).toHaveBeenCalledOnce()
    expect(child.stderr.resume).toHaveBeenCalledOnce()
  })

  it('reports close with the exit code and forgets the request', () => {
    const child = fakeStreamingChild()
    spawnMock.mockReturnValue(child)
    const posted: SpawnWorkerResponse[] = []
    const handler = createGitSpawnWorkerHandler({ postMessage: (message) => posted.push(message) })

    handler.handle({ type: 'stream', id: 8, command: 'git', args: ['log'], cwd: '/repo' })
    child.emit('close', 3, null)
    handler.handle({ type: 'terminate', id: 8 })

    expect(posted).toContainEqual({ type: 'closed', id: 8, code: 3, signal: null })
    expect(posted.some((message) => message.type === 'killed')).toBe(false)
  })
})
