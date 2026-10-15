export type StructuredAgentSessionSetOptionInput = {
  sessionId: string
  key: string
  value: string
  fence: number
  /** Aborted by a close, a Stop admitted now, or quit, which must not wait behind a pick the
   *  provider never answers: the write fails. An adapter that bounds its own write may ignore it. */
  signal?: AbortSignal
  /** A copy of the record's options as this write began, so an adapter that holds only some of them
   *  can settle a complete map. */
  priorOptions?: Readonly<Record<string, string>>
}

/** The write the host could not persist, with the record as it stood before it. */
export type StructuredAgentSessionRecoverOptionInput = {
  sessionId: string
  fence: number
  key: string
  value: string
  priorOptions: Readonly<Record<string, string>>
}
