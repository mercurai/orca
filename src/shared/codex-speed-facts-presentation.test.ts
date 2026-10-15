import { describe, expect, it } from 'vitest'
import type { AgentSessionSpeedFacts } from './agent-session-speed-facts'
import {
  codexSpeedLines,
  codexSpeedLinesOfSurface,
  type CodexSpeedLine,
  type SpeedAwareSessionOptionsSurface
} from './codex-speed-facts-presentation'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface,
  SessionOptionValueSource
} from './native-chat-session-options'

const FAST = 'synthetic-fast-lane'

function speedDescriptor(
  valueSource: SessionOptionValueSource,
  currentValue: string | undefined = FAST
): SessionOptionDescriptor {
  return {
    id: 'serviceTier',
    label: 'Speed',
    category: 'mode',
    kind: {
      type: 'select',
      ...(currentValue === undefined ? {} : { currentValue }),
      choices: [
        { value: 'default', label: 'Standard' },
        { value: FAST, label: 'Fast' }
      ]
    },
    valueSource,
    transport: 'agent-session',
    settable: true
  }
}

describe('codexSpeedLines', () => {
  it('says nothing for an option that is not the speed select', () => {
    expect(codexSpeedLines(undefined, undefined)).toEqual([])
    const other: SessionOptionDescriptor = { ...speedDescriptor('reported'), id: 'effort' }
    expect(codexSpeedLines(other, undefined)).toEqual([])
  })

  it('separates a pick the host has not confirmed from the selection it stored', () => {
    expect(codexSpeedLines(speedDescriptor('dispatched'), undefined)[0]).toEqual({
      kind: 'pending',
      label: 'Fast'
    })
    expect(codexSpeedLines(speedDescriptor('reported'), undefined)[0]).toEqual({
      kind: 'stored',
      label: 'Fast'
    })
  })

  it('names no selection when nothing was chosen', () => {
    const lines = codexSpeedLines(speedDescriptor('unknown', undefined), undefined)

    expect(lines.map((line) => line.kind)).toEqual(['processing'])
  })

  it('reports processing as unknown unless the server reported the turn tier', () => {
    const accepted: AgentSessionSpeedFacts = {
      selection: { tierId: FAST, state: 'ready' },
      lastRequest: { clientMessageId: 'm1', tierId: FAST, turnId: 't1', state: 'accepted' },
      applied: { clientMessageId: 'm1', tierId: FAST, turnId: 't1' }
    }

    // An accepted request and its applied settings are not proof of what the server ran.
    expect(codexSpeedLines(speedDescriptor('reported'), accepted)).toEqual([
      { kind: 'stored', label: 'Fast' },
      { kind: 'last-request', outcome: 'accepted', label: 'Fast' },
      { kind: 'processing' }
    ])

    const processed: AgentSessionSpeedFacts = {
      ...accepted,
      processing: { turnId: 't1', tierId: 'default' }
    }
    expect(codexSpeedLines(speedDescriptor('reported'), processed).at(-1)).toEqual({
      kind: 'processing',
      label: 'Standard'
    })
  })

  it('keeps a refusal separate from the stored selection and bounds its detail', () => {
    const refused: AgentSessionSpeedFacts = {
      selection: { tierId: FAST, state: 'ready' },
      lastRequest: {
        clientMessageId: 'm2',
        tierId: FAST,
        state: 'rejected',
        detail: 'x'.repeat(500)
      }
    }

    const lines = codexSpeedLines(speedDescriptor('reported'), refused)

    expect(lines[0]).toEqual({ kind: 'stored', label: 'Fast' })
    const request = lines.find((line) => line.kind === 'last-request')
    expect(request).toMatchObject({ outcome: 'rejected', label: 'Fast' })
    expect(request?.kind === 'last-request' ? request.detail?.length : 0).toBe(200)
  })

  it('shows an unrecognized requested tier by its id', () => {
    const facts: AgentSessionSpeedFacts = {
      selection: { state: 'unknown' },
      lastRequest: { clientMessageId: 'm3', tierId: 'retired-lane', state: 'sent' }
    }

    expect(codexSpeedLines(speedDescriptor('unknown', undefined), facts)[0]).toEqual({
      kind: 'last-request',
      outcome: 'sent',
      label: 'retired-lane'
    })
  })
})

// A client that restarted holds no pick of its own: the host's facts alone say the requested tier
// is not sendable, while current.serviceTier is still the last accepted one.
describe('codexSpeedLines requested tier the host cannot send', () => {
  const CUSTOM = { value: 'synthetic-custom-lane', label: 'Custom lane' }
  const naming = (lines: readonly CodexSpeedLine[], text: string) =>
    lines.filter((line) => JSON.stringify(line).includes(text))

  it.each(['unavailable', 'unknown'] as const)(
    'names a %s requested tier on its own line, apart from the stored selection',
    (state) => {
      const facts: AgentSessionSpeedFacts = { selection: { tierId: CUSTOM.value, state } }

      const lines = codexSpeedLines(speedDescriptor('reported'), facts)

      expect(lines[0]).toEqual({ kind: 'stored', label: 'Fast' })
      const requested = naming(lines, CUSTOM.value)
      expect(requested).toHaveLength(1)
      expect(requested[0]?.kind).not.toBe('stored')
    }
  )

  it('keeps naming it once a refreshed catalog offers the tier', () => {
    const refreshed: SessionOptionDescriptor = {
      ...speedDescriptor('reported'),
      kind: {
        type: 'select',
        currentValue: FAST,
        choices: [
          { value: 'default', label: 'Standard' },
          { value: FAST, label: 'Fast' },
          { value: CUSTOM.value, label: CUSTOM.label }
        ]
      }
    }
    const facts: AgentSessionSpeedFacts = {
      selection: { tierId: CUSTOM.value, state: 'unavailable' }
    }

    const lines = codexSpeedLines(refreshed, facts)

    expect(lines[0]).toEqual({ kind: 'stored', label: 'Fast' })
    const requested = lines.filter(
      (line) =>
        JSON.stringify(line).includes(CUSTOM.label) || JSON.stringify(line).includes(CUSTOM.value)
    )
    expect(requested).toHaveLength(1)
    expect(requested[0]?.kind).not.toBe('stored')
  })
})

describe('codexSpeedLinesOfSurface', () => {
  const plain: SessionOptionsSurface = {
    getSnapshot: () => [],
    setOption: async () => ({ snapshot: [] }),
    invokeAction: async () => ({ snapshot: [] }),
    subscribe: () => () => {}
  }

  it('reads nothing from a surface that reports no speed', () => {
    expect(codexSpeedLinesOfSurface(plain)).toEqual([])
    expect(codexSpeedLinesOfSurface(null)).toEqual([])
  })

  it('reads the lines a speed-aware surface reports', () => {
    const aware: SpeedAwareSessionOptionsSurface = {
      ...plain,
      getSpeedLines: () => [{ kind: 'processing' }]
    }

    expect(codexSpeedLinesOfSurface(aware)).toEqual([{ kind: 'processing' }])
  })
})
