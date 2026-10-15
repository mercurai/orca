import { describe, expect, it } from 'vitest'
import {
  CLAUDE_SESSION_OPTION_CATALOG,
  CODEX_SESSION_OPTION_CATALOG
} from './agent-session-option-catalog-claude-codex'
import type { AgentSessionSpeedFacts } from './agent-session-speed-facts'
import type {
  AgentSessionModelCatalogResult,
  AgentSessionModelOption,
  AgentSessionOptionsResult
} from './agent-session-wire'
import {
  codexSpeedChoiceStatus,
  codexSpeedDescriptorCaptions,
  type CodexSpeedHostSupport
} from './codex-service-tier-presentation'
import { codexSpeedLines, type CodexSpeedLine } from './codex-speed-facts-presentation'
import type {
  SessionOptionDescriptor,
  SessionOptionSelectChoice
} from './native-chat-session-options'
import {
  requestStructuredAgentSessionSpeed,
  structuredAgentSessionSpeedBlocked
} from './structured-agent-session-option-acknowledgement'
import { structuredAgentSessionOptionView } from './structured-agent-session-option-view'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  canSetStructuredAgentSessionOption,
  commitStructuredAgentSessionOption,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot,
  type StructuredAgentSessionOptionState
} from './structured-agent-session-options'

// Frozen client-only contract this file locks. The phase argument and state fields do not exist yet,
// so they travel as plain data through the existing functions, which must keep ignoring them until
// the presentation reads them.
type Phase = 'pending' | 'failed' | 'settled'
type SpeedPhases = { capabilityPhase?: Phase; optionsPhase?: Phase; catalogPhase?: Phase }
type PhaseSource = keyof SpeedPhases
type PhasedState = StructuredAgentSessionOptionState & SpeedPhases

const SOURCES: PhaseSource[] = ['capabilityPhase', 'optionsPhase', 'catalogPhase']
const EVIDENCE_KINDS: string[] = ['stored', 'requested', 'last-request', 'processing']

const DEFAULT_MODEL_ID = 'synthetic-default-model'
const HELD_MODEL_ID = 'synthetic-nondefault-model'
const STANDARD = { value: 'default', label: 'Standard', description: 'Normal speed.' }
const FAST = { value: 'synthetic-fast-lane', label: 'Fast', description: 'Quicker replies.' }
const ULTRA = { value: 'synthetic-opaque-ultra-lane', label: 'Ultrafast', description: 'Fastest.' }

type Tier = { value: string; label: string; description: string }

const READY_FAST: AgentSessionSpeedFacts = { selection: { tierId: FAST.value, state: 'ready' } }
const READY_ULTRA: AgentSessionSpeedFacts = { selection: { tierId: ULTRA.value, state: 'ready' } }
const REFUSED_ULTRA_FACTS: AgentSessionSpeedFacts = {
  selection: { tierId: ULTRA.value, state: 'unavailable' },
  lastRequest: { clientMessageId: 'm1', tierId: ULTRA.value, state: 'rejected', detail: 'refused' },
  processing: { turnId: 't1', tierId: FAST.value }
}

function modelOption(
  id: string,
  tiers: readonly Tier[] | undefined,
  extra: Partial<AgentSessionModelOption> = {}
): AgentSessionModelOption {
  return {
    id,
    label: id,
    isDefault: false,
    efforts: [],
    ...(tiers ? { serviceTiers: [...tiers] } : {}),
    ...extra
  }
}

function heldModels(tiers: readonly Tier[] = [STANDARD, FAST, ULTRA]): AgentSessionModelOption[] {
  return [
    modelOption(DEFAULT_MODEL_ID, [STANDARD, FAST], { isDefault: true }),
    modelOption(HELD_MODEL_ID, tiers, { supportsFastMode: true })
  ]
}

function liveState(
  args: {
    models?: AgentSessionModelOption[]
    current?: AgentSessionOptionsResult['current']
    host?: CodexSpeedHostSupport
    speed?: AgentSessionSpeedFacts
    agent?: 'codex' | 'claude'
  } = {}
): StructuredAgentSessionOptionState {
  const agent = args.agent ?? 'codex'
  const result: AgentSessionOptionsResult = {
    models: args.models ?? heldModels(),
    fastModeSupport: { supported: true },
    current: { model: HELD_MODEL_ID, ...args.current },
    ...(args.speed ? { speed: args.speed } : {})
  }
  return applyStructuredAgentSessionOptions(
    createStructuredAgentSessionOptionState(agent),
    agent === 'claude' ? CLAUDE_SESSION_OPTION_CATALOG : CODEX_SESSION_OPTION_CATALOG,
    result,
    args.host
  )
}

