import type {
  StructuredAgentSessionCreateSend,
  StructuredAgentSessionReservedSend
} from '@/components/native-chat/structured-agent-session-message-sender'

export type StructuredPromptDeliveryResult = {
  delivered: boolean
  failureNotified: boolean
  /** Not sent, and waiting in the new chat's composer, which now owns the text. */
  inComposer?: true
  /** Nobody could confirm it went: the host may hold it. */
  unconfirmed?: true
  /** Another send of the chat held its one slot, so this one never went. */
  busy?: true
}

export type StagedDelivery = Omit<
  StructuredPromptDeliveryResult,
  'inComposer' | 'failureNotified'
> & {
  inComposer: boolean
  failureNotified?: boolean
}

export type StructuredLaunchPromptOptions = {
  prompt?: string
  promptDelivery?: 'auto-submit' | 'submit-after-ready' | 'draft'
  onPromptDelivered?: () => void
}

/** Share one staged-text send across launch callers; reserve the chat send slot at click so typed messages cannot overtake it before create. */
export type StagedStructuredLaunchPrompt = {
  sessionId: string
  text: string
  slot: StructuredAgentSessionReservedSend | null
  /** Its sender keeps the text if it comes back (notes), instead of the chat's composer. */
  callerKeepsText?: true
  delivery?: Promise<StagedDelivery>
  /** Create owns this prompt; it must never become a later send. */
  createOwned?: true
  createSend?: StructuredAgentSessionCreateSend
  whenCreateSettled: Promise<StagedDelivery>
  settleCreate: (outcome: StagedDelivery) => void
  /** Its launch was cancelled: never sent, never given back. */
  discarded?: true
  /** Settles once it is discarded, so its callers need not wait on a create that may never end. */
  whenDiscarded: Promise<void>
  discard: () => void
}
