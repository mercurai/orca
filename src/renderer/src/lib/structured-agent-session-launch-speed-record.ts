import { parseStructuredLaunchSeedOptions } from '../../../shared/native-chat-session-option-defaults'
import {
  STRUCTURED_LAUNCH_SPEED_BLOCK_REASONS,
  type StructuredLaunchSpeedBlock
} from './structured-agent-session-launch-errors'

/** The speed bookkeeping of a launch whose chat exists: the created receipt's fence, the tier held
 *  but not yet accepted, and why it is blocked. Ids and reasons only: no prompt, no host answer. */
export type StructuredAgentLaunchSpeedRecord = {
  fence: number
  heldTierId?: string
  block?: Pick<StructuredLaunchSpeedBlock, 'tierId' | 'reason'>
}

/** Nothing for a launch with no chosen speed in play, so other launches keep their record shape. */
export function structuredAgentLaunchSpeedRecord(
  receipt: { fence: number } | undefined,
  heldTierId: string | undefined,
  block: StructuredLaunchSpeedBlock | undefined
): StructuredAgentLaunchSpeedRecord | undefined {
  if (!receipt || (heldTierId === undefined && !block)) {
    return undefined
  }
  return {
    fence: receipt.fence,
    ...(heldTierId === undefined ? {} : { heldTierId }),
    ...(block ? { block: { tierId: block.tierId, reason: block.reason } } : {})
  }
}

// A tier id is stored as the seed's own bounded string, so it decodes the way a seed does.
function storedTierId(value: unknown): string | undefined {
  return parseStructuredLaunchSeedOptions({ serviceTier: value })?.serviceTier
}

function parseSpeedBlock(value: unknown): StructuredAgentLaunchSpeedRecord['block'] {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const fields = new Map<string, unknown>(Object.entries(value))
  const tierId = storedTierId(fields.get('tierId'))
  const reason = STRUCTURED_LAUNCH_SPEED_BLOCK_REASONS.find((r) => r === fields.get('reason'))
  return tierId !== undefined && reason !== undefined ? { tierId, reason } : undefined
}

/** A stored speed record, or undefined when it is not one this build wrote. */
export function parseStructuredAgentLaunchSpeedRecord(
  value: unknown
): StructuredAgentLaunchSpeedRecord | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const fields = new Map<string, unknown>(Object.entries(value))
  const fence = fields.get('fence')
  if (typeof fence !== 'number' || !Number.isFinite(fence)) {
    return undefined
  }
  const heldTierId = storedTierId(fields.get('heldTierId'))
  const block = parseSpeedBlock(fields.get('block'))
  return {
    fence,
    ...(heldTierId === undefined ? {} : { heldTierId }),
    ...(block ? { block } : {})
  }
}