function listedState(
  models: AgentSessionModelOption[],
  host: CodexSpeedHostSupport
): StructuredAgentSessionOptionState {
  const catalog: AgentSessionModelCatalogResult = { origin: 'probe', models, fetchedAt: 1_000 }
  return applyStructuredAgentSessionModelCatalog(
    createStructuredAgentSessionOptionState('codex', CODEX_SESSION_OPTION_CATALOG),
    CODEX_SESSION_OPTION_CATALOG,
    catalog,
    { newLaunch: true, codexSpeedHost: host }
  )
}

function descriptorFor(
  state: StructuredAgentSessionOptionState,
  id: string
): SessionOptionDescriptor | undefined {
  return structuredAgentSessionOptionSnapshot(state).find((entry) => entry.id === id)
}

function idsOf(state: StructuredAgentSessionOptionState): string[] {
  return structuredAgentSessionOptionSnapshot(state).map((entry) => entry.id)
}

function choicesOf(descriptor: SessionOptionDescriptor | undefined): SessionOptionSelectChoice[] {
  return descriptor?.kind.type === 'select' ? descriptor.kind.choices : []
}

function currentOf(descriptor: SessionOptionDescriptor | undefined): string | undefined {
  return descriptor?.kind.type === 'select' ? descriptor.kind.currentValue : undefined
}

/** An advertised tier as the unresolved-host select keeps it: exact id and label, never pickable. */
function locked(...tiers: Tier[]): SessionOptionSelectChoice[] {
  return tiers.map(({ value, label, description }) => ({
    value,
    label,
    description,
    disabled: true
  }))
}

function only(source: PhaseSource, phase: Phase): SpeedPhases {
  const phases: SpeedPhases = {}
  phases[source] = phase
  return phases
}

/** The speed lines with the optional third argument of the frozen contract. The two-argument
 *  function is assignable to this callable type, so a red is a behavior failure, not a type error. */
const linesWithPhases: (
  descriptor: Parameters<typeof codexSpeedLines>[0],
  speed: Parameters<typeof codexSpeedLines>[1],
  phases?: Readonly<SpeedPhases>
) => CodexSpeedLine[] = codexSpeedLines

function linesWith(
  descriptor: SessionOptionDescriptor | undefined,
  speed: AgentSessionSpeedFacts | undefined,
  phases: SpeedPhases | undefined
): CodexSpeedLine[] {
  return linesWithPhases(descriptor, speed, phases)
}

/** What a phase adds to the lines the same descriptor and facts already produce. `missing` is any
 *  existing line the phase changed or dropped. */
function phaseExtras(
  descriptor: SessionOptionDescriptor | undefined,
  speed: AgentSessionSpeedFacts | undefined,
  phases: SpeedPhases | undefined
): { added: CodexSpeedLine[]; missing: string[] } {
  const remaining = codexSpeedLines(descriptor, speed).map((line) => JSON.stringify(line))
  const added: CodexSpeedLine[] = []
  for (const line of linesWith(descriptor, speed, phases)) {
    const at = remaining.indexOf(JSON.stringify(line))
    if (at >= 0) {
      remaining.splice(at, 1)
    } else {
      added.push(line)
    }
  }
  return { added, missing: remaining }
}

