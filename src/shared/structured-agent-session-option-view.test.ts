import { describe, expect, it } from 'vitest'
import {
  CLAUDE_SESSION_OPTION_CATALOG,
  CODEX_SESSION_OPTION_CATALOG
} from './agent-session-option-catalog-claude-codex'
import type { AgentSessionModelCatalogResult } from './agent-session-wire'
import type {
  SessionOptionDescriptor,
  SessionOptionValueSource
} from './native-chat-session-options'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  commitStructuredAgentSessionOption,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot,
  type StructuredAgentSessionOptionState
} from './structured-agent-session-options'
import {
  structuredAgentSessionOptionView,
  structuredAgentSessionSendSelection,
  structuredAgentSessionShownSnapshot
} from './structured-agent-session-option-view'

const levels = (...values: string[]) => values.map((value) => ({ value, label: value }))
const OPUS = { id: 'opus[1m]', label: 'Opus', isDefault: false, efforts: levels('low', 'xhigh') }
const SONNET = { id: 'sonnet', label: 'Sonnet', isDefault: false, efforts: levels('low', 'high') }
// Claude's session-less listing marks no default row.
const LISTED: AgentSessionModelCatalogResult = { origin: 'probe', fetchedAt: 1, models: [OPUS] }
const remembered = { model: 'claude-gone', effort: 'max' }
// Claude Code 2.1.302 lists plain opus and no opus[1m], which still runs.
const CLI302 = [{ ...OPUS, id: 'opus', isDefault: true }, SONNET]

const fresh = () => createStructuredAgentSessionOptionState('claude', CLAUDE_SESSION_OPTION_CATALOG)
const withHostList = (state = fresh(), catalog: AgentSessionModelCatalogResult = LISTED) =>
  applyStructuredAgentSessionModelCatalog(state, CLAUDE_SESSION_OPTION_CATALOG, catalog, {
    newLaunch: true
  })
// A chat's own answer lists its listing's rows plus its own model, named by its id; `listed` are
// the ids its listing names (none from an older host).
const stopped = (
  model: string,
  rows = [OPUS],
  listed = rows.map((row) => row.id),
  effort = 'high'
) =>
  applyStructuredAgentSessionOptions(fresh(), CLAUDE_SESSION_OPTION_CATALOG, {
    models: [...rows, { id: model, label: model, isDefault: false, efforts: [] }],
    listedModelIds: listed,
    current: { model, effort }
  })

function shown(...args: Parameters<typeof structuredAgentSessionOptionView>) {
  const snapshot = structuredAgentSessionOptionSnapshot(structuredAgentSessionOptionView(...args))
  const value = (id: string) => {
    const kind = snapshot.find((descriptor) => descriptor.id === id)?.kind
    return kind?.type === 'select' ? kind.currentValue : undefined
  }
  return { model: value('model'), effort: value('effort') }
}

const carried = (
  state: StructuredAgentSessionOptionState,
  seed?: Readonly<Record<string, string>>,
  picks: Readonly<Record<string, string>> = {}
) => structuredAgentSessionSendSelection(structuredAgentSessionOptionView(state, seed, picks))

