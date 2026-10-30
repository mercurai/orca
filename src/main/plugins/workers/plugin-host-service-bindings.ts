import { PLUGIN_WORKSPACE_TERMINAL_LIMIT } from '../../../shared/plugins/workers/plugin-host-api'
import type { PluginHostServices } from './plugin-host-methods'
import { PluginSecretsStore } from '../plugin-secrets-store'
import { PluginKvStore } from '../plugin-storage-store'
import type { TerminalInputKind } from '../../../shared/terminal-input-kind'

export type PluginRuntimeDelegate = {
  resolveActiveWorktreeContext(): Promise<{
    worktreeId: string
    path: string
    branch: string
    displayName: string
  } | null>
  listTerminals(
    worktreeSelector?: string,
    limit?: number,
    opts?: { includeVisualLayouts?: boolean }
  ): Promise<{ terminals: { handle: string; title: string | null }[] }>
  sendTerminal(
    handle: string,
    action: { text?: string; enter?: boolean },
    options: { inputKind: TerminalInputKind }
  ): Promise<{ accepted: boolean }>
  dispatchPluginNotification(input: {
    pluginId: string
    title: string
    body?: string
  }): Promise<{ delivered: boolean }>
}

export function bindPluginHostServices(input: {
  delegate: PluginRuntimeDelegate
  pluginsDataDir: string
  pluginKey: string
  invokePluginCommand?: PluginHostServices['invokePluginCommand']
}): PluginHostServices {
  const { delegate, pluginsDataDir, pluginKey } = input
  const storage = new PluginKvStore(pluginsDataDir, pluginKey, 'storage.json')
  const settings = new PluginKvStore(pluginsDataDir, pluginKey, 'settings.json')
  const secrets = new PluginSecretsStore(pluginsDataDir, pluginKey)
  const forPlugin = <T>(key: string, operation: () => T): T => {
    if (key !== pluginKey) {
      throw new Error('plugin data binding belongs to another plugin')
    }
    return operation()
  }
  return {
    invokePluginCommand: input.invokePluginCommand,
    resolveActiveWorktreeContext: async () => {
      const context = await delegate.resolveActiveWorktreeContext()
      if (!context) {
        return null
      }
      // Retain path-bearing worktree IDs for host membership checks; public projections exclude them.
      return {
        worktreeId: context.worktreeId,
        branch: context.branch,
        displayName: context.displayName
      }
    },
    listWorktreeTerminals: async (worktreeId) => {
      const result = await delegate.listTerminals(
        `id:${worktreeId}`,
        PLUGIN_WORKSPACE_TERMINAL_LIMIT,
        { includeVisualLayouts: false }
      )
      return result.terminals
        .slice(0, PLUGIN_WORKSPACE_TERMINAL_LIMIT)
        .map((terminal) => ({ id: terminal.handle }))
    },
    sendTerminalText: async (terminalId, action) => {
      const result = await delegate.sendTerminal(terminalId, action, { inputKind: 'driving' })
      return { accepted: result.accepted }
    },
    dispatchPluginNotification: (notification) => delegate.dispatchPluginNotification(notification),
    storage: {
      get: (key, itemKey) => forPlugin(key, () => storage.get(itemKey)),
      set: (key, itemKey, value) => forPlugin(key, () => storage.set(itemKey, value)),
      delete: (key, itemKey) => forPlugin(key, () => storage.delete(itemKey)),
      keys: (key) => forPlugin(key, () => storage.keys())
    },
    secrets: {
      get: (key, itemKey) => forPlugin(key, () => secrets.get(itemKey)),
      set: (key, itemKey, value) => forPlugin(key, () => secrets.set(itemKey, value)),
      delete: (key, itemKey) => forPlugin(key, () => secrets.delete(itemKey))
    },
    settings: {
      getAll: (key) => forPlugin(key, () => settings.getAll()),
      set: (key, itemKey, value) => forPlugin(key, () => settings.set(itemKey, value))
    }
  }
}