describe('Codex speed lines by probe phase', () => {
  const stored = () =>
    descriptorFor(
      liveState({ current: { serviceTier: FAST.value }, host: 'supported', speed: READY_FAST }),
      'serviceTier'
    )

  it.each(SOURCES)('adds exactly one loading line while only %s is pending', (source) => {
    const { added, missing } = phaseExtras(stored(), READY_FAST, only(source, 'pending'))

    expect(missing).toEqual([])
    expect(added).toHaveLength(1)
    expect(EVIDENCE_KINDS).not.toContain(added[0]?.kind)
  })

  it('shows one loading line, not one per source, when every source is pending', () => {
    const all: SpeedPhases = {
      capabilityPhase: 'pending',
      optionsPhase: 'pending',
      catalogPhase: 'pending'
    }
    const { added, missing } = phaseExtras(stored(), READY_FAST, all)

    expect(missing).toEqual([])
    expect(added).toHaveLength(1)
  })

  it.each<[string, SpeedPhases, PhaseSource]>([
    [
      'capability settles while options is pending',
      { capabilityPhase: 'settled', optionsPhase: 'pending' },
      'optionsPhase'
    ],
    [
      'catalog fails while capability is pending',
      { catalogPhase: 'failed', capabilityPhase: 'pending' },
      'capabilityPhase'
    ],
    [
      'capability settles and options fails while the listing is pending',
      { capabilityPhase: 'settled', optionsPhase: 'failed', catalogPhase: 'pending' },
      'catalogPhase'
    ]
  ])('keeps loading when %s', (_name, phases, pendingSource) => {
    const alone = phaseExtras(stored(), READY_FAST, only(pendingSource, 'pending'))
    const overlapped = phaseExtras(stored(), READY_FAST, phases)

    expect(alone.added).toHaveLength(1)
    expect(overlapped.missing).toEqual([])
    expect(overlapped.added).toEqual(alone.added)
  })

  it.each(SOURCES)('adds one unverified-support line, not loading, when %s failed', (source) => {
    const failed = phaseExtras(stored(), READY_FAST, only(source, 'failed'))
    const pending = phaseExtras(stored(), READY_FAST, only(source, 'pending'))

    expect(failed.missing).toEqual([])
    expect(failed.added).toHaveLength(1)
    expect(EVIDENCE_KINDS).not.toContain(failed.added[0]?.kind)
    expect(failed.added).not.toEqual(pending.added)
  })

  it('never reads as loading once every source has failed', () => {
    const failedAll: SpeedPhases = {
      capabilityPhase: 'failed',
      optionsPhase: 'failed',
      catalogPhase: 'failed'
    }
    const all = phaseExtras(stored(), READY_FAST, failedAll)

    expect(all.added).toHaveLength(1)
    expect(all.added).toEqual(
      phaseExtras(stored(), READY_FAST, only('optionsPhase', 'failed')).added
    )
    for (const source of SOURCES) {
      expect(all.added).not.toEqual(
        phaseExtras(stored(), READY_FAST, only(source, 'pending')).added
      )
    }
  })

  it.each<[string, SpeedPhases | undefined]>([
    ['no phases', undefined],
    ['an empty phase bag', {}],
    ['one settled source', { capabilityPhase: 'settled' }],
    [
      'every source settled',
      { capabilityPhase: 'settled', optionsPhase: 'settled', catalogPhase: 'settled' }
    ]
  ])('adds nothing for %s and matches the two-argument call', (_name, phases) => {
    const { added, missing } = phaseExtras(stored(), READY_FAST, phases)

    expect(added).toEqual([])
    expect(missing).toEqual([])
  })

  it.each<[string, SpeedPhases]>([
    ['pending', { capabilityPhase: 'pending', optionsPhase: 'pending' }],
    ['failed', { capabilityPhase: 'failed', catalogPhase: 'failed' }]
  ])('leaves the evidence lines as they were while %s', (_name, phases) => {
    const descriptor = stored()
    const base = codexSpeedLines(descriptor, REFUSED_ULTRA_FACTS)
    const { added, missing } = phaseExtras(descriptor, REFUSED_ULTRA_FACTS, phases)
    const phased = linesWith(descriptor, REFUSED_ULTRA_FACTS, phases)

    expect(base.map((line) => line.kind)).toEqual([
      'stored',
      'requested',
      'last-request',
      'processing'
    ])
    expect(missing).toEqual([])
    expect(added).toHaveLength(1)
    expect(phased.filter((line) => line.kind === 'processing')).toEqual([
      { kind: 'processing', label: FAST.label }
    ])
  })

  it('invents no tier, processing evidence or stored line for a pending read with no facts', () => {
    const descriptor = stored()
    const { added, missing } = phaseExtras(descriptor, undefined, { optionsPhase: 'pending' })
    const lines = linesWith(descriptor, undefined, { optionsPhase: 'pending' })

    expect(added).toHaveLength(1)
    expect(missing).toEqual([])
    expect(lines.filter((line) => line.kind === 'processing')).toEqual([{ kind: 'processing' }])
    expect(lines.filter((line) => line.kind === 'stored')).toHaveLength(1)
    expect(lines.filter((line) => line.kind === 'requested')).toEqual([])
  })
})

