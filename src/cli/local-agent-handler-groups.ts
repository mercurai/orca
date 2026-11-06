export const LOCAL_AGENT_HANDLER_GROUPS = [
  {
    name: 'agent-hooks',
    keys: ['agent hooks prepare-codex', 'agent hooks status', 'agent hooks off', 'agent hooks on'],
    load: async () => (await import('./handlers/agent-hooks.js')).AGENT_HOOK_HANDLERS
  },
  {
    name: 'agent-codex-native',
    keys: ['agent resolve-codex-native'],
    load: async () => (await import('./handlers/agent-codex-native.js')).AGENT_CODEX_NATIVE_HANDLERS
  }
]
