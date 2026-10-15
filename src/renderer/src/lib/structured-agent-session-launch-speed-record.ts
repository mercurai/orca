import { parseStructuredLaunchSeedOptions } from '../../../shared/native-chat-session-option-defaults'
import {
  STRUCTURED_LAUNCH_SPEED_BLOCK_REASONS,
  type StructuredLaunchSpeedBlock
} from './structured-agent-session-launch-errors'

/** The speed bookkeeping of a launch whose chat exists: the created receipt's fence, what the host
 *  runs, the speed held but not yet accepted, and why it is blocked. Ids and reasons only: no prompt,
 *  no host answer. */
export type StructuredAgentLaunchSpeedRecord = {
  fence: number
  /** The create seed and each accepted pick, kept apart from the settings a reload reads again and
   *  from the requested speed below. */
  accepted?: Readonly<Record<string, string>>
  heldTierId?: string
  heldFastMode?: string
  block?: Pick<StructuredLaunchSpeedBlock, 'tierId' | 'reason'>
}

/** Nothing for a launch with no chosen speed in play, so other launches keep their record shape. A
 *  Codex chat that runs a chosen speed (`acceptedSpeedRuns`) keeps its record until its last look
 *  admits it, so a reload in between still finds the chat and the speed it runs. */
export function structuredAgentLaunchSpeedRecord(
  receipt: { fence: number } | undefined,
  heldTierId: string | undefined,
  block: StructuredLaunchSpeedBlock | undefined,
  selection: {
    accepted?: Readonly<Record<string, string>> | undefined
    heldFastMode?: string | undefined
    acceptedSpeedRuns?: boolean
  } = {}
): StructuredAgentLaunchSpeedRecord | undefined {
  const { heldFastMode } = selection
  // Only the seedable ids survive, so what the host echoed beyond them is never kept.
  const accepted = parseStructuredLaunchSeedOptions(selection.accepted)
  const runsSpeed =
    selection.acceptedSpeedRuns === true &&
    (accepted?.serviceTier !== undefined || accepted?.fastMode !== undefined)
  if (
    !receipt ||
    (heldTierId === undefined && heldFastMode === undefined && !block && !runsSpeed)
  ) {
    return undefined
  }
  return {
    fence: receipt.fence,
    ...(accepted ? { accepted } : {}),
    ...(heldTierId === undefined ? {} : { heldTierId }),
    ...(heldFastMode === undefined ? {} : { heldFastMode }),
    ...(block ? { block: { tierId: block.tierId, reason: block.reason } } : {})
  }
}

// A speed value is stored as the seed's own bounded string, so it decodes the way a seed does.
function storedSeedValue(id: 'serviceTier' | 'fastMode', value: unknown): string | undefined {
  return parseStructuredLaunchSeedOptions({ [id]: value })?.[id]
}

function parseSpeedBlock(value: unknown): StructuredAgentLaunchSpeedRecord['block'] {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const fields = new Map<string, unknown>(Object.entries(value))
  const tierId = storedSeedValue('serviceTier', fields.get('tierId'))
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
  const accepted = parseStructuredLaunchSeedOptions(fields.get('accepted'))
  const heldTierId = storedSeedValue('serviceTier', fields.get('heldTierId'))
  // One requested speed: a canonical tier outranks a legacy Fast value stored beside it.
  const heldFastMode =
    heldTierId === undefined ? storedSeedValue('fastMode', fields.get('heldFastMode')) : undefined
  const block = parseSpeedBlock(fields.get('block'))
  return {
    fence,
    ...(accepted ? { accepted } : {}),
    ...(heldTierId === undefined ? {} : { heldTierId }),
    ...(heldFastMode === undefined ? {} : { heldFastMode }),
    ...(block ? { block } : {})
  }
}