describe('Codex speed metadata unknown versus a completed listing missing a tier', () => {
  const unknownMetadata = () =>
    descriptorFor(
      liveState({
        models: [
          modelOption(DEFAULT_MODEL_ID, [STANDARD, FAST], { isDefault: true }),
          modelOption(HELD_MODEL_ID, undefined, { supportsFastMode: true })
        ],
        host: 'supported'
      }),
      'serviceTier'
    )
  const completedMissingUltra = () =>
    descriptorFor(
      liveState({
        models: heldModels([STANDARD, FAST]),
        current: { serviceTier: ULTRA.value },
        host: 'supported',
        speed: READY_ULTRA
      }),
      'serviceTier'
    )

  it('keeps the two rows apart: unverified when unreadable, unavailable when the listing lacks it', () => {
    const unknown = unknownMetadata()
    const completed = completedMissingUltra()
    const unverified = choicesOf(unknown).filter((choice) => choice.disabled === true)
    const unavailable = choicesOf(completed).filter(
      (choice) => choice.disabled === true && choice.label === 'Ultrafast'
    )

    expect(unverified.length).toBeGreaterThan(0)
    expect(unverified.every((row) => codexSpeedChoiceStatus(unknown!, row) === 'unverified')).toBe(
      true
    )
    expect(unavailable.length).toBeGreaterThan(0)
    expect(
      unavailable.every((row) => codexSpeedChoiceStatus(completed!, row) === 'unavailable')
    ).toBe(true)
    expect(codexSpeedDescriptorCaptions(completed!)).not.toContain('support-unverified')
  })

  it('adds no loading or unverified line to a listing that completed without the tier', () => {
    const settled: SpeedPhases = {
      capabilityPhase: 'settled',
      optionsPhase: 'settled',
      catalogPhase: 'settled'
    }
    const { added, missing } = phaseExtras(completedMissingUltra(), READY_ULTRA, settled)

    expect(added).toEqual([])
    expect(missing).toEqual([])
  })

  it('shows unverified support, still never admitted, when the listing read failed', () => {
    const descriptor = unknownMetadata()
    const failed = phaseExtras(descriptor, undefined, { catalogPhase: 'failed' })
    const pending = phaseExtras(descriptor, undefined, { catalogPhase: 'pending' })

    expect(failed.added).toHaveLength(1)
    expect(pending.added).toHaveLength(1)
    expect(failed.added).not.toEqual(pending.added)
    for (const row of choicesOf(descriptor).filter((choice) => choice.disabled === true)) {
      expect(codexSpeedChoiceStatus(descriptor!, row)).toBe('unverified')
    }
  })
})

