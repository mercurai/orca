// A chat at rest, through a registered definition that carries the optional normalizeOptions and
// readOptions callbacks: the generic host feeds them the account's catalog and persists only the
// complete map they return. The callbacks are the shared Codex rules, not stand-ins.

import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import type { AgentSessionModelOption } from '../../../shared/agent-session-wire'
import {
  normalizeCodexServiceTierOptions,
  readCodexServiceTierOptions
} from '../../../shared/codex-service-tier-selection'
import { CLAUDE_STRUCTURED_AGENT } from '../../claude/claude-structured-agent-definition'
import { CODEX_STRUCTURED_AGENT } from '../../codex/codex-structured-agent-definition'
import type { AgentModelCatalogService } from '../agent-model-catalog/agent-model-catalog-service'
import type { StructuredAgentDefinition } from './structured-agent-definition'
import { StructuredAgentRegistry } from './structured-agent-registry'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionAdapterRouter } from './structured-agent-session-adapter-router'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import {
  readStructuredAgentSessionOptions,
  recordStructuredAgentSessionOptionIntent
} from './structured-agent-session-options-read'

// Synthetic ids: the catalog, not Orca, decides which request tier IDs exist.
const FAST_ID = 'Tier.Fast-77a'
const ULTRA_ID = 'Tier.Ultra-9c1'
const STANDARD = { value: 'default', label: 'Standard' }
const MODEL_A = 'synthetic-model-a'
const MODEL_B = 'synthetic-model-b'
const MODEL_C = 'synthetic-model-c'
const UNRELATED = { approvalsReviewer: 'user' }
const AT_REST_KEYS: ReadonlySet<string> = new Set(['model', 'effort', 'fastMode', 'serviceTier'])

const CATALOG_MODELS: AgentSessionModelOption[] = [
  {
    id: MODEL_A,
    label: 'Model A',
    isDefault: true,
    efforts: [],
    serviceTiers: [
      STANDARD,
      { value: FAST_ID, label: 'Fast' },
      { value: ULTRA_ID, label: 'Ultrafast' }
    ]
  },
  { id: MODEL_B, label: 'Model B', isDefault: false, efforts: [], serviceTiers: [STANDARD] },
  { id: MODEL_C, label: 'Model C', isDefault: false, efforts: [] }
]

type CatalogReader = Pick<AgentModelCatalogService, 'read'>

function listedCatalog(models: AgentSessionModelOption[] = CATALOG_MODELS): CatalogReader {
  return { read: vi.fn(async () => ({ origin: 'probe' as const, models, fetchedAt: 1 })) }
}

function unknownCatalog(): CatalogReader {
  return { read: vi.fn(async () => ({ origin: 'unknown' as const })) }
}

function failingCatalog(): CatalogReader {
  return {
    read: vi.fn(async () => {
      throw new Error('catalog unavailable')
    })
  }
}

function fakeAdapter(): StructuredAgentSessionAdapter {
  return {
    acquire: vi.fn(),
    dispatch: vi.fn(),
    cancelTurn: vi.fn(),
    answerPrompt: vi.fn(),
    setOption: vi.fn(),
    compact: vi.fn(),
    changeThreadGoal: vi.fn()
  }
}

/** Codex's agent identity with the shared Codex callbacks registered as its resting rules. */
const CODEX_AT_REST: StructuredAgentDefinition = {
  ...CODEX_STRUCTURED_AGENT,
  capabilities: {
    ...CODEX_STRUCTURED_AGENT.capabilities,
    rewind: false,
    compact: false,
    threadGoal: false
  },
  restingOptions: {
    acceptsKey: (key) => AT_REST_KEYS.has(key),
    fallbackModels: () => null,
    effortDefaultsToModel: false,
    normalizeOptions: normalizeCodexServiceTierOptions,
    readOptions: readCodexServiceTierOptions
  }
}

const CODEX_AGENTS = new StructuredAgentRegistry([
  { definition: CODEX_AT_REST, adapter: fakeAdapter() }
])
const CLAUDE_AGENTS = new StructuredAgentRegistry([
  { definition: CLAUDE_STRUCTURED_AGENT, adapter: fakeAdapter() }
])

function recordWith(
  provider: 'codex' | 'claude',
  options: Readonly<Record<string, string>>
): AgentSessionRecord {
  return { ...agentSessionRecordFixture(), provider, options }
}

