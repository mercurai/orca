import {
  codexSpeedChoiceStatus,
  type CodexSpeedCaptionKey,
  type CodexSpeedHostSupport
} from '../../../../shared/codex-service-tier-presentation'
import type { CodexSpeedLine } from '../../../../shared/codex-speed-facts-presentation'
import type {
  SessionOptionDescriptor,
  SessionOptionDisabledReason,
  SessionOptionSelectChoice
} from '../../../../shared/native-chat-session-options'
import { translate } from '@/i18n/i18n'

export function nativeChatSessionOptionLabel(descriptor: SessionOptionDescriptor): string {
  switch (descriptor.id) {
    case 'model':
      return translate('components.native-chat.composer.model', 'Model')
    case 'effort':
      return translate('components.native-chat.composer.effort', descriptor.label)
    case 'fastMode':
      return translate('components.native-chat.composer.fastMode', 'Fast mode')
    case 'serviceTier':
      return translate('components.native-chat.composer.serviceTier', 'Speed')
    case 'thinking':
      return translate('components.native-chat.composer.thinking', 'Thinking')
    default:
      return descriptor.label
  }
}

export function nativeChatSessionChoiceLabel(choice: SessionOptionSelectChoice): string {
  switch (choice.value) {
    case 'minimal':
      return translate('components.native-chat.composer.optionValue.minimal', 'Minimal')
    case 'low':
      return translate('components.native-chat.composer.optionValue.low', 'Low')
    case 'medium':
      return translate('components.native-chat.composer.optionValue.medium', 'Medium')
    case 'high':
      return translate('components.native-chat.composer.optionValue.high', 'High')
    case 'xhigh':
      return translate('components.native-chat.composer.optionValue.xhigh', 'Extra high')
    case 'max':
      return translate('components.native-chat.composer.optionValue.max', 'Max')
    case 'ultra':
      return translate('components.native-chat.composer.optionValue.ultra', 'Ultra')
    default:
      return choice.label
  }
}

/** A choice's second line. An unavailable speed row says why; an offered Fast or Ultrafast adds
 *  the usage cost to the provider's own words, with no guessed rate. */
export function nativeChatSessionChoiceDescription(
  descriptor: SessionOptionDescriptor,
  choice: SessionOptionSelectChoice
): string | undefined {
  switch (codexSpeedChoiceStatus(descriptor, choice)) {
    case 'unavailable':
      return translate(
        'components.native-chat.composer.speedUnavailable',
        'Not offered for this model.'
      )
    case 'unverified':
      return translate(
        'components.native-chat.composer.speedUnverified',
        'Cannot be confirmed for this model yet.'
      )
    case 'higher-usage': {
      const usage = translate(
        'components.native-chat.composer.speedHigherUsage',
        'Uses more of your usage allowance than Standard.'
      )
      return choice.description ? `${choice.description} ${usage}` : usage
    }
    case 'offered':
      return choice.description
  }
}

export function nativeChatSpeedCaption(key: CodexSpeedCaptionKey): string {
  switch (key) {
    case 'next-turn':
      return translate(
        'components.native-chat.composer.speedNextTurn',
        'Changes apply to the next turn, including while a turn is running.'
      )
    case 'not-chosen':
      return translate(
        'components.native-chat.composer.speedNotChosen',
        'No speed chosen. Codex uses its configured speed.'
      )
    case 'support-unverified':
      return translate(
        'components.native-chat.composer.speedSupportUnverified',
        "This model's speed options could not be confirmed."
      )
    case 'selection-blocked':
      return translate(
        'components.native-chat.composer.speedSelectionBlocked',
        'The selected speed cannot be sent for this model. Choose another.'
      )
  }
}

/** One claim about speed, worded as that claim and no stronger: a stored selection is intent for
 *  the next turn, a request is what was submitted or refused, processing is what the server said. */
export function nativeChatSpeedLine(line: CodexSpeedLine): string {
  switch (line.kind) {
    case 'pending':
      return translate(
        'components.native-chat.composer.speedPending',
        'Requested {{value0}}, waiting for the host to confirm.',
        { value0: line.label }
      )
    case 'stored':
      return translate(
        'components.native-chat.composer.speedStored',
        'Stored for the next turn: {{value0}}.',
        { value0: line.label }
      )
    case 'last-request':
      return nativeChatSpeedRequestLine(line)
    case 'processing':
      return line.label
        ? translate(
            'components.native-chat.composer.speedProcessingReported',
            'The server reported {{value0}} for the last turn.',
            { value0: line.label }
          )
        : translate(
            'components.native-chat.composer.speedProcessingUnknown',
            'The speed the server used is not reported.'
          )
  }
}