describe('Codex speed select while the host capability is unresolved', () => {
  const unknownHost = () =>
    liveState({ current: { serviceTier: ULTRA.value }, host: 'unknown', speed: READY_ULTRA })

  it('keeps the host-stored opaque tier as a disabled row with its reported source', () => {
    const state = unknownHost()
    const tier = descriptorFor(state, 'serviceTier')

    expect(state.record.valuesByModel[HELD_MODEL_ID]?.serviceTier?.value).toBe(ULTRA.value)
    expect(tier).toMatchObject({
      kind: { type: 'select', currentValue: ULTRA.value },
      valueSource: 'reported'
    })
    expect(choicesOf(tier).find((choice) => choice.value === ULTRA.value)).toMatchObject({
      disabled: true
    })
  })

  it('never lets the retained tier, or any other tier, be set', () => {
    const state = unknownHost()
    const tier = descriptorFor(state, 'serviceTier')

    expect(tier).toBeDefined()
    for (const value of [ULTRA.value, FAST.value, STANDARD.value]) {
      expect(canSetStructuredAgentSessionOption(state, 'serviceTier', value)).toBe(false)
    }
    expect(choicesOf(tier).filter((choice) => choice.disabled !== true)).toEqual([])
  })

  it('keeps the stored line for the retained tier beside the processing unknown', () => {
    const state = unknownHost()
    const lines = codexSpeedLines(descriptorFor(state, 'serviceTier'), state.speed)

    expect(lines).toEqual([{ kind: 'stored', label: expect.any(String) }, { kind: 'processing' }])
  })

  it.each<
    [string, AgentSessionModelOption[], string, SessionOptionSelectChoice[], string]
  >([
    [
      'every advertised tier under its label and description, the stored one included',
      heldModels(),
      ULTRA.value,
      locked(STANDARD, FAST, ULTRA),
      'Ultrafast'
    ],
    [
      'an advertised Standard under its listed id and label',
      heldModels([STANDARD, FAST]),
      STANDARD.value,
      locked(STANDARD, FAST),
      'Standard'
    ],
    [
      'an id the model does not advertise as the exact id, after the advertised rows',
      heldModels([STANDARD, FAST]),
      ULTRA.value,
      [...locked(STANDARD, FAST), { value: ULTRA.value, label: ULTRA.value, disabled: true }],
      ULTRA.value
    ],
    [
      'the protocol default the model leaves unlisted as Standard beside other advertised tiers',
      heldModels([FAST]),
      STANDARD.value,
      [...locked(FAST), { value: STANDARD.value, label: 'Standard', disabled: true }],
      'Standard'
    ],
    [
      'the protocol default of a model with no tier metadata as Standard',
      [modelOption(HELD_MODEL_ID, undefined, { supportsFastMode: true })],
      STANDARD.value,
      [{ value: STANDARD.value, label: 'Standard', disabled: true }],
      'Standard'
    ]
  ])('keeps %s locked, with its stored provenance', (_name, models, tierId, rows, label) => {
    const state = liveState({
      models,
      current: { serviceTier: tierId },
      host: 'unknown',
      speed: { selection: { tierId, state: 'ready' } }
    })
    const tier = descriptorFor(state, 'serviceTier')
    const held = requestStructuredAgentSessionSpeed(state, 'serviceTier', tierId)

    expect(choicesOf(tier)).toEqual(rows)
    expect(tier).toMatchObject({ valueSource: 'reported', settable: false })
    expect(currentOf(tier)).toBe(tierId)
    for (const row of rows) {
      expect(canSetStructuredAgentSessionOption(state, 'serviceTier', row.value)).toBe(false)
    }
    expect(codexSpeedLines(tier, state.speed)[0]).toEqual({ kind: 'stored', label })
    expect(held.requested).toEqual({ id: 'serviceTier', value: tierId })
    expect(structuredAgentSessionOptionSnapshot(held)).toEqual(
      structuredAgentSessionOptionSnapshot(state)
    )
  })

  it.each<[string, AgentSessionSpeedFacts, CodexSpeedLine[]]>([
    [
      'a requested Ultrafast',
      { selection: { tierId: ULTRA.value, state: 'unavailable' } },
      [
        { kind: 'stored', label: 'Fast' },
        { kind: 'requested', label: 'Ultrafast', state: 'unavailable' },
        { kind: 'processing' }
      ]
    ],
    [
      'a last-requested Ultrafast',
      {
        selection: READY_FAST.selection,
        lastRequest: { clientMessageId: 'm1', tierId: ULTRA.value, state: 'accepted' }
      },
      [
        { kind: 'stored', label: 'Fast' },
        { kind: 'last-request', outcome: 'accepted', label: 'Ultrafast' },
        { kind: 'processing' }
      ]
    ],
    [
      'a processing Ultrafast',
      { selection: READY_FAST.selection, processing: { turnId: 't1', tierId: ULTRA.value } },
      [
        { kind: 'stored', label: 'Fast' },
        { kind: 'processing', label: 'Ultrafast' }
      ]
    ],
    [
      'a refused Ultrafast beside a processing Fast',
      REFUSED_ULTRA_FACTS,
      [
        { kind: 'stored', label: 'Fast' },
        { kind: 'requested', label: 'Ultrafast', state: 'unavailable' },
        { kind: 'last-request', outcome: 'rejected', label: 'Ultrafast', detail: 'refused' },
        { kind: 'processing', label: 'Fast' }
      ]
    ]
  ])('names %s by its advertised label while the stored tier is another', (_name, facts, lines) => {
    const state = liveState({
      current: { serviceTier: FAST.value },
      host: 'unknown',
      speed: READY_FAST
    })
    const tier = descriptorFor(state, 'serviceTier')

    expect(choicesOf(tier)).toEqual(locked(STANDARD, FAST, ULTRA))
    expect(tier).toMatchObject({ valueSource: 'reported', settable: false })
    expect(currentOf(tier)).toBe(FAST.value)
    for (const value of [STANDARD.value, FAST.value, ULTRA.value]) {
      expect(canSetStructuredAgentSessionOption(state, 'serviceTier', value)).toBe(false)
    }
    expect(codexSpeedLines(tier, facts)).toEqual(lines)
  })

  it('labels a held advertised pick while keeping it dispatched and locked', () => {
    const view = structuredAgentSessionOptionView(
      liveState({ host: 'unknown' }),
      { model: HELD_MODEL_ID },
      { serviceTier: ULTRA.value }
    )
    const tier = descriptorFor(view, 'serviceTier')

    expect(choicesOf(tier)).toEqual(locked(STANDARD, FAST, ULTRA))
    expect(tier).toMatchObject({ valueSource: 'dispatched', settable: false })
    expect(codexSpeedLines(tier, view.speed)[0]).toEqual({ kind: 'pending', label: 'Ultrafast' })
    expect(canSetStructuredAgentSessionOption(view, 'serviceTier', ULTRA.value)).toBe(false)
  })

  it('offers no selector when nothing canonical is tracked, however many tiers are advertised', () => {
    const state = liveState({ host: 'unknown' })

    expect(descriptorFor(state, 'serviceTier')).toBeUndefined()
    expect(canSetStructuredAgentSessionOption(state, 'serviceTier', FAST.value)).toBe(false)
  })

  it('keeps a held opaque pick visible as a dispatched disabled row', () => {
    const state = liveState({ host: 'unknown' })
    const view = structuredAgentSessionOptionView(
      state,
      { model: HELD_MODEL_ID },
      { serviceTier: ULTRA.value }
    )
    const tier = descriptorFor(view, 'serviceTier')

    expect(tier).toMatchObject({
      kind: { type: 'select', currentValue: ULTRA.value },
      valueSource: 'dispatched'
    })
    expect(choicesOf(tier).find((choice) => choice.value === ULTRA.value)).toMatchObject({
      disabled: true
    })
    expect(canSetStructuredAgentSessionOption(view, 'serviceTier', ULTRA.value)).toBe(false)
    expect(codexSpeedLines(tier, view.speed)[0]).toEqual({
      kind: 'pending',
      label: expect.any(String)
    })
  })

  it('keeps a held pick visible on a launch draft from a host listing', () => {
    const state = listedState(heldModels(), 'unknown')
    const view = structuredAgentSessionOptionView(
      state,
      { model: HELD_MODEL_ID },
      { serviceTier: ULTRA.value }
    )
    const tier = descriptorFor(view, 'serviceTier')

    expect(currentOf(tier)).toBe(ULTRA.value)
    expect(tier).toMatchObject({ valueSource: 'dispatched' })
    expect(choicesOf(tier).find((choice) => choice.value === ULTRA.value)).toMatchObject({
      disabled: true
    })
    expect(canSetStructuredAgentSessionOption(view, 'serviceTier', ULTRA.value)).toBe(false)
  })

  it('tells a pending read from settled unknown support without losing the tier', () => {
    const state = unknownHost()
    const tier = descriptorFor(state, 'serviceTier')
    const pending = linesWith(tier, state.speed, { capabilityPhase: 'pending' })
    const failed = linesWith(tier, state.speed, { capabilityPhase: 'failed' })
    const settled = linesWith(tier, state.speed, { capabilityPhase: 'settled' })

    expect(currentOf(tier)).toBe(ULTRA.value)
    expect(pending).toHaveLength(codexSpeedLines(tier, state.speed).length + 1)
    expect(failed).toHaveLength(pending.length)
    expect(failed).not.toEqual(pending)
    expect(settled).toEqual(codexSpeedLines(tier, state.speed))
    for (const lines of [pending, failed]) {
      expect(lines.filter((line) => line.kind === 'stored')).toHaveLength(1)
    }
  })
})

