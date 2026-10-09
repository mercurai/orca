import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bindGitCaller, withGitCaller } from '../git/command-runner/git-operation-executor'
import { drainGitExecWindow } from './git-exec-window-aggregate'
import { startGitSpan, withGitSpan } from './instrumentation'
import { _resetTracerForTests, setActiveSink, type TracerSink } from './tracer'

type Pushed = { name: string; attributes: Record<string, unknown> }

function asPushed(record: unknown): Pushed {
  if (
    record !== null &&
    typeof record === 'object' &&
    'name' in record &&
    typeof record.name === 'string' &&
    'attributes' in record &&
    record.attributes !== null &&
    typeof record.attributes === 'object'
  ) {
    return { name: record.name, attributes: Object.fromEntries(Object.entries(record.attributes)) }
  }
  throw new Error('expected span record')
}

let pushed: Pushed[]

beforeEach(() => {
  pushed = []
  drainGitExecWindow()
  const sink: TracerSink = {
    push: (record) => pushed.push(asPushed(record)),
    flush: () => undefined,
    close: () => undefined
  }
  setActiveSink(sink)
})

afterEach(() => {
  _resetTracerForTests()
})

describe('git.caller attribution', () => {
  it('stamps git.exec spans started under a caller purpose', async () => {
    await withGitCaller('git:status', () => withGitSpan({ args: ['status'] }, async () => 'ok'))
    expect(pushed[0].attributes['git.caller']).toBe('git:status')
  })

  it('survives awaits and applies to streaming spans', async () => {
    await bindGitCaller('worktrees:listAll', async () => {
      await Promise.resolve()
      startGitSpan({ args: ['worktree', 'list'] }).end()
    })()
    expect(pushed[0].attributes['git.caller']).toBe('worktrees:listAll')
  })

  it('omits git.caller outside any purpose and does not leak past it', async () => {
    await withGitCaller('repos:register', async () => undefined)
    await withGitSpan({ args: ['status'] }, async () => 'ok')
    expect(pushed[0].attributes).not.toHaveProperty('git.caller')
  })

  it('counts every exec in the window aggregate, including sampled-out ones', async () => {
    for (let i = 0; i < 300; i++) {
      await withGitSpan({ args: ['status'], cwd: '/repo' }, async () => 'ok')
    }
    expect(pushed.length).toBeLessThan(300)
    expect(drainGitExecWindow().status.count).toBe(300)
    expect(drainGitExecWindow()).toEqual({})
  })
})