describe('explicit Codex speed without a replacement model', () => {
  it.each([
    { saved: 'paid-speed-request-17', requested: 'default' },
    { saved: 'default', requested: 'paid-speed-request-17' }
  ])('shows and sends explicit $requested above saved $saved', ({ saved, requested }) => {
    const model = 'synthetic-tier-only-model'
    const state = applyStructuredAgentSessionModelCatalog(
      createStructuredAgentSessionOptionState('codex', CODEX_SESSION_OPTION_CATALOG),
      CODEX_SESSION_OPTION_CATALOG,
      {
        origin: 'probe',
        catalogState: 'available',
        fetchedAt: 1,
        listingNamesConfiguredModel: true,
        models: [
          {
            id: model,
            label: model,
            isDefault: true,
            efforts: [],
            serviceTiers: [{ value: 'paid-speed-request-17', label: 'Fast' }]
          }
        ]
      },
      { newLaunch: true }
    )
    const record = structuredClone(state.record)
    const view = structuredAgentSessionOptionView(
      state,
      { model, serviceTier: saved },
      {},
      { serviceTier: requested }
    )
    expect(
      structuredAgentSessionOptionSnapshot(view).find(({ id }) => id === 'serviceTier')
    ).toMatchObject({ kind: { currentValue: requested } })
    expect(structuredAgentSessionSendSelection(view)).toMatchObject({
      model,
      serviceTier: requested
    })
    expect(state.record).toEqual(record)
  })

  it.each(
    ['default', undefined].flatMap((savedTier) =>
      [false, true].flatMap((listingInProgress) =>
        [false, true].map((otherModelSpeed) => ({
          savedTier,
          listingInProgress,
          otherModelSpeed
        }))
      )
    )
  )(
    'retains unlisted model and Standard (saved=$savedTier, loading=$listingInProgress, other-speed=$otherModelSpeed)',
    ({ savedTier, listingInProgress, otherModelSpeed }) => {
      const savedModel = 'synthetic-saved-model-not-listed'
      const listedDefault = 'synthetic-different-catalog-default'
      const listedModel = {
        id: listedDefault,
        label: listedDefault,
        isDefault: true,
        efforts: [],
        serviceTiers: [
          { value: 'default', label: 'Standard' },
          { value: 'paid-only-for-default-B', label: 'Fast' }
        ]
      }
      const listed = applyStructuredAgentSessionModelCatalog(
        createStructuredAgentSessionOptionState('codex', CODEX_SESSION_OPTION_CATALOG),
        CODEX_SESSION_OPTION_CATALOG,
        {
          origin: 'probe',
          catalogState: 'available',
          fetchedAt: 1,
          listingNamesConfiguredModel: true,
          models: [listedModel]
        },
        { newLaunch: true }
      )
      const answered = otherModelSpeed
        ? applyStructuredAgentSessionOptions(listed, CODEX_SESSION_OPTION_CATALOG, {
            models: [listedModel],
            current: {
              model: listedDefault,
              serviceTier: 'paid-only-for-default-B',
              defaulted: ['model']
            },
            speed: {
              requested: { tierId: 'paid-only-for-default-B' },
              support: 'available',
              applied: { tierId: 'paid-only-for-default-B', turnId: 'B-turn' },
              processing: {
                status: 'reported',
                tierId: 'paid-only-for-default-B',
                turnId: 'B-turn'
              }
            }
          })
        : listed
      const state = { ...answered, listingInProgress }
      const record = structuredClone(state.record)
      const view = structuredAgentSessionOptionView(
        state,
        { model: savedModel, ...(savedTier === undefined ? {} : { serviceTier: savedTier }) },
        {},
        { serviceTier: 'default' }
      )
      expect(structuredAgentSessionSendSelection(view)).toMatchObject({
        model: savedModel,
        serviceTier: 'default'
      })
      const snapshot = structuredAgentSessionOptionSnapshot(view)
      expect(snapshot.find(({ id }) => id === 'model')).toMatchObject({
        kind: { currentValue: savedModel }
      })
      const descriptor = snapshot.find(({ id }) => id === 'serviceTier')
      expect(descriptor?.kind).toMatchObject({ type: 'select', currentValue: 'default' })
      expect(descriptor?.speed).toEqual({
        requested: { tierId: 'default' },
        support: listingInProgress ? 'loading' : 'unknown',
        processing: { status: 'unknown' }
      })
      expect(descriptor?.settable).toBe(!listingInProgress)
      const tier = descriptor?.kind
      expect(tier?.type === 'select' ? tier.choices.map(({ value }) => value) : []).not.toContain(
        'paid-only-for-default-B'
      )
      expect(state.record).toEqual(record)
    }
  )

  it.each(['unavailable', 'loading'] as const)(
    'preserves genuine %s evidence for the same unlisted model',
    (support) => {
      const model = 'synthetic-unlisted-own-model'
      const speed = {
        requested: { tierId: 'default' },
        support,
        processing: { status: 'unknown' as const }
      }
      const state = applyStructuredAgentSessionOptions(
        createStructuredAgentSessionOptionState('codex', CODEX_SESSION_OPTION_CATALOG),
        CODEX_SESSION_OPTION_CATALOG,
        {
          models: [
            { id: 'synthetic-other-listed-model', label: 'Other', efforts: [], isDefault: true }
          ],
          listedModelIds: ['synthetic-other-listed-model'],
          current: { model, serviceTier: 'default', defaulted: [] },
          speed
        }
      )
      const view = structuredAgentSessionOptionView(
        state,
        undefined,
        {},
        { serviceTier: 'default' }
      )
      expect(
        structuredAgentSessionOptionSnapshot(view).find(({ id }) => id === 'serviceTier')
      ).toMatchObject({ kind: { currentValue: 'default' }, speed })
    }
  )
})