describe('Codex speed on a confirmed older host', () => {
  it('keeps the supported Fast control and replaces the held canonical pick explicitly', () => {
    const state = liveState({ current: { fastMode: false }, host: 'unsupported' })
    const view = structuredAgentSessionOptionView(
      state,
      { model: HELD_MODEL_ID },
      { serviceTier: ULTRA.value }
    )

    expect(idsOf(view)).toContain('fastMode')
    expect(canSetStructuredAgentSessionOption(view, 'fastMode', true)).toBe(true)
    expect(canSetStructuredAgentSessionOption(view, 'serviceTier', ULTRA.value)).toBe(false)

    const replaced = commitStructuredAgentSessionOption(view, 'fastMode', 'true')

    expect(descriptorFor(replaced, 'fastMode')).toMatchObject({
      kind: { type: 'boolean', currentValue: true },
      valueSource: 'dispatched'
    })
    expect(currentOf(descriptorFor(replaced, 'serviceTier'))).not.toBe(ULTRA.value)
    expect(canSetStructuredAgentSessionOption(replaced, 'fastMode', false)).toBe(true)
  })
})

describe('Codex speed phases carried beside option state', () => {
  const PHASES = {
    capabilityPhase: 'pending',
    optionsPhase: 'pending',
    catalogPhase: 'pending'
  } as const

  it('changes neither the snapshot nor admission nor the send hold', () => {
    const state = liveState({
      current: { serviceTier: FAST.value },
      host: 'supported',
      speed: READY_FAST
    })
    const phased = { ...state, ...PHASES }

    expect(structuredAgentSessionOptionSnapshot(phased)).toEqual(
      structuredAgentSessionOptionSnapshot(state)
    )
    for (const value of [STANDARD.value, FAST.value, ULTRA.value]) {
      expect(canSetStructuredAgentSessionOption(phased, 'serviceTier', value)).toBe(
        canSetStructuredAgentSessionOption(state, 'serviceTier', value)
      )
    }
    expect(structuredAgentSessionSpeedBlocked(phased)).toBe(false)
    expect(
      structuredAgentSessionSpeedBlocked(
        requestStructuredAgentSessionSpeed(phased, 'serviceTier', ULTRA.value)
      )
    ).toBe(true)
  })

  it('lets a later read or listing leave another source still pending', () => {
    const state = liveState({ host: 'supported' })
    const phased = { ...state, ...PHASES }

    const read: PhasedState = applyStructuredAgentSessionOptions(
      phased,
      CODEX_SESSION_OPTION_CATALOG,
      {
        models: heldModels(),
        fastModeSupport: { supported: true },
        current: { model: HELD_MODEL_ID, serviceTier: FAST.value },
        speed: READY_FAST
      },
      'supported'
    )
    const listed: PhasedState = applyStructuredAgentSessionModelCatalog(
      phased,
      CODEX_SESSION_OPTION_CATALOG,
      { origin: 'probe', models: heldModels([STANDARD, FAST]), fetchedAt: 2_000 },
      { newLaunch: false, codexSpeedHost: 'supported' }
    )

    expect(read.capabilityPhase).toBe('pending')
    expect(read.catalogPhase).toBe('pending')
    expect(listed.capabilityPhase).toBe('pending')
    expect(listed.optionsPhase).toBe('pending')
  })

  it('keeps the matching-ready release and the hold of another tier', () => {
    const requested = requestStructuredAgentSessionSpeed(
      liveState({ host: 'supported' }),
      'serviceTier',
      ULTRA.value
    )
    const held = { ...requested, ...PHASES }
    const read = (tier: string, speed: AgentSessionSpeedFacts) =>
      applyStructuredAgentSessionOptions(
        held,
        CODEX_SESSION_OPTION_CATALOG,
        {
          models: heldModels(),
          fastModeSupport: { supported: true },
          current: { model: HELD_MODEL_ID, serviceTier: tier },
          speed
        },
        'supported'
      )

    expect(read(FAST.value, READY_FAST).requested).toEqual({
      id: 'serviceTier',
      value: ULTRA.value
    })
    expect(read(ULTRA.value, READY_ULTRA).requested).toBeUndefined()
  })
})

describe('Claude and other providers with speed phases carried', () => {
  it('never retains or shows a speed select, held or reported', () => {
    const state = liveState({
      agent: 'claude',
      current: { serviceTier: ULTRA.value, fastMode: false },
      host: 'unknown',
      speed: READY_ULTRA
    })
    const view = structuredAgentSessionOptionView(
      state,
      { model: HELD_MODEL_ID },
      { serviceTier: ULTRA.value }
    )
    const phased = { ...view, capabilityPhase: 'pending', optionsPhase: 'failed' } as const

    expect(state.speed).toBeUndefined()
    expect(idsOf(phased)).not.toContain('serviceTier')
    for (const descriptor of structuredAgentSessionOptionSnapshot(phased)) {
      expect(linesWith(descriptor, undefined, { capabilityPhase: 'pending' })).toEqual([])
      expect(linesWith(descriptor, undefined, { optionsPhase: 'failed' })).toEqual([])
    }
  })
})
