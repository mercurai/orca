import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../own-chromium-tree-kill-guard', () => ({
  admitSelfInitiatedTreeKill: vi.fn(() => true)
}))

import { GitSpawnWorkerClient, MAX_CONSECUTIVE_DEATHS } from './git-spawn-worker-client'
import type { SpawnWorkerRequest, SpawnWorkerResponse } from './git-spawn-worker-protocol'

class FakeWorker extends EventEmitter {
  readonly requests: SpawnWorkerRequest[] = []
  postMessage(request: SpawnWorkerRequest): void {
    this.requests.push(request)
  }
  unref(): void {}
  terminate(): Promise<number> {
    return Promise.resolve(0)
  }
  reply(message: SpawnWorkerResponse): void {
    this.emit('message', message)
  }
}

const SPEC = { command: 'git', args: ['status'], maxBuffer: 1024 }

function newClient(workers: FakeWorker[]): GitSpawnWorkerClient {
  return new GitSpawnWorkerClient({
    workerFactory: () => {
      const worker = new FakeWorker()
      workers.push(worker)
      return worker
    },
    log: () => {}
  })
}

describe('GitSpawnWorkerClient', () => {
  it('settles a capture from the worker result and reports termination on close', async () => {
    const workers: FakeWorker[] = []
    const client = newClient(workers)
    const onTerminated = vi.fn()
    const handle = client.capture(SPEC, onTerminated)
    expect(workers[0]?.requests[0]).toMatchObject({ type: 'capture', id: 1, command: 'git' })

    workers[0]?.reply({
      type: 'result',
      id: 1,
      error: null,
      stdout: 'ok',
      stderr: '',
      terminating: false
    })
    await expect(handle?.outcome).resolves.toMatchObject({ kind: 'result', stdout: 'ok' })
    expect(onTerminated).not.toHaveBeenCalled()

    workers[0]?.reply({ type: 'closed', id: 1, code: 0, signal: null })
    expect(onTerminated).toHaveBeenCalledOnce()
  })

  it('waits for killed instead of a result that arrived while a kill was in flight', async () => {
    const workers: FakeWorker[] = []
    const client = newClient(workers)
    const handle = client.capture(SPEC, () => {})
    workers[0]?.reply({
      type: 'result',
      id: 1,
      error: { message: 'killed', name: 'Error', killed: true },
      stdout: '',
      stderr: '',
      terminating: true
    })
    workers[0]?.reply({ type: 'closed', id: 1, code: null, signal: 'SIGTERM' })
    workers[0]?.reply({ type: 'killed', id: 1, reason: 'timeout' })

    await expect(handle?.outcome).resolves.toEqual({ kind: 'killed', reason: 'timeout' })
  })

  it('answers a kill check with the own-Chromium guard decision', () => {
    const workers: FakeWorker[] = []
    const client = newClient(workers)
    client.capture(SPEC, () => {})
    workers[0]?.reply({ type: 'kill-check', id: 1, pid: 4321 })

    expect(workers[0]?.requests.at(-1)).toEqual({ type: 'verdict', id: 1, admit: true })
  })

  it('fails in-flight work and reports termination once when the worker exits', async () => {
    const workers: FakeWorker[] = []
    const client = newClient(workers)
    const onTerminated = vi.fn()
    const handle = client.capture(SPEC, onTerminated)
    workers[0]?.emit('exit', 1)

    await expect(handle?.outcome).resolves.toMatchObject({ kind: 'failed' })
    expect(onTerminated).toHaveBeenCalledOnce()
    expect(client.capture(SPEC, () => {})).not.toBeNull()
    expect(workers).toHaveLength(2)
  })

  it('stops using the worker after repeated consecutive deaths', () => {
    const workers: FakeWorker[] = []
    const client = newClient(workers)
    for (let death = 0; death < MAX_CONSECUTIVE_DEATHS; death += 1) {
      client.capture(SPEC, () => {})
      workers.at(-1)?.emit('exit', 1)
    }

    expect(client.isAvailable).toBe(false)
  })

  it('reports unavailable and returns null when no worker can be created', () => {
    const log = vi.fn()
    const client = new GitSpawnWorkerClient({
      workerFactory: () => {
        throw new Error('entry missing')
      },
      log
    })

    expect(client.capture(SPEC, () => {})).toBeNull()
    expect(client.isAvailable).toBe(false)
    expect(log).toHaveBeenCalledOnce()
  })

  it('delivers stream chunks as Buffers and acknowledges them in one batch', async () => {
    const workers: FakeWorker[] = []
    const client = newClient(workers)
    const chunks: string[] = []
    client.stream(
      { command: 'git', args: ['log'], cwd: '/repo' },
      {
        onChunk: (_channel, data) => chunks.push(data.toString('utf8')),
        onError: () => {},
        onClose: () => {}
      }
    )
    for (const text of ['a', 'b', 'c']) {
      workers[0]?.reply({
        type: 'chunk',
        id: 1,
        channel: 'stdout',
        data: new TextEncoder().encode(text)
      })
    }
    await Promise.resolve()

    expect(chunks).toEqual(['a', 'b', 'c'])
    expect(workers[0]?.requests.filter((request) => request.type === 'ack')).toEqual([
      { type: 'ack', id: 1, chunks: 3 }
    ])
  })
})
