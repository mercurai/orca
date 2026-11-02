import { PLUGIN_WORKSPACE_TERMINAL_LIMIT } from '../../../shared/plugins/workers/plugin-host-api'
import type { PluginHostServices } from './plugin-host-methods'
import type { PluginDesktopFrameServices } from './plugin-host-method-bindings'
import type { PluginPanelBridgeServices } from './plugin-host-panel-method-bindings'
import {
  pluginSettingValueIssue,
  type PluginSettingContribution
} from '../../../shared/plugins/contributions/plugin-settings-contribution'
import { pluginSettingDefaults } from '../../../shared/plugins/contributions/plugin-settings-values'
import { PluginSecretsStore, pluginSecretsProtection } from '../plugin-secrets-store'
import { PluginKvStore } from '../plugin-storage-store'
import type { TerminalInputKind } from '../../../shared/terminal-input-kind'
import { pluginTerminalTitle, type PluginAgentStatusRow } from './plugin-workspace-projection'

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
  ): Promise<{
    terminals: {
      handle: string
      title: string | null
      paneTitle?: string
      tabId?: string
      leafId?: string
    }[]
  }>
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
  /** The hook server's agent rows; absent where no hook server runs. */
  listAgentStatuses?(): readonly PluginAgentStatusRow[]
}

export function bindPluginHostServices(input: {
  delegate: PluginRuntimeDelegate
  pluginsDataDir: string
  desktop?: PluginDesktopFrameServices | null
  panels?: PluginPanelBridgeServices | null
  /** The calling plugin's `contributes.settings`: defaults and value checks. */
  declaredSettings?: readonly PluginSettingContribution[]
  invokePluginCommand?: PluginHostServices['invokePluginCommand']
  /** When set, data calls for any other plugin are refused. */
  pluginKey?: string
}): PluginHostServices {
  const declared = new Map((input.declaredSettings ?? []).map((setting) => [setting.key, setting]))
  const { delegate, pluginsDataDir } = input
  // Stores capture their data lifetime when built. Built here, at admission, a call held in the
  // audit write across a removal and an identical reinstall keeps the retired lifetime and fails;
  // built per operation, it would adopt the reinstalled plugin's lifetime and publish.
  const admitted = input.pluginKey
    ? {
        key: input.pluginKey,
        storage: new PluginKvStore(pluginsDataDir, input.pluginKey, 'storage.json'),
        settings: new PluginKvStore(pluginsDataDir, input.pluginKey, 'settings.json'),
        secrets: new PluginSecretsStore(pluginsDataDir, input.pluginKey)
      }
    : null
  const kvStore = (key: string, fileName: 'storage.json' | 'settings.json'): PluginKvStore =>
    admitted?.key === key
      ? admitted[fileName === 'storage.json' ? 'storage' : 'settings']
      : new PluginKvStore(pluginsDataDir, key, fileName)
  const secretsStore = (key: string): PluginSecretsStore =>
    admitted?.key === key ? admitted.secrets : new PluginSecretsStore(pluginsDataDir, key)
  const services: PluginHostServices = {
    invokePluginCommand: input.invokePluginCommand,
    desktop: input.desktop ?? null,
    panels: input.panels ?? null,
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
      return result.terminals.slice(0, PLUGIN_WORKSPACE_TERMINAL_LIMIT).map((terminal) => ({
        id: terminal.handle,
        title: pluginTerminalTitle(terminal),
        ...(terminal.tabId && terminal.leafId
          ? { paneKey: `${terminal.tabId}:${terminal.leafId}` }
          : {})
      }))
    },
    listAgentStatuses: () => delegate.listAgentStatuses?.() ?? [],
    sendTerminalText: async (terminalId, action) => {
      const result = await delegate.sendTerminal(terminalId, action, { inputKind: 'driving' })
      return { accepted: result.accepted }
    },
    dispatchPluginNotification: (notification) => delegate.dispatchPluginNotification(notification),
    storage: {
      get: (key, itemKey) => kvStore(key, 'storage.json').get(itemKey),
      set: (key, itemKey, value) => kvStore(key, 'storage.json').set(itemKey, value),
      delete: (key, itemKey) => kvStore(key, 'storage.json').delete(itemKey),
      keys: (key) => kvStore(key, 'storage.json').keys()
    },
    secrets: {
      get: (key, itemKey) => secretsStore(key).get(itemKey),
      set: (key, itemKey, value) => secretsStore(key).set(itemKey, value),
      delete: (key, itemKey) => secretsStore(key).delete(itemKey),
      protection: () => (pluginSecretsProtection().level === 'os' ? 'os-keyring' : 'unavailable')
    },
    settings: {
      getAll: (key) => ({
        ...pluginSettingDefaults(declared.values()),
        ...kvStore(key, 'settings.json').getAll()
      }),
      set: async (key, itemKey, value) => {
        const setting = declared.get(itemKey)
        const issue = setting ? pluginSettingValueIssue(setting, value) : null
        return issue
          ? { ok: false, error: `${itemKey} ${issue}` }
          : await kvStore(key, 'settings.json').set(itemKey, value)
      }
    }
  }
  return input.pluginKey ? restrictPluginDataServices(services, input.pluginKey) : services
}

/** Data calls carry the calling plugin's id; a binding made for one plugin refuses any other. */
export function restrictPluginDataServices(
  services: PluginHostServices,
  pluginKey: string
): PluginHostServices {
  const own = <T>(key: string, operation: () => T): T => {
    if (key !== pluginKey) {
      throw new Error('plugin data binding belongs to another plugin')
    }
    return operation()
  }
  const { storage, secrets, settings } = services
  return {
    ...services,
    storage: {
      get: (key, itemKey) => own(key, () => storage.get(key, itemKey)),
      set: (key, itemKey, value) => own(key, () => storage.set(key, itemKey, value)),
      delete: (key, itemKey) => own(key, () => storage.delete(key, itemKey)),
      keys: (key) => own(key, () => storage.keys(key))
    },
    secrets: {
      get: (key, itemKey) => own(key, () => secrets.get(key, itemKey)),
      set: (key, itemKey, value) => own(key, () => secrets.set(key, itemKey, value)),
      delete: (key, itemKey) => own(key, () => secrets.delete(key, itemKey)),
      protection: () => secrets.protection()
    },
    settings: {
      getAll: (key) => own(key, () => settings.getAll(key)),
      set: (key, itemKey, value) => own(key, () => settings.set(key, itemKey, value))
    }
  }
}
