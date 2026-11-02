import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginKvStore, type PluginKvWriteResult } from '../plugin-storage-store'
import { handlePluginPanelStateRequest } from './plugin-panel-state'

const PLUGIN = 'samples.todo'
let dataDir: string

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'orca-panel-state-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dataDir, { recursive: true, force: true })
})

function handle(request: unknown, plugin: string | null = PLUGIN) {
  return handlePluginPanelStateRequest(
    {
      pluginsDataDir: dataDir,
      resolveComponentsPanel: (token) => (token === 'live' ? plugin : null)
    },
    request
  )
}

function twoEntryWrite() {
  return {
    op: 'write',
    sessionToken: 'live',
    workspace: null,
    entries: [
      { scope: 'plugin', key: 'first', version: 1, value: 'a' },
      { scope: 'plugin', key: 'second', version: 1, value: 'b' }
    ]
  }
}

describe('components panel persisted state', () => {
  it('writes plugin and per-workspace values and reads them back by scope', async () => {
    await expect(
      handle({
        op: 'write',
        sessionToken: 'live',
        workspace: '/repo/a',
        entries: [
          { scope: 'plugin', key: 'todos', version: 1, value: ['x'] },
          { scope: 'workspace', key: 'filter', version: 2, value: 'open' }
        ]
      })
    ).resolves.toEqual({ ok: true })
    await expect(
      handle({ op: 'read', sessionToken: 'live', workspace: '/repo/a' })
    ).resolves.toEqual({
      ok: true,
      state: {
        plugin: { todos: { version: 1, value: ['x'] } },
        workspace: { filter: { version: 2, value: 'open' } }
      }
    })
    await expect(
      handle({ op: 'read', sessionToken: 'live', workspace: '/repo/b' })
    ).resolves.toEqual({
      ok: true,
      state: { plugin: { todos: { version: 1, value: ['x'] } }, workspace: {} }
    })
  })

  it('refuses sessions that are not a live components panel, and malformed requests', async () => {
    await expect(handle({ op: 'read', sessionToken: 'stale', workspace: null })).resolves.toEqual({
      ok: false,
      error: 'invalid panel session'
    })
    await expect(
      handle({ op: 'read', sessionToken: 'live', workspace: null }, null)
    ).resolves.toMatchObject({ ok: false })
    await expect(
      handle({
        op: 'write',
        sessionToken: 'live',
        workspace: null,
        entries: [{ scope: 'plugin', key: '../escape', version: 1, value: 1 }]
      })
    ).resolves.toEqual({ ok: false, error: 'malformed panel state request' })
  })

  it('skips workspace values when no workspace is active', async () => {
    await handle({
      op: 'write',
      sessionToken: 'live',
      workspace: null,
      entries: [{ scope: 'workspace', key: 'filter', version: 1, value: 'open' }]
    })
    await expect(
      handle({ op: 'read', sessionToken: 'live', workspace: '/repo/a' })
    ).resolves.toMatchObject({ state: { workspace: {} } })
  })

  it('stays pending while a durable write is held, and writes entries one after another', async () => {
    const release: Array<(result: PluginKvWriteResult) => void> = []
    const started: string[] = []
    vi.spyOn(PluginKvStore.prototype, 'set').mockImplementation((key) => {
      started.push(key)
      return new Promise<PluginKvWriteResult>((resolve) => release.push(resolve))
    })
    let settled = false
    const pending = handle(twoEntryWrite()).then((result) => {
      settled = true
      return result
    })
    await vi.waitFor(() => expect(started).toEqual(['plugin/first']))
    await Promise.resolve()
    expect(settled).toBe(false)
    release[0]({ ok: true })
    await vi.waitFor(() => expect(started).toEqual(['plugin/first', 'plugin/second']))
    expect(settled).toBe(false)
    release[1]({ ok: true })
    await expect(pending).resolves.toEqual({ ok: true })
  })

  it('returns the failed write and stops before later entries', async () => {
    const set = vi
      .spyOn(PluginKvStore.prototype, 'set')
      .mockResolvedValueOnce({ ok: false, error: 'disk full' })
    await expect(handle(twoEntryWrite())).resolves.toEqual({ ok: false, error: 'disk full' })
    expect(set).toHaveBeenCalledTimes(1)
  })
})
