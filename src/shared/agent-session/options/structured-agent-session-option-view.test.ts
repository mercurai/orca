import { structuredAgentSessionSeedCatalog } from './structured-agent-session-seed-catalog'
import { describe, expect, it } from 'vitest'
import {
  CLAUDE_SESSION_OPTION_CATALOG,
  CODEX_SESSION_OPTION_CATALOG
} from './agent-session-option-catalog-claude-codex'
import type { AgentSessionModelCatalogResult } from '../agent-session-wire'
import type {
  SessionOptionDescriptor,
  SessionOptionValueSource
} from '../../native-chat/input/native-chat-session-options'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  commitStructuredAgentSessionOption,
  createStructuredAgentSessionOptionState,
  type StructuredAgentSessionOptionState
} from './structured-agent-session-options'
import {
  canSetStructuredAgentSessionOption,
  structuredAgentSessionOptionSnapshot
} from './structured-agent-session-option-snapshot'
import {
  structuredAgentSessionMessageSelection,
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

describe('a requested Codex tier while only the seed catalog exists', () => {
  it('stays exact for a model the seed lists, without claiming support or entitlement', () => {
    const model = CODEX_SESSION_OPTION_CATALOG.models[0]!.id
    const tier = 'synthetic-seed-only-exact-tier'
    const state = createStructuredAgentSessionOptionState('codex', CODEX_SESSION_OPTION_CATALOG)
    state.record.values.model = { value: model, source: 'dispatched' }
    state.record.values.serviceTier = { value: tier, source: 'dispatched' }
    const record = structuredClone(state.record)

    const descriptor = structuredAgentSessionOptionSnapshot(state).find(
      ({ id }) => id === 'serviceTier'
    )

    expect(state.catalogSource).toBe('seed')
    expect(descriptor?.kind).toMatchObject({ type: 'select', currentValue: tier })
    expect(descriptor?.speed).toEqual({
      requested: { tierId: tier },
      support: 'unknown',
      processing: { status: 'unknown' }
    })
    expect(state.record).toEqual(record)
  })
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

  it('shows the literal seed when a built-in id has no host-listed label', () => {
    const seed = { model: 'sonnet' }
    const view = structuredAgentSessionOptionView(withHostList(), seed, {})
    const model = structuredAgentSessionOptionSnapshot(view).find((entry) => entry.id === 'model')
    expect(model?.kind).toMatchObject({
      currentValue: 'sonnet',
      choices: expect.arrayContaining([{ value: 'sonnet', label: 'Sonnet', description: 'sonnet' }])
    })
  })

  it('shows an unlisted seed literally and carries a current effort without an offered menu', () => {
    const view = structuredAgentSessionOptionView(withHostList(), remembered, {})
    expect(carried(withHostList(), remembered)).toEqual(remembered)
    expect(
      structuredAgentSessionOptionSnapshot(view).find((entry) => entry.id === 'model')?.kind
    ).toMatchObject({
      currentValue: 'claude-gone',
      choices: expect.arrayContaining([
        { value: 'claude-gone', label: 'Claude Gone', description: 'claude-gone' }
      ])
    })
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
  it('shows an unlisted seed before discovery and sends it literally to an older Claude host', () => {
    const seed = { model: 'custom/sonnet[1m]', effort: 'high' }
    const state = fresh()
    const view = structuredAgentSessionOptionView(state, seed, {})
    expect(view.catalogSource).toBe('seed')
    expect(structuredAgentSessionOptionSnapshot(view)).toMatchObject([
      {
        id: 'model',
        kind: {
          currentValue: seed.model,
          choices: [
            { value: seed.model, label: 'Custom Sonnet (1M context)', description: seed.model }
          ]
        }
      },
      { id: 'effort', kind: { currentValue: 'high' }, settable: false }
    ])
    expect(structuredAgentSessionSendSelection(view)).toEqual(seed)
    expect(structuredAgentSessionMessageSelection(view)).toEqual(seed)
    expect(state.record.values).toEqual({})
  })

  it('keeps a provisional Codex effort out of capture across a reply and catalog refresh', () => {
    const catalog: AgentSessionModelCatalogResult = {
      origin: 'probe',
      fetchedAt: 1,
      listingNamesConfiguredModel: true,
      models: [
        {
          id: 'native',
          label: 'Native',
          isDefault: true,
          defaultEffort: 'low',
          efforts: levels('low', 'high')
        }
      ]
    }
    const launch = { newLaunch: true, coherentCatalog: true }
    let state = applyStructuredAgentSessionModelCatalog(
      createStructuredAgentSessionOptionState('codex', CODEX_SESSION_OPTION_CATALOG),
      CODEX_SESSION_OPTION_CATALOG,
      catalog,
      launch
    )
    // The first send still pins policy defaults on hosts that have not answered options.
    expect(structuredAgentSessionMessageSelection(state)).toMatchObject({
      model: 'native',
      effort: 'low'
    })
    state = applyStructuredAgentSessionOptions(
      state,
      CODEX_SESSION_OPTION_CATALOG,
      {
        models: [],
        current: { model: 'native', defaulted: [], acceptedInputSources: { model: 'saved' } }
      },
      launch
    )
    const recorded = structuredClone(state.record.values)
    for (const defaultEffort of ['low', 'high', undefined]) {
      state = applyStructuredAgentSessionModelCatalog(
        state,
        CODEX_SESSION_OPTION_CATALOG,
        {
          ...catalog,
          models: catalog.models.map((row) => ({ ...row, defaultEffort }))
        },
        launch
      )
      const effort = structuredAgentSessionShownSnapshot(state).find((row) => row.id === 'effort')
      expect(effort?.kind.currentValue).toBe(defaultEffort)
      expect(effort?.valueSource).toBe(defaultEffort ? 'default' : 'unknown')
      expect(
        structuredAgentSessionOptionSnapshot(state).find((row) => row.id === 'effort')?.kind
          .currentValue
      ).toBeUndefined()
      expect(structuredAgentSessionMessageSelection(state)).toEqual({ model: 'native' })
      expect(state.record.values).toEqual(recorded)
    }
    state.record.values.model = { value: 'unlisted', source: 'dispatched' }
    expect(
      structuredAgentSessionShownSnapshot(state).find((row) => row.id === 'effort')
    ).toBeUndefined()
  })

  it.each(['claude', 'codex', 'opencode', 'grok', 'pi', 'omp'])(
    'shows %s declared effort after a reply without changing its send selection',
    (agent) => {
      const seed = structuredAgentSessionSeedCatalog(agent)
      const row = { ...SONNET, defaultEffort: 'high', declaredDefaultEffort: 'low' }
      for (const listedModelIds of [['sonnet'], ['other'], undefined]) {
        for (const declaration of ['low', null, undefined]) {
          const { declaredDefaultEffort: _observation, ...oldRow } = row
          const state = applyStructuredAgentSessionOptions(
            createStructuredAgentSessionOptionState(agent, seed),
            seed,
            {
              models: [
                {
                  ...oldRow,
                  ...(declaration !== undefined ? { declaredDefaultEffort: declaration } : {})
                }
              ],
              listedModelIds,
              current: { model: 'sonnet', defaulted: [], acceptedInputSources: { model: 'saved' } }
            }
          )
          const excluded = listedModelIds !== undefined && !listedModelIds.includes('sonnet')
          const expected = excluded
            ? undefined
            : (declaration ??
              (declaration === undefined && agent === 'codex' && listedModelIds
                ? 'high'
                : undefined))
          const snapshot = structuredAgentSessionShownSnapshot(state)
          expect(snapshot.find((row) => row.id === 'effort')?.kind.currentValue).toBe(expected)
          expect(structuredAgentSessionMessageSelection(state)).toEqual({ model: 'sonnet' })
          // Codex sends carry the chat's own model like Claude; the other agents carry none.
          expect(structuredAgentSessionSendSelection(state)).toEqual(
            agent === 'claude' || agent === 'codex' ? { model: 'sonnet' } : undefined
          )
          const held = structuredAgentSessionOptionView(state, undefined, {
            model: 'sonnet',
            effort: 'max'
          })
          expect(
            structuredAgentSessionShownSnapshot(held).find((row) => row.id === 'effort')?.kind
              .currentValue
          ).toBe(agent === 'pi' && !excluded ? 'high' : 'max')
          expect(structuredAgentSessionMessageSelection(held)).toEqual({
            model: 'sonnet',
            effort: 'max'
          })
          const picked = commitStructuredAgentSessionOption(state, 'effort', 'high')
          expect(
            structuredAgentSessionShownSnapshot(picked).find((row) => row.id === 'effort')?.kind
              .currentValue
          ).toBe('high')
          expect(structuredAgentSessionMessageSelection(picked)).toEqual({
            model: 'sonnet',
            effort: 'high'
          })
        }
      }
    }
  )

  it('carries the default it shows when nothing names a model', () => {
    const named = { ...SONNET, isDefault: true }
    const listing = { ...LISTED, models: [OPUS, named], listingNamesConfiguredModel: true }
    expect(carried(withHostList(fresh(), listing))).toEqual({ model: 'sonnet' })
  })

  it('carries held picks without committing them to the chat', () => {
    const listed = withHostList(fresh(), { ...LISTED, models: [OPUS, SONNET] })
    const originalRecord = structuredClone(listed.record)
    const view = structuredAgentSessionOptionView(listed, remembered, {
      model: 'sonnet',
      effort: 'high'
    })
    expect(structuredAgentSessionSendSelection(view)).toEqual({ model: 'sonnet', effort: 'high' })
    expect(view.record).not.toBe(listed.record)
    expect(listed.record).toEqual(originalRecord)
    expect(carried(listed, remembered, { model: 'sonnet' })).toEqual({
      model: 'sonnet',
      effort: 'max'
    })
    expect(carried(withHostList(), undefined, { model: 'claude-retired' })).toEqual({
      model: 'claude-retired'
    })
  })

  it('carries nothing before a model shows, or for another agent', () => {
    expect(carried(fresh())).toBeUndefined()
    const otherAgent = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('grok', CLAUDE_SESSION_OPTION_CATALOG),
      CLAUDE_SESSION_OPTION_CATALOG,
      { models: [OPUS], current: { model: 'opus[1m]' } }
    )
    expect(carried(otherAgent)).toBeUndefined()
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

describe('legacy Codex intent under a modern speed selector', () => {
  const model = 'synthetic-modern-speed-model'
  const tier = 'synthetic-modern-exact-fast-tier'

  function selected(source: SessionOptionValueSource, fastMode: boolean, serviceTier?: string) {
    const state = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('codex', CODEX_SESSION_OPTION_CATALOG),
      CODEX_SESSION_OPTION_CATALOG,
      {
        models: [
          {
            id: model,
            label: model,
            isDefault: false,
            efforts: [],
            serviceTiers: [{ value: tier, label: 'Fast' }]
          }
        ],
        current: { model, defaulted: [] }
      }
    )
    if (source !== 'unknown') {
      state.record.values.fastMode = { value: fastMode, source }
    }
    if (serviceTier !== undefined) {
      state.record.values.serviceTier = { value: serviceTier, source: 'dispatched' }
    }
    const before = structuredClone(state.record)
    const options = structuredAgentSessionSendSelection(state)
    expect(state.record).toEqual(before)
    return options
  }

  it.each(['applied', 'dispatched', 'reported'] as const)(
    'sends explicit false from %s as Standard',
    (source) => {
      expect(selected(source, false)).toEqual({ model, serviceTier: 'default' })
    }
  )

  it.each(['applied', 'dispatched', 'reported'] as const)(
    'retains explicit true from %s for host admission',
    (source) => {
      expect(selected(source, true)).toEqual({ model, fastMode: 'true' })
    }
  )

  it.each(['unknown', 'default'] as const)(
    'does not make an %s false value an explicit speed request',
    (source) => {
      expect(selected(source, false)).toEqual({ model })
    }
  )

  it.each([false, true])('prefers a canonical tier to same-level legacy %s', (fastMode) => {
    expect(selected('dispatched', fastMode, tier)).toEqual({ model, serviceTier: tier })
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

describe('Pi supported selection apart from saved intent', () => {
  const seed = structuredAgentSessionSeedCatalog('pi')
  const remembered = { model: 'openai/gpt-5', effort: 'off' }
  const row = {
    id: remembered.model,
    label: 'GPT-5',
    isDefault: false,
    efforts: levels('minimal', 'low', 'medium', 'high')
  }
  const catalog = (efforts = row.efforts) => ({
    origin: 'probe' as const,
    models: [{ ...row, efforts }],
    fetchedAt: 1
  })
  const fresh = () => createStructuredAgentSessionOptionState('pi', seed)
  const install = (state = fresh(), efforts = row.efforts) =>
    applyStructuredAgentSessionModelCatalog(state, seed, catalog(efforts), { newLaunch: true })
  const effort = (state: StructuredAgentSessionOptionState) =>
    structuredAgentSessionShownSnapshot(state).find((option) => option.id === 'effort')

  it('rederives new and restored blank controls on a late precise row and readback without restoring off', () => {
    const coarse = install(fresh(), levels('off', 'minimal', 'low', 'medium', 'high'))
    expect(shown(coarse, remembered, {})).toEqual(remembered)
    const precise = install(coarse)
    const newView = structuredAgentSessionOptionView(precise, remembered, {})
    const restored = applyStructuredAgentSessionOptions(install(), seed, {
      models: [row],
      listedModelIds: [row.id],
      current: remembered
    })
    const readback = applyStructuredAgentSessionOptions(restored, seed, {
      models: [row],
      listedModelIds: [row.id],
      current: { ...remembered, effort: 'minimal', confirmed: ['model', 'effort'] }
    })
    for (const state of [newView, restored, readback]) {
      expect(effort(state)).toMatchObject({
        kind: { currentValue: 'minimal', choices: row.efforts },
        settable: true
      })
      expect(canSetStructuredAgentSessionOption(state, 'effort', 'off')).toBe(true)
      expect(canSetStructuredAgentSessionOption(state, 'effort', 'minimal')).toBe(true)
      expect(structuredAgentSessionSendSelection(state)).toBeUndefined()
    }
    expect(remembered.effort).toBe('off')
    expect(precise.record.values).toEqual({})
  })

  it('uses native policy for seeds and ordinary input, and keeps actual/unknown evidence honest', () => {
    const gapped = { ...row, efforts: levels('off', 'minimal', 'low', 'xhigh') }
    const state = install(fresh(), gapped.efforts)
    expect(shown(state, { ...remembered, effort: 'medium' }, {})).toMatchObject({ effort: 'xhigh' })
    const ordinary = applyStructuredAgentSessionOptions(state, seed, {
      models: [gapped],
      current: {
        ...remembered,
        effort: 'medium',
        acceptedInputSources: { model: 'saved', effort: 'saved' }
      }
    })
    expect(effort(ordinary)).toMatchObject({
      kind: { currentValue: 'xhigh', choices: gapped.efforts }
    })
    expect(structuredAgentSessionMessageSelection(ordinary).effort).toBe('medium')
    const actual = applyStructuredAgentSessionOptions(install(), seed, {
      models: [row],
      current: {
        ...remembered,
        reportedEffort: 'future',
        acceptedInputSources: { model: 'saved', effort: 'saved' }
      }
    })
    expect(structuredAgentSessionMessageSelection(actual)).toEqual(remembered)

    expect(effort(actual)).toMatchObject({
      settable: false,
      kind: { currentValue: 'future', choices: [{ value: 'future', label: 'future' }] }
    })
    const cleared = applyStructuredAgentSessionOptions(install(), seed, {
      models: [row],
      current: { ...remembered, reportedEffort: 'low', acceptedInputSources: {} }
    })
    expect(structuredAgentSessionMessageSelection(cleared)).toEqual({})
    const absent = applyStructuredAgentSessionOptions(cleared, seed, {
      models: [row],
      current: remembered
    })
    expect(absent.reportedEffort).toBeUndefined()
    expect(structuredAgentSessionMessageSelection(absent)).toEqual(remembered)
    const equal = commitStructuredAgentSessionOption(actual, 'effort', 'off')
    expect(equal.reportedEffort).toBeUndefined()
    expect(effort(equal)?.kind.currentValue).toBe('minimal')
    const future = commitStructuredAgentSessionOption(equal, 'effort', 'high')
    expect(effort(future)?.kind.currentValue).toBe('high')
    expect(structuredAgentSessionMessageSelection(future).effort).toBe('high')

    const unknown = applyStructuredAgentSessionOptions(install(), seed, {
      models: [{ ...row, effortsKnown: false }],
      current: remembered
    })
    expect(effort(unknown)).toMatchObject({ settable: false, kind: { currentValue: 'off' } })
  })

  it('keeps unknown Pi effort read-only with raw intent and no speed controls (Pi emits no serviceTiers)', () => {
    const state = applyStructuredAgentSessionOptions(install(), seed, {
      models: [{ ...row, effortsKnown: false }],
      current: { ...remembered, acceptedInputSources: { model: 'saved', effort: 'saved' } }
    })
    const options = structuredAgentSessionOptionSnapshot(state)

    expect(effort(state)).toMatchObject({ settable: false, kind: { currentValue: 'off' } })
    expect(canSetStructuredAgentSessionOption(state, 'effort', 'high')).toBe(false)
    expect(structuredAgentSessionMessageSelection(state)).toEqual(remembered)
    expect(options.some((option) => option.id === 'serviceTier')).toBe(false)
    expect(options.some((option) => option.id === 'fastMode')).toBe(false)
  })

  it('accepts only an in-menu typed effort while the host reports an unknown level, keeping raw intent', () => {
    const actual = applyStructuredAgentSessionOptions(install(), seed, {
      models: [row],
      current: {
        ...remembered,
        reportedEffort: 'future',
        acceptedInputSources: { model: 'saved', effort: 'saved' }
      }
    })
    expect(effort(actual)).toMatchObject({ settable: false, kind: { currentValue: 'future' } })
    expect(canSetStructuredAgentSessionOption(actual, 'effort', 'high')).toBe(true)
    expect(canSetStructuredAgentSessionOption(actual, 'effort', 'xhigh')).toBe(false)
    expect(structuredAgentSessionMessageSelection(actual)).toEqual(remembered)
  })

  it('does not take another model’s effort menu as proof for a listed or unlisted current model', () => {
    const other = {
      id: 'other/model',
      label: 'Other',
      isDefault: false,
      efforts: levels('high', 'xhigh')
    }
    const current = {
      ...remembered,
      reportedEffort: 'future',
      acceptedInputSources: { model: 'saved' as const, effort: 'saved' as const }
    }
    const listed = applyStructuredAgentSessionOptions(install(), seed, {
      models: [{ ...row, efforts: levels('minimal', 'low') }, other],
      current
    })
    expect(effort(listed)).toMatchObject({ settable: false, kind: { currentValue: 'future' } })
    expect(canSetStructuredAgentSessionOption(listed, 'effort', 'low')).toBe(true)
    expect(canSetStructuredAgentSessionOption(listed, 'effort', 'high')).toBe(false)

    const unlisted = applyStructuredAgentSessionOptions(install(), seed, {
      models: [other],
      current
    })
    expect(effort(unlisted)).toMatchObject({ settable: false, kind: { currentValue: 'future' } })
    expect(canSetStructuredAgentSessionOption(unlisted, 'effort', 'high')).toBe(false)
  })

  it('bounds projection work by the existing model rows at N and 10N without population subscriptions', () => {
    const work = (size: number) => {
      let reads = 0
      const state = install()
      const controls = state.catalog!.models[0]!.options
      state.catalog!.models = Array.from({ length: size }, (_, index) => ({
        get id() {
          reads += 1
          return index === size - 1 ? row.id : `other-${index}`
        },
        label: 'Model',
        options: controls
      }))
      const view = structuredAgentSessionOptionView(state, remembered, {})
      expect(effort(view)).toMatchObject({ kind: { currentValue: 'minimal' } })
      return reads
    }
    const small = work(61)
    expect(work(610)).toBeLessThanOrEqual(10 * small)
  })
})

it.each(['claude', 'codex'] as const)('bounds %s capture and display work', (agent) => {
  const work: { capture: number; rows: number; verified: number }[] = []
  const seed = agent === 'codex' ? CODEX_SESSION_OPTION_CATALOG : CLAUDE_SESSION_OPTION_CATALOG
  for (const count of [10, 100]) {
    let rows = 0
    let verified = 0
    const model = `model-${count - 1}`
    const models = Array.from({ length: count }, (_, index) => ({
      id: `model-${index}`,
      label: `Model ${index}`,
      isDefault: false,
      defaultEffort: 'high',
      efforts: levels('low', 'high')
    }))
    const state = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState(agent, seed),
      seed,
      {
        models,
        listedModelIds: models.map((row) => row.id),
        current: {
          model,
          ...(agent === 'claude' ? { effort: 'high' } : {}),
          acceptedInputSources: {
            model: 'saved',
            ...(agent === 'claude' ? { effort: 'saved' as const } : {})
          }
        }
      },
      { newLaunch: false, coherentCatalog: false }
    )
    for (const row of state.catalog?.models ?? []) {
      const id = row.id
      Object.defineProperty(row, 'id', {
        get: () => {
          rows++
          return id
        }
      })
    }
    state.verifiedModelIds?.forEach((id, index, ids) => {
      Object.defineProperty(ids, index, {
        get: () => {
          verified++
          return id
        }
      })
    })
    expect(structuredAgentSessionMessageSelection(state)).toEqual({
      model,
      ...(agent === 'claude' ? { effort: 'high' } : {})
    })
    const capture = rows
    expect(capture).toBeLessThanOrEqual(10 * count)
    rows = 0
    verified = 0
    expect(
      structuredAgentSessionShownSnapshot(state).find((row) => row.id === 'effort')
    ).toMatchObject({
      valueSource: agent === 'codex' ? 'default' : 'dispatched',
      kind: { currentValue: 'high' }
    })
    expect(rows).toBeGreaterThanOrEqual(count)
    expect(rows).toBeLessThanOrEqual(10 * count)
    expect(verified).toBeGreaterThanOrEqual(count)
    expect(verified).toBeLessThanOrEqual(5 * count)
    work.push({ capture, rows, verified })
    if (agent === 'codex') {
      for (const effort of ['low', 'high']) {
        const accepted = commitStructuredAgentSessionOption(state, 'effort', effort)
        rows = verified = 0
        const canonical = structuredAgentSessionOptionSnapshot(accepted)
        const canonicalWork = { rows, verified }
        rows = verified = 0
        const shown = structuredAgentSessionShownSnapshot(accepted)
        const shownWork = { rows, verified }
        expect(shownWork).toEqual(canonicalWork)
        expect(shown).toEqual(canonical)
        expect(shown.find((row) => row.id === 'effort')).toMatchObject({
          valueSource: 'dispatched',
          kind: { currentValue: effort }
        })
        expect(structuredAgentSessionMessageSelection(accepted)).toEqual({ model, effort })
        console.info(
          'accepted-codex-projection-visits',
          JSON.stringify({ count, effort, canonicalWork, shownWork })
        )
      }
    }
  }
  expect(work[1].capture).toBeLessThanOrEqual(11 * work[0].capture)
  expect(work[1].rows).toBeLessThanOrEqual(11 * work[0].rows)
  expect(work[1].verified).toBeLessThanOrEqual(11 * work[0].verified)
  console.info(`${agent}-shown-projection-visits`, JSON.stringify(work))
})

describe('Codex model and effort without speed controls', () => {
  const model = 'synthetic-speedless-model'
  const models = [
    { id: model, label: 'Synthetic', isDefault: true, efforts: levels('low', 'high') }
  ]
  const state = (defaulted?: readonly ('model' | 'effort')[]) =>
    applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('codex', CODEX_SESSION_OPTION_CATALOG),
      CODEX_SESSION_OPTION_CATALOG,
      {
        models,
        current: { model, effort: 'low', ...(defaulted ? { defaulted } : {}) }
      }
    )

  it('carries an older host model and effort without inventing a speed request', () => {
    const current = state()
    expect(
      structuredAgentSessionOptionSnapshot(current).filter(
        ({ id }) => id === 'serviceTier' || id === 'fastMode'
      )
    ).toEqual([])
    expect(carried(current)).toEqual({ model, effort: 'low' })
  })

  it('carries a pending effort above the older host effort without changing the host record', () => {
    const current = state()
    expect(carried(current, undefined, { effort: 'high' })).toEqual({ model, effort: 'high' })
    expect(current.record.values.effort?.value).toBe('low')
  })

  it('keeps resumed defaults sparse while carrying a new effort pick', () => {
    const current = state(['model', 'effort'])
    expect(carried(current)).toBeUndefined()
    expect(carried(current, undefined, { effort: 'high' })).toEqual({ effort: 'high' })
  })

  it('carries an own model when neither effort nor speed has a value', () => {
    const current = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('codex', CODEX_SESSION_OPTION_CATALOG),
      CODEX_SESSION_OPTION_CATALOG,
      { models, current: { model } }
    )
    expect(carried(current)).toEqual({ model })
  })
})

describe('typed effort repair for Claude and Codex while the effort control is read-only', () => {
  const effortOf = (state: StructuredAgentSessionOptionState) =>
    structuredAgentSessionOptionSnapshot(state).find(({ id }) => id === 'effort')
  const listedRow = {
    id: 'synthetic-listed-model',
    label: 'Listed',
    isDefault: true,
    efforts: levels('low', 'high')
  }
  const customRow = {
    id: 'synthetic-custom-model',
    label: 'Custom',
    isDefault: false,
    efforts: []
  }
  const answered = (
    agent: 'claude' | 'codex',
    models: (typeof listedRow)[],
    listedModelIds: string[],
    current: { model: string; effort: string }
  ) => {
    const seed = agent === 'codex' ? CODEX_SESSION_OPTION_CATALOG : CLAUDE_SESSION_OPTION_CATALOG
    return applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState(agent, seed),
      seed,
      { models, listedModelIds, current }
    )
  }

  it.each(['claude', 'codex'] as const)(
    'accepts a typed level for a custom unlisted %s model whose effort is read-only',
    (agent) => {
      const state = answered(agent, [listedRow, customRow], [listedRow.id], {
        model: customRow.id,
        effort: 'high'
      })
      expect(effortOf(state)).toMatchObject({ settable: false, kind: { currentValue: 'high' } })
      expect(canSetStructuredAgentSessionOption(state, 'effort', 'low')).toBe(true)
      expect(canSetStructuredAgentSessionOption(state, 'effort', '')).toBe(false)
    }
  )

  it.each(['claude', 'codex'] as const)(
    'accepts a typed level for a listed %s model with no effort menu and a saved effort',
    (agent) => {
      const bareRow = { ...customRow, id: 'synthetic-bare-model' }
      const state = answered(agent, [listedRow, bareRow], [listedRow.id, bareRow.id], {
        model: bareRow.id,
        effort: 'max'
      })
      expect(effortOf(state)).toMatchObject({ settable: false, kind: { currentValue: 'max' } })
      expect(canSetStructuredAgentSessionOption(state, 'effort', 'high')).toBe(true)
    }
  )

  it.each(['claude', 'codex'] as const)(
    'accepts a typed level for a listed %s model whose saved effort is retired',
    (agent) => {
      const state = answered(agent, [listedRow], [listedRow.id], {
        model: listedRow.id,
        effort: 'max'
      })
      expect(canSetStructuredAgentSessionOption(state, 'effort', 'high')).toBe(true)
    }
  )
})
