import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '../../../shared/child-process/process-spec'
import { setSpawnObserver } from '../../../shared/child-process/spawn-observer'
import { RunProcessTable, runProcessOnWorker } from './git-spawn-worker-client-runprocess'
import type { SpawnWorkerRequest } from './git-spawn-worker-protocol'

vi.mock('../../own-chromium-tree-kill-guard', () => ({ admitSelfInitiatedTreeKill: vi.fn() }))

const LOCAL_RESULT: ProcessResult = {
  code: 0,
  signal: null,
  stdout: 'local',
  stderr: '',
  timedOut: false
}

function createTable(accept = true): { table: RunProcessTable; sent: SpawnWorkerRequest[] } {
  const sent: SpawnWorkerRequest[] = []
  let nextId = 0
  const table = new RunProcessTable({
    allocateId: () => ++nextId,
    send: (request) => {
      sent.push(request)
      return accept
    },
    onBusy: () => {},
    onIdle: () => {}
  })
  return { table, sent }
}

afterEach(() => setSpawnObserver(null))

describe('runProcessOnWorker', () => {
  it('sends only data across the thread and settles with the worker result', async () => {
    const { table, sent } = createTable()
    const onChildTerminated = vi.fn()
    const pending = runProcessOnWorker(
      table,
      {
        program: 'gh',
        args: ['api'],
        timeoutMs: 5,
        signal: new AbortController().signal,
        onChildTerminated
      },
      'tail',
      () => Promise.resolve(LOCAL_RESULT)
    )
    expect(sent).toEqual([
      { type: 'run', id: 1, capture: 'tail', spec: { program: 'gh', args: ['api'], timeoutMs: 5 } }
    ])
    table.handle({ type: 'run-terminated', id: 1 })
    table.handle({
      type: 'run-result',
      id: 1,
      error: null,
      result: {
        code: 0,
        signal: null,
        stdout: 'x',
        stderr: '',
        timedOut: false,
        stdoutBytes: new Uint8Array([1, 2])
      }
    })
    const result = await pending
    expect(result).toMatchObject({ code: 0, stdout: 'x' })
    expect(Buffer.isBuffer(result.stdoutBytes)).toBe(true)
    expect(onChildTerminated).toHaveBeenCalledOnce()
  })

  it('keeps a spec in-process when it holds a stdio layout or a barrier that cannot be rebuilt', () => {
    const { table, sent } = createTable()
    const inProcess = (): Promise<ProcessResult> => Promise.resolve(LOCAL_RESULT)
    expect(
      runProcessOnWorker(table, { program: 'x', stdio: 'ignore' }, 'head', inProcess)
    ).toBeNull()
    const barrier = { signal: () => Promise.resolve(true), force: () => Promise.resolve(true) }
    expect(
      runProcessOnWorker(table, { program: 'x', terminationBarrier: barrier }, 'head', inProcess)
    ).toBeNull()
    expect(sent).toEqual([])
  })

  it('passes a barrier descriptor as data', () => {
    const { table, sent } = createTable()
    const worker = { kind: 'wsl-process-group', distro: 'Ubuntu', marker: 'm=' } as const
    runProcessOnWorker(
      table,
      {
        program: 'wsl.exe',
        terminationBarrier: {
          worker,
          signal: () => Promise.resolve(true),
          force: () => Promise.resolve(true)
        }
      },
      'head',
      () => Promise.resolve(LOCAL_RESULT)
    )
    expect(sent[0]).toMatchObject({ spec: { terminationBarrier: worker } })
  })

  it('returns null when the worker takes no request', () => {
    const { table } = createTable(false)
    expect(
      runProcessOnWorker(table, { program: 'x' }, 'head', () => Promise.resolve(LOCAL_RESULT))
    ).toBeNull()
  })

  it('forwards an abort as a terminate message', () => {
    const { table, sent } = createTable()
    const controller = new AbortController()
    void runProcessOnWorker(table, { program: 'x', signal: controller.signal }, 'head', () =>
      Promise.resolve(LOCAL_RESULT)
    )
    controller.abort()
    expect(sent.at(-1)).toEqual({ type: 'terminate', id: 1 })
  })

  it('rejects with the revived spawn error and keeps its code', async () => {
    const { table } = createTable()
    const pending = runProcessOnWorker(table, { program: 'x' }, 'head', () =>
      Promise.resolve(LOCAL_RESULT)
    )
    table.handle({
      type: 'run-result',
      id: 1,
      result: null,
      error: { message: 'spawn x ENOENT', name: 'Error', code: 'ENOENT' }
    })
    await expect(pending).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('counts a worker spawn without attributing main-thread block', () => {
    const observer = vi.fn()
    setSpawnObserver(observer)
    const { table } = createTable()
    void runProcessOnWorker(table, { program: 'wsl.exe', args: ['--status'] }, 'head', () =>
      Promise.resolve(LOCAL_RESULT)
    )
    table.handle({ type: 'run-spawned', id: 1, pid: 99 })
    expect(observer).toHaveBeenCalledExactlyOnceWith('wsl.exe', ['--status'], 0)
  })

  it('runs a request in-process when the worker died before spawning it', async () => {
    const { table } = createTable()
    const inProcess = vi.fn(() => Promise.resolve(LOCAL_RESULT))
    const pending = runProcessOnWorker(table, { program: 'x' }, 'head', inProcess)
    table.failAll(new Error('worker exited'))
    await expect(pending).resolves.toBe(LOCAL_RESULT)
    expect(inProcess).toHaveBeenCalledOnce()
  })

  it('fails a spawned run instead of repeating it, and reports the child terminated once', async () => {
    const { table } = createTable()
    const onChildTerminated = vi.fn()
    const inProcess = vi.fn(() => Promise.resolve(LOCAL_RESULT))
    const pending = runProcessOnWorker(
      table,
      { program: 'x', onChildTerminated },
      'head',
      inProcess
    )
    table.handle({ type: 'run-spawned', id: 1, pid: undefined })
    table.failAll(new Error('worker exited'), 'EGITSPAWNWORKER')
    await expect(pending).rejects.toMatchObject({ code: 'EGITSPAWNWORKER' })
    expect(inProcess).not.toHaveBeenCalled()
    expect(onChildTerminated).toHaveBeenCalledOnce()
  })
})
