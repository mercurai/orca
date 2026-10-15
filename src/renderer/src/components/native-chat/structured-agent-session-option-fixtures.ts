import {
  applyNativeChatSessionOptionSettingsMutation,
  resolveStructuredLaunchSeedOptions
} from '../../../../shared/native-chat-session-option-defaults'
import type {
  NativeChatSessionOptionSettingsMutation,
  PersistedNativeChatSessionOptions
} from '../../../../shared/native-chat-session-options'

export const OPTIONS = {
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

export const FAST_OPTIONS = {
  ...OPTIONS,
  models: OPTIONS.models.map((model) => ({ ...model, supportsFastMode: true })),
  fastModeSupport: { supported: true },
  current: { ...OPTIONS.current, fastMode: false, confirmed: ['fastMode'] }
}

/** Replay every host mutation in order, exactly as the runtime does. */
export function replay(
  mutations: readonly NativeChatSessionOptionSettingsMutation[]
): Record<string, string> | undefined {
  let persisted: PersistedNativeChatSessionOptions | undefined
  for (const mutation of mutations) {
    persisted = applyNativeChatSessionOptionSettingsMutation(persisted, mutation) ?? persisted
  }
  return resolveStructuredLaunchSeedOptions(persisted, 'codex')
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}
