import { removeAgentArgOption } from './agent-session-option-agent-args'
import type { AgentSessionOptionCatalog } from './agent-session-option-catalog-types'

export function parsePiModelOptionId(value: string): { provider: string; modelId: string } {
  const slash = value.indexOf('/')
  if (
    slash < 1 ||
    slash === value.length - 1 ||
    /[\s*?]/.test(value) ||
    value.startsWith('-') ||
    value[slash + 1] === '-'
  ) {
    throw new Error('Pi model requires an exact provider-qualified model ID')
  }
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) }
}

export const PI_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  models: [],
  modelApply: {
    launchArgs: (value) => {
      const selector = String(value)
      parsePiModelOptionId(selector)
      if (selector.includes(':')) {
        throw new Error('Pi worker launch model must not include a thinking suffix')
      }
      return ['--model', selector]
    },
    removeAgentArgs: (tokens) => removeAgentArgOption('pi', tokens, ['--model', '-m']),
    midSession: { kind: 'unsupported' }
  },
  discoveredModelsAreAuthoritative: true
}
