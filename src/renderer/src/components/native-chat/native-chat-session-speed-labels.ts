import type { AgentSessionSpeed } from '../../../../shared/agent-session-speed'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import { translate } from '@/i18n/i18n'
import { nativeChatSessionChoiceLabel } from './native-chat-session-option-labels'

function tierLabel(descriptor: SessionOptionDescriptor, tierId: string): string {
  const choice =
    descriptor.kind.type === 'select'
      ? descriptor.kind.choices.find((candidate) => candidate.value === tierId)
      : undefined
  return nativeChatSessionChoiceLabel(choice ?? { value: tierId, label: tierId }, 'serviceTier')
}

function supportLabel(support: AgentSessionSpeed['support']): string {
  switch (support) {
    case 'loading':
      return translate(
        'components.native-chat.composer.speedStatus.loading',
        'Checking speed support…'
      )
    case 'unknown':
      return translate(
        'components.native-chat.composer.speedStatus.unknown',
        'Speed support unknown. Refresh the catalog or choose Standard.'
      )
    case 'unavailable':
      return translate(
        'components.native-chat.composer.speedStatus.unavailable',
        'Selected speed is unavailable. Refresh the catalog or choose Standard.'
      )
    case 'available':
      return translate(
        'components.native-chat.composer.speedStatus.available',
        'Speed available for the next turn.'
      )
  }
}

/** A requested tier is next-turn intent, never proof of the running turn's processing. */
export function nativeChatSessionSpeedLabels(descriptor: SessionOptionDescriptor): {
  nextTurn: string
  support: string
  applied?: string
  processing: string
} | null {
  if (descriptor.id !== 'serviceTier' || !descriptor.speed) {
    return null
  }
  const { requested, applied, processing, support } = descriptor.speed
  const requestedLabel = requested
    ? 'tierId' in requested
      ? tierLabel(descriptor, requested.tierId)
      : translate(
          'components.native-chat.composer.speedStatus.pendingFast',
          'Fast (awaiting catalog)'
        )
    : translate('components.native-chat.composer.speedStatus.providerDefault', 'Provider default')
  return {
    nextTurn: translate(
      'components.native-chat.composer.speedStatus.nextTurn',
      'Next turn: {{speed}}',
      {
        speed: requestedLabel
      }
    ),
    support: supportLabel(support),
    ...(applied
      ? {
          applied: translate(
            'components.native-chat.composer.speedStatus.applied',
            'Last host-applied speed: {{speed}}',
            { speed: tierLabel(descriptor, applied.tierId) }
          )
        }
      : {}),
    processing:
      processing.status === 'reported'
        ? translate(
            'components.native-chat.composer.speedStatus.processingReported',
            'Actual processing: {{speed}}',
            { speed: tierLabel(descriptor, processing.tierId) }
          )
        : translate(
            'components.native-chat.composer.speedStatus.processingUnknown',
            'Actual processing: unknown'
          )
  }
}
