export type AgentSessionSpeedSelectionState = 'unselected' | 'ready' | 'unknown' | 'unavailable'

export type AgentSessionSpeedRequestState = 'sent' | 'accepted' | 'rejected'

/** Next-turn speed selection and the evidence behind it. Absent on older hosts and other
 *  providers; each part is a separate claim and none is inferred from another. */
export type AgentSessionSpeedFacts = {
  /** What the host will request on the next turn. `legacyFastMode` is Fast intent no advertised tier resolves. */
  selection: { tierId?: string; legacyFastMode?: true; state: AgentSessionSpeedSelectionState }
  /** The newest request attempt. `sent` means the exact id was submitted; `rejected` a definite refusal. */
  lastRequest?: {
    clientMessageId: string
    tierId: string
    turnId?: string
    state: AgentSessionSpeedRequestState
    detail?: string
  }
  /** Settings the host serialized for an accepted request; not proof of the tier the server processed. */
  applied?: { clientMessageId: string; tierId: string; turnId?: string }
  /** Present only when the server reported the tier of that turn. */
  processing?: { turnId: string; tierId: string }
}