describe('a Claude model its CLI no longer lists', () => {
  it('stays the chat model through a refresh and every send, its effort read-only', () => {
    // The incident: a chat on opus[1m] at max, reopened under a CLI that lists only plain opus.
    const restored = withHostList(stopped('opus[1m]', CLI302, undefined, 'max'), {
      ...LISTED,
      models: CLI302
    })
    const refreshed = applyStructuredAgentSessionOptions(restored, CLAUDE_SESSION_OPTION_CATALOG, {
      models: [...CLI302, { id: 'opus[1m]', label: 'opus[1m]', isDefault: false, efforts: [] }],
      listedModelIds: CLI302.map((row) => row.id),
      current: { model: 'opus[1m]', effort: 'max' }
    })
    for (const state of [restored, refreshed]) {
      expect(shown(state, undefined, {})).toEqual({ model: 'opus[1m]', effort: 'max' })
      expect(carried(state)).toEqual({ model: 'opus[1m]', effort: 'max' })
      const snapshot = structuredAgentSessionShownSnapshot(state)
      // No inferred menu: the one level it holds, which nothing can change.
      expect(snapshot.find((entry) => entry.id === 'effort')).toMatchObject({
        settable: false,
        kind: { choices: [{ value: 'max', label: 'max' }] }
      })
    }
  })

  it('waits for an unlisted seed and carries a current effort without an offered menu', () => {
    // The placeholder stands until the host answers with the chat's own model; create seeds it.
    expect(carried(withHostList(), remembered)).toBeUndefined()
    const haiku = { id: 'haiku', label: 'Haiku', isDefault: false, efforts: [] }
    const listed = applyStructuredAgentSessionOptions(fresh(), CLAUDE_SESSION_OPTION_CATALOG, {
      models: [OPUS, haiku],
      listedModelIds: ['opus[1m]', 'haiku'],
      current: { model: 'haiku', effort: 'high' }
    })
    expect(shown(listed, undefined, {})).toEqual({ model: 'haiku', effort: 'high' })
    expect(carried(listed)).toEqual({ model: 'haiku', effort: 'high' })
    expect(
      structuredAgentSessionShownSnapshot(listed).find((entry) => entry.id === 'effort')
    ).toMatchObject({
      settable: false,
      kind: { currentValue: 'high', choices: [{ value: 'high', label: 'high' }] }
    })
  })
})

describe('what a send carries', () => {
  it('carries the default it shows when nothing names a model', () => {
    const named = { ...SONNET, isDefault: true }
    const listing = { ...LISTED, models: [OPUS, named], listingNamesConfiguredModel: true }
    expect(carried(withHostList(fresh(), listing))).toEqual({ model: 'sonnet' })
  })

  it('carries held picks without committing them to the chat', () => {
    const listed = {
      ...withHostList(fresh(), { ...LISTED, models: [OPUS, SONNET] }),
      pendingId: 'model'
    }
    const originalRecord = structuredClone(listed.record)
    const view = structuredAgentSessionOptionView(listed, remembered, {
      model: 'sonnet',
      effort: 'high'
    })
    expect(structuredAgentSessionSendSelection(view)).toEqual({ model: 'sonnet', effort: 'high' })
    expect(view.pendingId).toBe('model')
    expect(view.record).not.toBe(listed.record)
    expect(listed.record).toEqual(originalRecord)
    expect(carried(listed, remembered, { model: 'sonnet' })).toEqual({ model: 'sonnet' })
    expect(carried(withHostList(), undefined, { model: 'claude-retired' })).toEqual({
      model: 'claude-retired'
    })
  })

  it('carries nothing before a model shows, or for another agent', () => {
    expect(carried(fresh())).toBeUndefined()
    const codex = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('codex', CLAUDE_SESSION_OPTION_CATALOG),
      CLAUDE_SESSION_OPTION_CATALOG,
      { models: [OPUS], current: { model: 'opus[1m]' } }
    )
    expect(carried(codex)).toBeUndefined()
  })
})

