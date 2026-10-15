// Mobile port of desktop's pill labeling
// (src/renderer/src/components/native-chat/native-chat-session-option-labels.ts),
// minus i18n — mobile renders plain strings throughout.

import {
  codexSpeedChoiceStatus,
  codexSpeedDescriptorCaptions,
  type CodexSpeedCaptionKey
} from '../../../src/shared/codex-service-tier-presentation'
import type { CodexSpeedLine } from '../../../src/shared/codex-speed-facts-presentation'
import type {
  SessionOptionDescriptor,
  SessionOptionDisabledReason,
  SessionOptionSelectChoice
} from '../../../src/shared/native-chat-session-options'

export function mobileSessionOptionDisabledReason(
  reason: SessionOptionDisabledReason | undefined
): string | null {
  // Exhaustive over SessionOptionDisabledReason so new keys are a compile error.
  switch (reason) {
    case 'set-when-session-starts':
      return 'Set when the session starts.'
    case 'available-after-session-start':
      return 'Available after the session starts.'
    case undefined:
      return null
  }
}

/** A choice's second line: why an unavailable speed row cannot be picked, and the usage cost of an
 *  offered Fast or Ultrafast, with no guessed rate. Every other choice keeps the provider's words. */
export function mobileSessionChoiceDescription(
  descriptor: SessionOptionDescriptor,
  choice: SessionOptionSelectChoice
): string | undefined {
  switch (codexSpeedChoiceStatus(descriptor, choice)) {
    case 'unavailable':
      return 'Not offered for this model.'
    case 'unverified':
      return 'Cannot be confirmed for this model yet.'
    case 'higher-usage': {
      const usage = 'Uses more of your usage allowance than Standard.'
      return choice.description ? `${choice.description} ${usage}` : usage
    }
    case 'offered':
      return choice.description
  }
}

const SPEED_CAPTIONS: Record<CodexSpeedCaptionKey, string> = {
  'next-turn': 'Changes apply to the next turn, including while a turn is running.',
  'not-chosen': 'No speed chosen. Codex uses its configured speed.',
  'support-unverified': "This model's speed options could not be confirmed.",
  'selection-blocked': 'The selected speed cannot be sent for this model. Choose another.'
}

/** The speed select's captions, from its descriptor alone; empty for every other option. */
export function mobileSpeedCaptions(descriptor: SessionOptionDescriptor): string[] {
  return codexSpeedDescriptorCaptions(descriptor).map((key) => SPEED_CAPTIONS[key])
}

/** Why a send or queue action did nothing: a speed the host has not accepted would go at the
 *  prior speed, so every send stays out until one is chosen and accepted. */
export const MOBILE_SPEED_SEND_BLOCKED_TEXT =
  'Your speed choice has not been accepted by the host yet. Choose a speed, then send again.'

function mobileSpeedRequestLine(line: Extract<CodexSpeedLine, { kind: 'last-request' }>): string {
  switch (line.outcome) {
    case 'sent':
      return `Last turn requested ${line.label}; not yet accepted.`
    case 'accepted':
      return `Last turn requested ${line.label}; accepted.`
    case 'rejected':
      return line.detail
        ? `Last request for ${line.label} was refused: ${line.detail}`
        : `Last request for ${line.label} was refused.`
  }
}

/** One claim about speed, worded as that claim and no stronger (the desktop picker's words). */
export function mobileSpeedLine(line: CodexSpeedLine): string {
  switch (line.kind) {
    case 'loading':
      return 'Loading speed options.'
    case 'support-unverified':
      return 'Speed options could not be confirmed. Orca will retry when the host is available.'
    case 'pending':
      return `Requested ${line.label}, waiting for the host to confirm.`
    case 'stored':
      return `Stored for the next turn: ${line.label}.`
    case 'requested':
      return line.state === 'unavailable'
        ? `Requested ${line.label} is not available for this model. Sends are held until you choose another speed.`
        : `Requested ${line.label} could not be confirmed for this model. Sends are held until you choose another speed.`
    case 'last-request':
      return mobileSpeedRequestLine(line)
    case 'processing':
      return line.label
        ? `The server reported ${line.label} for the last turn.`
        : 'The speed the server used is not reported.'
  }
}

function selectedChoiceLabel(descriptor: SessionOptionDescriptor): string | null {
  if (
    descriptor.valueSource === 'unknown' ||
    descriptor.kind.type !== 'select' ||
    !descriptor.kind.currentValue
  ) {
    return null
  }
  const current = descriptor.kind.currentValue
  const choice: SessionOptionSelectChoice = descriptor.kind.choices.find(
    (candidate) => candidate.value === current
  ) ?? { value: current, label: current }
  return choice.label
}

/** Value-only pill text — the category lives on the sheet title, not the pill. */
export function mobileModelPillLabel(descriptor: SessionOptionDescriptor): string {
  return selectedChoiceLabel(descriptor) ?? 'Model'
}

export function mobileSessionOptionSummaryValue(descriptor: SessionOptionDescriptor): string {
  // A boolean always has a value, so the summary states it and lets the sheet's
  // marker say whether anything confirmed it. Reading "Not set" here while the
  // sheet showed the switch on made the two screens disagree.
  if (descriptor.kind.type === 'boolean') {
    return descriptor.kind.currentValue ? 'On' : 'Off'
  }
  if (descriptor.valueSource === 'unknown') {
    return 'Not set'
  }
  return selectedChoiceLabel(descriptor) ?? 'Not set'
}

export function mobileOptionsPillLabel(descriptors: readonly SessionOptionDescriptor[]): string {
  const labels: string[] = []
  for (const descriptor of descriptors) {
    if (descriptor.valueSource === 'unknown') {
      continue
    }
    if (descriptor.kind.type === 'select') {
      const label = selectedChoiceLabel(descriptor)
      if (label) {
        labels.push(label)
      }
    } else if (descriptor.kind.currentValue === true) {
      labels.push(descriptor.id === 'fastMode' ? 'Fast' : descriptor.label)
    }
  }
  if (labels.length > 0) {
    return labels.join(' · ')
  }
  const effort = descriptors.find((descriptor) => descriptor.id === 'effort')
  return effort ? effort.label : 'Options'
}
