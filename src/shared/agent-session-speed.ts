/** Requested next-turn speed, execution-host acceptance, and observed processing are distinct facts. */
export type AgentSessionSpeed = {
  requested?: { tierId: string } | { legacyFast: true }
  support: 'loading' | 'unknown' | 'available' | 'unavailable'
  applied?: { tierId: string; turnId: string | null }
  processing: { status: 'unknown' } | { status: 'reported'; tierId: string; turnId: string | null }
}
