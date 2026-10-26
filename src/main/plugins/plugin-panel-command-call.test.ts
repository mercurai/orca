import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from '../../shared/plugins/plugin-manifest'
import { executePluginHostCall, type PluginHostServices } from './plugin-host-methods'
import { assertPluginWorkerCommand } from './plugin-command-invocation'
import type { ValidDiscoveredPlugin } from './plugin-discovery'

const PLUGIN_KEY = 'mercurai.orca-flow-kit'

function createHarness(result: unknown = { config: { autoRun: false } }) {
  const parsed = parsePluginManifest({
    manifestVersion: 1,
    id: 'orca-flow-kit',
    publisher: 'mercurai',
    name: 'Workflow Designer',
    version: '0.1.0',
    engines: { orca: '>=1.4.0' },
    pluginApi: 1,
    main: 'main.mjs',
    contributes: {
      commands: [
        { id: 'flow-kit-read', title: 'Read workflow' },
        { id: 'alias', title: 'Alias', action: 'sidebar.right.toggle' }
      ]
    }
  })
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
  const plugin: ValidDiscoveredPlugin = {
    pluginKey: PLUGIN_KEY,
    rootDir: '/owned/plugin',
    manifest: parsed.manifest,
    consentFingerprint: 'test-consent',
    contentHash: null,
    isDev: true
  }
  const calls: { pluginKey: string; commandId: string; args: unknown }[] = []
  const audit: { outcome: string; summary: string }[] = []
  const order: string[] = []
  const data = new Map<string, unknown>()
  const services: PluginHostServices = {
    resolveActiveWorktreeContext: async () => null,
    listWorktreeTerminals: async () => [],
    sendTerminalText: async () => ({ accepted: false }),
    dispatchPluginNotification: async () => ({ delivered: false }),
    storage: {
      get: (_pluginKey, key) => data.get(key),
      set: async (_pluginKey, key, value) => {
        data.set(key, value)
        return { ok: true }
      },
      delete: async (_pluginKey, key) => {
        data.delete(key)
      },
      keys: () => [...data.keys()]
    },
    secrets: {
      get: () => ({ ok: true, value: null }),
      set: async () => ({ ok: true }),
      delete: async () => {}
    },
    settings: { getAll: () => ({}), set: async () => ({ ok: true }) },
    subscribeEvents: (_pluginKey, events) => events,
    invokePluginCommand: async (pluginKey, commandId, args) => {
      assertPluginWorkerCommand(plugin, commandId)
      calls.push({ pluginKey, commandId, args })
      order.push('invoke')
      return result
    }
  }
  const input = {
    pluginId: PLUGIN_KEY,
    method: 'commands.invoke',
    viaPanel: true,
    grantedCapabilities: ['commands:invoke'] as const,
    services,
    audit: {
      record: async (entry: { outcome: string; summary: string }) => {
        audit.push(entry)
        order.push(`audit:${entry.outcome}`)
      }
    }
  }
  return { input, calls, audit, order }
}

describe('sandboxed panel command invocation', () => {
  it('routes a declared worker command using the authenticated plugin identity', async () => {
    const harness = createHarness()
    const args = { path: 'flow.config.json' }
    const result = await executePluginHostCall({
      ...harness.input,
      params: { commandId: 'flow-kit-read', args }
    })
    expect(result).toEqual({ ok: true, value: { value: { config: { autoRun: false } } } })
    expect(harness.calls).toEqual([{ pluginKey: PLUGIN_KEY, commandId: 'flow-kit-read', args }])
    expect(harness.order).toEqual(['audit:attempt', 'invoke', 'audit:ok'])
  })

  it.each(['pluginId', 'pluginKey'])(
    'rejects a caller-supplied %s before invoking a worker',
    async (field) => {
      const harness = createHarness()
      const result = await executePluginHostCall({
        ...harness.input,
        params: { commandId: 'flow-kit-read', [field]: 'other.plugin' }
      })
      expect(result).toMatchObject({ ok: false, code: 'invalid_params' })
      expect(harness.calls).toEqual([])
    }
  )

  it('requires explicit command invocation consent', async () => {
    const harness = createHarness()
    const result = await executePluginHostCall({
      ...harness.input,
      grantedCapabilities: [],
      params: { commandId: 'flow-kit-read' }
    })
    expect(result).toMatchObject({ ok: false, code: 'capability_denied' })
    expect(harness.calls).toEqual([])
  })

  it('rejects revoked approval before invoking a worker', async () => {
    const harness = createHarness()
    const result = await executePluginHostCall({
      ...harness.input,
      grantedCapabilities: null,
      params: { commandId: 'flow-kit-read' }
    })
    expect(result).toMatchObject({ ok: false, code: 'consent_required' })
    expect(harness.calls).toEqual([])
  })

  it.each(['other-plugin-read', 'alias'])(
    'cannot invoke undeclared or renderer-owned command %s',
    async (commandId) => {
      const harness = createHarness()
      const result = await executePluginHostCall({ ...harness.input, params: { commandId } })
      expect(result).toMatchObject({ ok: false, code: 'action_failed' })
      expect(harness.calls).toEqual([])
    }
  )

  it('does not invoke a worker if audit intent cannot be recorded', async () => {
    const harness = createHarness()
    const result = await executePluginHostCall({
      ...harness.input,
      params: { commandId: 'flow-kit-read' },
      audit: {
        record: async () => {
          throw new Error('audit unavailable')
        }
      }
    })
    expect(result).toMatchObject({ ok: false, code: 'action_failed' })
    expect(harness.calls).toEqual([])
  })

  it('does not record command argument contents in its audit summaries', async () => {
    const harness = createHarness()
    const marker = 'PRIVATE_TEST_MARKER'
    await executePluginHostCall({
      ...harness.input,
      params: { commandId: 'flow-kit-read', args: { note: marker } }
    })
    expect(harness.audit).toHaveLength(2)
    expect(harness.audit.every((entry) => entry.summary === 'command=flow-kit-read')).toBe(true)
    expect(JSON.stringify(harness.audit)).not.toContain(marker)
  })

  it('rejects non-JSON worker results', async () => {
    const harness = createHarness(new Date())
    const result = await executePluginHostCall({
      ...harness.input,
      params: { commandId: 'flow-kit-read' }
    })
    expect(result).toMatchObject({ ok: false, code: 'action_failed' })
  })

  it('rejects a worker result above the bridge payload budget', async () => {
    const harness = createHarness('x'.repeat(64 * 1024))
    const result = await executePluginHostCall({
      ...harness.input,
      params: { commandId: 'flow-kit-read' }
    })
    expect(result).toMatchObject({ ok: false, code: 'action_failed' })
  })
})
