import { afterEach, describe, expect, it, vi } from 'vitest'
import { validRecord } from './structured-agent-session-launch-record'
import { MAX_PROMPT_BYTES } from '../../../shared/rpc-contract/structured-agent-session-params'

const record = {
  sessionId: 'codex_11111111_2222_3333_4444_555555555555',
  executionHostId: 'local',
  agent: 'codex',
  lifecycle: 'visibility-unknown',
  clientOperationId: 'create-operation',
  payloadFingerprint: 'a'.repeat(64),
  expectedRuntimeFence: null,
  createMessageSupport: true,
  firstMessage: {
    clientMessageId: 'opening-message',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'opening π text' }] }
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('a persisted create opening message', () => {
  it('loads the frozen user message in a browser without Node Buffer', () => {
    vi.stubGlobal('Buffer', undefined)
    expect(() => validRecord(record)).not.toThrow()
    expect(validRecord(record)).toBe(true)
  })

  it.each([
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'forged response' }] },
    { kind: 'message', role: 'user', blocks: [{ type: 'tool-call', name: 'forged tool' }] },
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 5 }] }
  ])('refuses a saved opening body that cannot be sent through the user-message wire', (body) => {
    expect(validRecord({ ...record, firstMessage: { ...record.firstMessage, body } })).toBe(false)
  })
})

describe('persisted speed authorization', () => {
  it.each([
    { createCanonicalOptions: { serviceTier: 42 } },
    { createSpeedAuthority: { expectedEnvironmentRuntimeId: 42 } },
    { createSpeedAuthority: { expectedEnvironmentPairingRevision: 'different-host' } }
  ])('refuses malformed canonical choices or host bindings', (fields) => {
    expect(validRecord({ ...record, ...fields })).toBe(false)
  })

  it.each([
    { heldOptions: { serviceTier: 42 } },
    { heldOptions: { model: 'model-held', serviceTier: '' } },
    { heldOptions: { model: 'model-held', serviceTier: 'x'.repeat(513) } },
    { heldOptions: ['model-held', 'tier-held'] }
  ])('refuses malformed held speed recovery options', ({ heldOptions }) => {
    expect(validRecord({ ...record, heldOptions })).toBe(false)
  })

  it('accepts bounded optional held prompt drafts without changing older records', () => {
    expect(validRecord(record)).toBe(true)
    expect(validRecord({
      ...record,
      heldPromptDrafts: [{ clientMessageId: 'legacy-held-message', text: 'unsent legacy prompt' }]
    })).toBe(true)
  })

  it.each([
    { heldPromptDrafts: { clientMessageId: 'legacy-held-message', text: 'not-an-array' } },
    { heldPromptDrafts: [{ clientMessageId: '', text: 'unsent legacy prompt' }] },
    { heldPromptDrafts: [{ clientMessageId: 'legacy-held-message', text: 42 }] },
    { heldPromptDrafts: [{ clientMessageId: 'x'.repeat(513), text: 'unsent legacy prompt' }] },
    { heldPromptDrafts: [{ clientMessageId: 'legacy-held-message', text: 'x'.repeat(MAX_PROMPT_BYTES + 1) }] }
  ])('refuses malformed held prompt recovery records', ({ heldPromptDrafts }) => {
    expect(validRecord({ ...record, heldPromptDrafts })).toBe(false)
  })
})