function nativeChatSpeedRequestLine(
  line: Extract<CodexSpeedLine, { kind: 'last-request' }>
): string {
  switch (line.outcome) {
    case 'sent':
      return translate(
        'components.native-chat.composer.speedRequestSent',
        'Last turn requested {{value0}}; not yet accepted.',
        { value0: line.label }
      )
    case 'accepted':
      return translate(
        'components.native-chat.composer.speedRequestAccepted',
        'Last turn requested {{value0}}; accepted.',
        { value0: line.label }
      )
    case 'rejected':
      return line.detail
        ? translate(
            'components.native-chat.composer.speedRequestRefusedDetail',
            'Last request for {{value0}} was refused: {{value1}}',
            { value0: line.label, value1: line.detail }
          )
        : translate(
            'components.native-chat.composer.speedRequestRefused',
            'Last request for {{value0}} was refused.',
            { value0: line.label }
          )
  }
}

/** Why a canonical speed tier was refused before any write: an older host drops it, and an
 *  unanswered host cannot yet be told apart from one. The Fast toggle stays as it was. */
export function nativeChatSpeedHostRefusalText(support: CodexSpeedHostSupport): string {
  return support === 'unsupported'
    ? translate(
        'components.native-chat.composer.speedHostUpdate',
        'This host needs an update before it can store a speed choice. Update it and try again.'
      )
    : translate(
        'components.native-chat.composer.speedHostUnconfirmed',
        'Orca could not confirm this host supports speed choices. Try again in a moment.'
      )
}

export function nativeChatSessionOptionDisabledReason(
  reason: SessionOptionDisabledReason | undefined
): string | null {
  // Exhaustive over SessionOptionDisabledReason: a new key is a compile error
  // here, so the localized label can never silently drift from the producer.
  switch (reason) {
    case 'set-when-session-starts':
      return translate(
        'components.native-chat.composer.setWhenSessionStarts',
        'Set when the session starts.'
      )
    case 'available-after-session-start':
      return translate(
        'components.native-chat.composer.availableAfterSessionStarts',
        'Available after the session starts.'
      )
    case undefined:
      return null
  }
}

export function nativeChatModelPillLabel(descriptor: SessionOptionDescriptor): string {
  // Why: show the value only (Codex/Conductor style). "Model:" is redundant —
  // the control's aria-label/tooltip already names the category.
  // Only `unknown` withholds the value; a `default` source still names the model
  // the launch will use, so it renders like any observed one.
  if (
    descriptor.valueSource === 'unknown' ||
    descriptor.kind.type !== 'select' ||
    !descriptor.kind.currentValue
  ) {
    return translate('components.native-chat.composer.model', 'Model')
  }
  return nativeChatSessionChoiceLabel(
    descriptor.kind.choices.find((choice) => choice.value === descriptor.kind.currentValue) ?? {
      value: descriptor.kind.currentValue,
      label: descriptor.kind.currentValue
    }
  )
}

export function nativeChatOptionsPillTitle(
  descriptors: readonly SessionOptionDescriptor[]
): string {
  const effort = descriptors.find((descriptor) => descriptor.id === 'effort')
  // Why: an effort-backed group is primarily the effort picker, even when it also reports modes.
  return effort
    ? nativeChatSessionOptionLabel(effort)
    : translate('components.native-chat.composer.sessionOptions', 'Session options')
}

export function nativeChatOptionsPillLabel(
  descriptors: readonly SessionOptionDescriptor[]
): string {
  const effort = descriptors.find((descriptor) => descriptor.id === 'effort')
  const labels: string[] = []
  for (const descriptor of descriptors) {
    if (descriptor.valueSource === 'unknown') {
      continue
    }
    if (descriptor.kind.type === 'select' && descriptor.kind.currentValue) {
      const choice = descriptor.kind.choices.find(
        (candidate) => candidate.value === descriptor.kind.currentValue
      )
      labels.push(
        nativeChatSessionChoiceLabel(
          choice ?? {
            value: descriptor.kind.currentValue,
            label: descriptor.kind.currentValue
          }
        )
      )
    } else if (descriptor.kind.type === 'boolean' && descriptor.kind.currentValue === true) {
      labels.push(
        descriptor.id === 'fastMode'
          ? translate('components.native-chat.composer.optionValue.fast', 'Fast')
          : nativeChatSessionOptionLabel(descriptor)
      )
    }
  }
  // Why: value-only pill (no "Effort:" prefix) — category lives on the tooltip.
  if (labels.length > 0) {
    return labels.join(' · ')
  }
  if (effort) {
    return nativeChatSessionOptionLabel(effort)
  }
  return translate('components.native-chat.composer.options', 'Options')
}