async function pick(input: {
  agents: StructuredAgentRegistry
  record: AgentSessionRecord
  modelCatalog?: CatalogReader
  key: string
  value: string
}) {
  const persistOptions = vi.fn(async () => {})
  const publish = vi.fn()
  const result = await recordStructuredAgentSessionOptionIntent(
    {
      store: { getRecord: () => input.record },
      agents: input.agents,
      ...(input.modelCatalog ? { modelCatalog: input.modelCatalog } : {})
    },
    { sessionId: input.record.sessionId, persistOptions, publish },
    { key: input.key, value: input.value }
  )
  return { result, persistOptions, publish }
}

function pickOnCodex(
  options: Readonly<Record<string, string>>,
  modelCatalog: CatalogReader,
  key: string,
  value: string
) {
  return pick({
    agents: CODEX_AGENTS,
    record: recordWith('codex', options),
    modelCatalog,
    key,
    value
  })
}

function readAtRest(
  agents: StructuredAgentRegistry,
  record: AgentSessionRecord,
  modelCatalog?: CatalogReader
) {
  const resting = {
    child: null,
    params: { provider: record.provider },
    journal: { threadGoal: () => null, contextUsage: () => null, context: { floor: () => null } }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resting read touches only these members.
  const context = {
    deps: {
      adapter: new StructuredAgentSessionAdapterRouter(agents, async () => {}),
      agents,
      store: { getRecord: () => record },
      ...(modelCatalog ? { modelCatalog } : {})
    },
    serialize: (_sessionId: string, task: () => Promise<unknown>) => task(),
    openConversation: async () => resting,
    conversation: async () => resting
  } as unknown as StructuredAgentSessionMutationContext
  return readStructuredAgentSessionOptions(context, record.sessionId)
}

const REFUSED = {
  ok: false,
  refusal: { code: 'agent_session_operation_invalid', details: { reason: 'optionRejected' } }
}

describe('a pick at rest on an agent that registers normalizeOptions', () => {
  it('judges the tier against the account catalog and persists the complete map', async () => {
    const catalog = listedCatalog()
    const prior = { model: MODEL_A, effort: 'low', ...UNRELATED }

    const { result, persistOptions, publish } = await pickOnCodex(
      prior,
      catalog,
      'serviceTier',
      ULTRA_ID
    )

    const expected = { ...prior, serviceTier: ULTRA_ID }
    expect(result).toEqual({
      ok: true,
      value: { key: 'serviceTier', value: ULTRA_ID, options: expected }
    })
    expect(persistOptions).toHaveBeenCalledExactlyOnceWith(expected)
    expect(publish).toHaveBeenCalledOnce()
    expect(catalog.read).toHaveBeenCalledWith(expect.objectContaining({ agent: 'codex' }))
  })

  it('refuses a tier a known catalog does not advertise for the model and writes nothing', async () => {
    const { result, persistOptions, publish } = await pickOnCodex(
      { model: MODEL_B, serviceTier: 'default' },
      listedCatalog(),
      'serviceTier',
      ULTRA_ID
    )

    expect(result).toMatchObject(REFUSED)
    expect(persistOptions).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })

  it('refuses a tier for a model whose catalog row carries no tier metadata', async () => {
    const { result, persistOptions } = await pickOnCodex(
      { model: MODEL_C },
      listedCatalog(),
      'serviceTier',
      ULTRA_ID
    )

    expect(result).toMatchObject(REFUSED)
    expect(persistOptions).not.toHaveBeenCalled()
  })

  describe.each([
    { name: 'an unknown catalog', catalog: unknownCatalog },
    { name: 'a catalog read that fails', catalog: failingCatalog }
  ])('with $name', ({ catalog }) => {
    it('refuses a non-default tier it cannot verify, without acknowledging it', async () => {
      const { result, persistOptions } = await pickOnCodex(
        { model: MODEL_A },
        catalog(),
        'serviceTier',
        ULTRA_ID
      )

      expect(result).toMatchObject(REFUSED)
      expect(persistOptions).not.toHaveBeenCalled()
    })

    it('still admits protocol Standard', async () => {
      const { result, persistOptions } = await pickOnCodex(
        { model: MODEL_A, serviceTier: ULTRA_ID },
        catalog(),
        'serviceTier',
        'default'
      )

      expect(result).toMatchObject({ ok: true })
      expect(persistOptions).toHaveBeenCalledExactlyOnceWith({
        model: MODEL_A,
        serviceTier: 'default'
      })
    })
  })

  it('judges a tier against the listed default model when none was picked', async () => {
    const accepted = await pickOnCodex({}, listedCatalog(), 'serviceTier', ULTRA_ID)
    expect(accepted.result).toMatchObject({ ok: true })
    expect(accepted.persistOptions).toHaveBeenCalledExactlyOnceWith({ serviceTier: ULTRA_ID })

    const withoutDefault = listedCatalog(CATALOG_MODELS.map((m) => ({ ...m, isDefault: false })))
    const refused = await pickOnCodex({}, withoutDefault, 'serviceTier', ULTRA_ID)
    expect(refused.result).toMatchObject(REFUSED)
    expect(refused.persistOptions).not.toHaveBeenCalled()
  })

  it('keeps a saved tier the destination model lacks when only the model changes', async () => {
    const prior = { model: MODEL_A, serviceTier: ULTRA_ID, ...UNRELATED }

    const switched = await pickOnCodex(prior, listedCatalog(), 'model', MODEL_B)

    expect(switched.result).toMatchObject({ ok: true })
    const stored = { ...prior, model: MODEL_B }
    expect(switched.persistOptions).toHaveBeenCalledExactlyOnceWith(stored)

    const read = await readAtRest(CODEX_AGENTS, recordWith('codex', stored), listedCatalog())
    expect(read.current).toMatchObject({ model: MODEL_B, serviceTier: ULTRA_ID })
    expect(read.speed).toEqual({ selection: { tierId: ULTRA_ID, state: 'unavailable' } })
  })

  it('keeps a saved tier when only the effort changes', async () => {
    const prior = { model: MODEL_A, effort: 'low', serviceTier: ULTRA_ID }

    const { persistOptions } = await pickOnCodex(prior, listedCatalog(), 'effort', 'high')

    expect(persistOptions).toHaveBeenCalledExactlyOnceWith({ ...prior, effort: 'high' })
  })

  it.each([
    ['true', FAST_ID],
    ['false', 'default']
  ])(
    'lets an explicit old fastMode=%s toggle replace the canonical tier with %s',
    async (fastMode, tier) => {
      const { result, persistOptions } = await pickOnCodex(
        { model: MODEL_A, serviceTier: ULTRA_ID, ...UNRELATED },
        listedCatalog(),
        'fastMode',
        fastMode
      )

      expect(result).toMatchObject({ ok: true })
      expect(persistOptions).toHaveBeenCalledExactlyOnceWith({
        model: MODEL_A,
        serviceTier: tier,
        ...UNRELATED
      })
    }
  )

  it('keeps an old fastMode=true as intent where the model advertises no Fast tier', async () => {
    const { result, persistOptions } = await pickOnCodex(
      { model: MODEL_B, serviceTier: 'default' },
      listedCatalog(),
      'fastMode',
      'true'
    )

    expect(result).toMatchObject({ ok: true })
    expect(persistOptions).toHaveBeenCalledExactlyOnceWith({ model: MODEL_B, fastMode: 'true' })
  })

  it('refuses a malformed old fastMode toggle before touching the saved tier', async () => {
    const { result, persistOptions } = await pickOnCodex(
      { model: MODEL_A, serviceTier: ULTRA_ID },
      listedCatalog(),
      'fastMode',
      'maybe'
    )

    expect(result).toMatchObject(REFUSED)
    expect(persistOptions).not.toHaveBeenCalled()
  })

  it('refuses a key the definition does not accept before consulting the catalog', async () => {
    const catalog = listedCatalog()

    const { result, persistOptions } = await pickOnCodex({}, catalog, 'unlisted', 'x')

    expect(result).toMatchObject(REFUSED)
    expect(persistOptions).not.toHaveBeenCalled()
    expect(catalog.read).not.toHaveBeenCalled()
  })
})

describe('a pick at rest on an agent that registers no callbacks', () => {
  it('merges the pick as given and never reads the catalog', async () => {
    const catalog = listedCatalog()
    const prior = { model: 'sonnet', fastMode: 'true' }

    const { result, persistOptions } = await pick({
      agents: CLAUDE_AGENTS,
      record: recordWith('claude', prior),
      modelCatalog: catalog,
      key: 'effort',
      value: 'high'
    })

    expect(result).toMatchObject({ ok: true })
    expect(persistOptions).toHaveBeenCalledExactlyOnceWith({ ...prior, effort: 'high' })
    expect(catalog.read).not.toHaveBeenCalled()
  })
})

describe('reading a chat at rest through readOptions', () => {
  it('reports the canonical tier and a ready selection', async () => {
    const read = await readAtRest(
      CODEX_AGENTS,
      recordWith('codex', { model: MODEL_A, effort: 'low', serviceTier: ULTRA_ID }),
      listedCatalog()
    )

    expect(read.current).toEqual({ model: MODEL_A, effort: 'low', serviceTier: ULTRA_ID })
    expect(read.speed).toEqual({ selection: { tierId: ULTRA_ID, state: 'ready' } })
    expect(read.models.map((model) => model.id)).toEqual([MODEL_A, MODEL_B, MODEL_C])
  })

  it('migrates a saved fastMode=false to the catalog Standard id for the legacy projection', async () => {
    const read = await readAtRest(
      CODEX_AGENTS,
      recordWith('codex', { model: MODEL_A, fastMode: 'false' }),
      listedCatalog()
    )

    expect(read.current).toEqual({ model: MODEL_A, serviceTier: 'default', fastMode: false })
    expect(read.speed).toEqual({ selection: { tierId: 'default', state: 'ready' } })
  })

  it('names the default model of a real listing and reports no selection for an untouched chat', async () => {
    const read = await readAtRest(CODEX_AGENTS, recordWith('codex', {}), listedCatalog())

    expect(read.current).toEqual({ model: MODEL_A })
    expect(read.speed).toEqual({ selection: { state: 'unselected' } })
  })

  it('marks a saved tier unknown, not unavailable, while the catalog is unknown', async () => {
    const read = await readAtRest(
      CODEX_AGENTS,
      recordWith('codex', { model: MODEL_A, serviceTier: ULTRA_ID }),
      unknownCatalog()
    )

    expect(read.current).toMatchObject({ model: MODEL_A, serviceTier: ULTRA_ID })
    expect(read.speed).toEqual({ selection: { tierId: ULTRA_ID, state: 'unknown' } })
  })

  it('treats protocol Standard as ready even while the catalog is unknown', async () => {
    const read = await readAtRest(
      CODEX_AGENTS,
      recordWith('codex', { model: MODEL_A, serviceTier: 'default' }),
      unknownCatalog()
    )

    expect(read.speed).toEqual({ selection: { tierId: 'default', state: 'ready' } })
  })

  it('reports an unresolved legacy fastMode=true explicitly and invents no tier', async () => {
    const read = await readAtRest(
      CODEX_AGENTS,
      recordWith('codex', { model: MODEL_B, fastMode: 'true' }),
      listedCatalog()
    )

    expect(read.current).toEqual({ model: MODEL_B, fastMode: true })
    expect(read.current).not.toHaveProperty('serviceTier')
    expect(read.speed).toEqual({ selection: { legacyFastMode: true, state: 'unavailable' } })
  })

  it('keeps the provider model and effort over the saved and catalog-derived ones', async () => {
    const agents = new StructuredAgentRegistry([
      {
        definition: {
          ...CODEX_AT_REST,
          restingOptions: {
            ...CODEX_AT_REST.restingOptions,
            readOptions: () => ({ current: { model: MODEL_C, effort: 'provider-effort' } })
          }
        },
        adapter: fakeAdapter()
      }
    ])

    const saved = await readAtRest(
      agents,
      recordWith('codex', { model: MODEL_B, effort: 'low' }),
      listedCatalog()
    )
    expect(saved.current).toEqual({ model: MODEL_C, effort: 'provider-effort' })

    const defaulted = await readAtRest(agents, recordWith('codex', {}), listedCatalog())
    expect(defaulted.current).toEqual({ model: MODEL_C, effort: 'provider-effort' })
  })

  it('leaves Claude with its legacy boolean and no speed facts', async () => {
    const read = await readAtRest(
      CLAUDE_AGENTS,
      recordWith('claude', { model: 'sonnet', fastMode: 'true' })
    )

    expect(read.current).toMatchObject({ model: 'sonnet', fastMode: true })
    expect(read.current).not.toHaveProperty('serviceTier')
    expect(read).not.toHaveProperty('speed')
  })
})