function legacySelection(snapshot: SessionOptionDescriptor[]) {
  const state = createStructuredAgentSessionOptionState('codex', {
    ...CLAUDE_SESSION_OPTION_CATALOG,
    models: [
      {
        id: 'synthetic-model',
        label: 'Synthetic',
        options: [
          {
            id: 'fastMode',
            label: 'Fast',
            kind: { type: 'boolean', defaultValue: false },
            apply: {}
          }
        ]
      }
    ]
  })
  state.catalogSource = 'live'
  state.record.values.model = { value: 'synthetic-model', source: 'default' }
  for (const option of snapshot) {
    const value = option.kind.currentValue
    if (value !== undefined && option.valueSource !== 'unknown') {
      state.record.values[option.id] = { value, source: option.valueSource }
    }
  }
  return structuredAgentSessionSendSelection(state)
}

describe('Codex legacy Fast provenance on sends', () => {
  function legacy(
    valueSource: SessionOptionValueSource,
    currentValue: boolean
  ): SessionOptionDescriptor {
    return {
      id: 'fastMode',
      label: 'Fast',
      kind: { type: 'boolean', currentValue },
      valueSource,
      transport: 'agent-session',
      settable: true
    }
  }

  it.each(['unknown', 'default'] as const)(
    'does not turn an %s false display into an explicit Standard request',
    (source) => {
      expect(legacySelection([legacy(source, false)])).toBeUndefined()
    }
  )

  it.each(['applied', 'dispatched', 'reported'] as const)(
    'preserves explicit false and true from %s',
    (source) => {
      expect(legacySelection([legacy(source, false)])).toEqual({
        fastMode: 'false'
      })
      expect(legacySelection([legacy(source, true)])).toEqual({
        fastMode: 'true'
      })
    }
  )

  it('keeps the model attached to an explicit legacy false preference', () => {
    const model: SessionOptionDescriptor = {
      id: 'model',
      label: 'Model',
      kind: { type: 'select', currentValue: 'synthetic-model', choices: [] },
      valueSource: 'reported',
      transport: 'agent-session',
      settable: true
    }
    expect(legacySelection([model, legacy('dispatched', false)])).toEqual({
      model: 'synthetic-model',
      fastMode: 'false'
    })
  })
})

describe("a chat's model and effort, apart from the defaults filling them in", () => {
  const listed = CLI302.map((row) => row.id)
  // A resumed chat at rest that never picked a model: its host fills in the listing's default.
  const resumed = (defaulted?: readonly ('model' | 'effort')[]) =>
    applyStructuredAgentSessionOptions(
      applyStructuredAgentSessionModelCatalog(
        fresh(),
        CLAUDE_SESSION_OPTION_CATALOG,
        { ...LISTED, models: CLI302 },
        { newLaunch: false }
      ),
      CLAUDE_SESSION_OPTION_CATALOG,
      {
        models: CLI302,
        listedModelIds: listed,
        current: { model: 'opus', effort: 'low', ...(defaulted ? { defaulted } : {}) }
      }
    )

  it("names a resumed chat's defaults but never sends them, only its picks", () => {
    const state = resumed(['model', 'effort'])
    expect(shown(state, undefined, {})).toEqual({ model: 'opus', effort: 'low' })
    expect(carried(state)).toBeUndefined()
    const effort = commitStructuredAgentSessionOption(state, 'effort', 'xhigh')
    expect(carried(effort)).toEqual({ effort: 'xhigh' })
  })

  it("reads an older host's answer, which marks no default, as it always has", () => {
    const state = resumed()
    expect(shown(state, undefined, {})).toEqual({ model: 'opus', effort: 'low' })
    expect(carried(state)).toEqual({ model: 'opus', effort: 'low' })
    expect(
      structuredAgentSessionShownSnapshot(state).map(({ id, valueSource }) => ({ id, valueSource }))
    ).toEqual([
      { id: 'model', valueSource: 'dispatched' },
      { id: 'effort', valueSource: 'dispatched' }
    ])
  })

  it('lets a new chat pick its effort before its first message, under the default it shows', () => {
    const state = withHostList(fresh(), {
      ...LISTED,
      models: CLI302,
      listingNamesConfiguredModel: true
    })
    expect(shown(state, undefined, { effort: 'xhigh' })).toEqual({ model: 'opus', effort: 'xhigh' })
    expect(carried(state, undefined, { effort: 'xhigh' })).toEqual({
      model: 'opus',
      effort: 'xhigh'
    })
  })
})
