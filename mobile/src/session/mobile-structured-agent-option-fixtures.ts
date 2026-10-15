import type { AgentSessionOptionsResult } from '../../../src/shared/agent-session-wire'

export const OPTIONS: AgentSessionOptionsResult = {
  models: [
    {
      id: 'gpt-live',
      label: 'GPT Live',
      isDefault: true,
      defaultEffort: 'medium',
      efforts: [
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' }
      ]
    },
    {
      id: 'gpt-fast',
      label: 'GPT Fast',
      isDefault: false,
      defaultEffort: 'low',
      efforts: [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' }
      ]
    }
  ],
  current: { model: 'gpt-live', effort: 'medium' }
}

/** Session support and the provider catalog both say yes, which is the only shape
 *  that earns a Fast row. */
export const FAST_OPTIONS: AgentSessionOptionsResult = {
  ...OPTIONS,
  models: OPTIONS.models.map((model) => ({ ...model, supportsFastMode: true })),
  fastModeSupport: { supported: true },
  current: { ...OPTIONS.current, fastMode: false, confirmed: ['fastMode'] }
}

export const FAST_OPTIONS_ON: AgentSessionOptionsResult = {
  ...FAST_OPTIONS,
  current: { ...FAST_OPTIONS.current, fastMode: true }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}
