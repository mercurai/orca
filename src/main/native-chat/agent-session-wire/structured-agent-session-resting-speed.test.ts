import { structuredAgentSessionOptionOverridesRefusal } from './structured-agent-session-options-read'
import { closeTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { afterEach, describe, expect, it } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { seedTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { createAgentModelCatalogService } from '../agent-model-catalog/agent-model-catalog-service'
import {
  AgentModelCatalogStore,
  type AgentModelCatalogSuccess
} from '../agent-model-catalog/agent-model-catalog-store'
import { agentModelCatalogFingerprint } from '../agent-model-catalog/agent-model-catalog-fingerprint'
import {
  createRestTestRig,
  REST_TEST_CALLER as CALLER,
  REST_TEST_SESSION as SESSION,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import { hostTestOperationId } from './structured-agent-session-host-test-data'

const MODEL = 'synthetic-resting-model'
const TIER = 'synthetic-resting-exact-tier'
const PINNED = '/synthetic/pinned-account-b'
const SELECTED = '/synthetic/current-account-a'
const rigs: RestTestRig[] = []

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.host.close(SESSION, 'evict')
    rig.host.collaboratorsForTests().lifetime.idleSweep.dispose()
    rig.host.stopDelivery()
    await rig.host.flushAllStreamedEvents()
    closeTestJournalHostDatabase(rig.root)
    await rig.dispose()
  }
})

function fingerprint(accountHomePath: string) {
  return agentModelCatalogFingerprint({
    agent: 'codex',
    accountHomeVariable: 'CODEX_HOME',
    accountHomePath,
    wslDistro: null
  })
}

async function resting(options: Record<string, string>, provider: 'codex' | 'claude' = 'codex') {
  const rig = await createRestTestRig()
  rigs.push(rig)
  const record = agentSessionRecordFixture(
    agentSessionLeaseFixture({
      sessionId: SESSION,
      claimStatus: 'released',
      ownerProcess: null,
      deathEvidence: {
        kind: 'exit-observed',
        detail: 'Synthetic released owner',
        observedAt: rig.clock.now
      }
    })
  )
  record.provider = provider
  record.options = options
  if (provider === 'codex') {
    record.accountHome = { variable: 'CODEX_HOME', path: PINNED }
    record.providerHandleChain = record.providerHandleChain.map((link) => ({
      ...link,
      handle: codexProviderHandle('synthetic-resting-thread')
    }))
  }
  await seedTestAgentSessionRecordStore(rig.root, { records: [record] })
  const catalogStore = new AgentModelCatalogStore({ now: () => rig.clock.now })
  const modelCatalog = createAgentModelCatalogService({
    store: catalogStore,
    getRecord: (id) => rig.store.getRecord(id) ?? undefined,
    drivesRecord: () => true,
    resolveAccountHome: async () => ({ variable: 'CODEX_HOME', path: SELECTED })
  })
  await rig.restart({ modelCatalog })
  const pick = (key: string, value: string) => {
    const fields = { key, value }
    return rig.host.setOption(CALLER, {
      ...fields,
      envelope: {
        sessionId: SESSION,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: rig.store.getRecord(SESSION)?.lease.runtimeFence ?? 7,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.setOption',
          sessionId: SESSION,
          fields
        })
      }
    })
  }
  const list = (account = PINNED, tiers = [TIER], model = MODEL) =>
    catalogStore.recordSuccess(
      fingerprint(account),
      'codex',
      {
        models: [
          {
            id: model,
            label: 'Synthetic model',
            isDefault: true,
            efforts: [],
            serviceTiers: tiers.map((value) => ({ value, label: value === TIER ? 'Fast' : value }))
          }
        ],
        origin: 'live-session'
      },
      'discovery'
    )
  return { rig, pick, list, catalogStore, read: () => rig.host.readOptions(SESSION) }
}

describe('Codex speed intent while the provider is at rest', () => {
  it('lets a new legacy Fast pick override an older canonical tier without inventing support', async () => {
    const fixture = await resting({ model: MODEL, serviceTier: 'synthetic-old-tier' })
    expect(await fixture.pick('fastMode', 'true')).toMatchObject({ ok: true })
    expect(fixture.rig.store.getRecord(SESSION)?.options).toMatchObject({ fastMode: 'true' })
    expect(fixture.rig.store.getRecord(SESSION)?.options).not.toHaveProperty('serviceTier')
    expect(await fixture.read()).toMatchObject({
      speed: {
        requested: { legacyFast: true },
        support: 'unknown',
        processing: { status: 'unknown' }
      }
    })
    expect(fixture.rig.adapter.acquire).not.toHaveBeenCalled()
  })

  it('maps a legacy false pick to explicit Standard even without catalog metadata', async () => {
    const fixture = await resting({ model: MODEL, serviceTier: TIER })
    expect(await fixture.pick('fastMode', 'false')).toMatchObject({ ok: true })
    expect(fixture.rig.store.getRecord(SESSION)?.options).toMatchObject({ serviceTier: 'default' })
    expect(fixture.rig.store.getRecord(SESSION)?.options).not.toHaveProperty('fastMode')
    expect(await fixture.read()).toMatchObject({
      speed: {
        requested: { tierId: 'default' },
        support: 'unknown',
        processing: { status: 'unknown' }
      }
    })
    expect(fixture.rig.adapter.acquire).not.toHaveBeenCalled()
  })

  it('removes older legacy intent when a new canonical tier is selected', async () => {
    const fixture = await resting({ model: MODEL, fastMode: 'true' })
    expect(await fixture.pick('serviceTier', TIER)).toMatchObject({ ok: true })
    expect(fixture.rig.store.getRecord(SESSION)?.options).toMatchObject({ serviceTier: TIER })
    expect(fixture.rig.store.getRecord(SESSION)?.options).not.toHaveProperty('fastMode')
    expect(await fixture.read()).toMatchObject({ speed: { requested: { tierId: TIER } } })
    expect(fixture.rig.adapter.acquire).not.toHaveBeenCalled()
  })

  it('gives canonical values precedence when a stored record contains both forms', async () => {
    const fixture = await resting({ model: MODEL, serviceTier: TIER, fastMode: 'false' })
    fixture.list()
    const result = await fixture.read()
    expect(result).toMatchObject({
      speed: {
        requested: { tierId: TIER },
        support: 'available',
        processing: { status: 'unknown' }
      }
    })
    expect(result).not.toHaveProperty('speed.applied')
    expect(fixture.rig.store.getRecord(SESSION)?.options?.serviceTier).toBe(TIER)
    expect(fixture.rig.adapter.acquire).not.toHaveBeenCalled()
  })

  it('uses the pinned account and selected model, preserving unsupported exact-tier intent', async () => {
    const fixture = await resting({ model: MODEL, serviceTier: TIER })
    fixture.list(SELECTED)
    fixture.list(PINNED, [], MODEL)
    fixture.list(PINNED, [TIER], 'synthetic-different-model')
    const result = await fixture.read()
    expect(result).toMatchObject({
      speed: {
        requested: { tierId: TIER },
        support: 'unknown',
        processing: { status: 'unknown' }
      }
    })
    expect(result).not.toHaveProperty('speed.applied')
    expect(fixture.rig.store.getRecord(SESSION)?.options?.serviceTier).toBe(TIER)
    fixture.list(PINNED, [], MODEL)
    expect(await fixture.read()).toMatchObject({
      speed: {
        requested: { tierId: TIER },
        support: 'unavailable'
      }
    })
    expect(fixture.rig.adapter.acquire).not.toHaveBeenCalled()
  })

  it('reports loading from a pending pinned catalog without acquiring a child', async () => {
    const fixture = await resting({ model: MODEL, serviceTier: TIER })
    const pending = Promise.withResolvers<AgentModelCatalogSuccess>()
    const probe = async () => pending.promise
    const listing = fixture.catalogStore.refresh(fingerprint(PINNED), 'codex', probe, probe)
    try {
      expect(await fixture.read()).toMatchObject({
        speed: {
          requested: { tierId: TIER },
          support: 'loading',
          processing: { status: 'unknown' }
        }
      })
      expect(fixture.rig.adapter.acquire).not.toHaveBeenCalled()
    } finally {
      pending.resolve({ models: [], origin: 'probe' })
      await listing
    }
  })

  it('refuses malformed legacy Fast intent without changing saved preferences', async () => {
    const options = { model: MODEL, serviceTier: TIER }
    const fixture = await resting(options)
    expect(await fixture.pick('fastMode', 'maybe')).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_operation_invalid',
        details: { reason: 'optionRejected' }
      }
    })
    expect(fixture.rig.store.getRecord(SESSION)?.options).toEqual(options)
    expect(fixture.rig.adapter.acquire).not.toHaveBeenCalled()
  })

  it('does not claim cached advertised support while its pinned catalog holds a generic failure', async () => {
    const fixture = await resting({ model: MODEL, serviceTier: TIER })
    fixture.list()
    fixture.catalogStore.recordFailure(fingerprint(PINNED), 'Synthetic catalog failure', 'codex')
    expect(await fixture.read()).toMatchObject({
      speed: {
        requested: { tierId: TIER },
        support: 'unknown',
        processing: { status: 'unknown' }
      }
    })
    expect(fixture.rig.store.getRecord(SESSION)?.options?.serviceTier).toBe(TIER)
    expect(fixture.rig.adapter.acquire).not.toHaveBeenCalled()
  })

  it('keeps fresh advertised support available during a gated background refresh', async () => {
    const fixture = await resting({ model: MODEL, serviceTier: TIER })
    fixture.list()
    const pending = Promise.withResolvers<AgentModelCatalogSuccess>()
    const probe = async () => pending.promise
    const listing = fixture.catalogStore.refresh(fingerprint(PINNED), 'codex', probe, probe)
    try {
      expect(await fixture.read()).toMatchObject({
        speed: {
          requested: { tierId: TIER },
          support: 'available',
          processing: { status: 'unknown' }
        }
      })
      expect(fixture.rig.store.getRecord(SESSION)?.options?.serviceTier).toBe(TIER)
      expect(fixture.rig.adapter.acquire).not.toHaveBeenCalled()
    } finally {
      pending.resolve({ models: [], origin: 'probe' })
      await listing
    }
  })

  it('rejects malformed initial overrides through the registered provider rules', async () => {
    const saved = { model: MODEL, serviceTier: TIER }
    const fixture = await resting(saved)
    expect(
      structuredAgentSessionOptionOverridesRefusal(fixture.rig.host.deps.agents, 'codex', {
        model: MODEL,
        fastMode: 'maybe'
      })
    ).toMatchObject({
      code: 'agent_session_operation_invalid',
      details: { reason: 'optionRejected' }
    })
    expect(fixture.rig.store.getRecord(SESSION)?.options).toEqual(saved)
    expect(fixture.rig.adapter.acquire).not.toHaveBeenCalled()
  })

  it('reads a restored legacy false preference as explicit Standard without a catalog', async () => {
    const fixture = await resting({ model: MODEL, fastMode: 'false' })
    expect(await fixture.read()).toMatchObject({
      speed: {
        requested: { tierId: 'default' },
        support: 'unknown',
        processing: { status: 'unknown' }
      }
    })
    expect(fixture.rig.adapter.acquire).not.toHaveBeenCalled()
  })

  it('resolves restored legacy Fast to its fresh advertised exact request ID', async () => {
    const fixture = await resting({ model: MODEL, fastMode: 'true' })
    fixture.list()
    expect(await fixture.read()).toMatchObject({
      speed: {
        requested: { tierId: TIER },
        support: 'available',
        processing: { status: 'unknown' }
      }
    })
    expect(fixture.rig.adapter.acquire).not.toHaveBeenCalled()
  })

  it('keeps Claude legacy Fast controls unchanged', async () => {
    const fixture = await resting({ model: 'synthetic-claude-model', fastMode: 'false' }, 'claude')
    expect(await fixture.pick('fastMode', 'true')).toMatchObject({ ok: true })
    expect(fixture.rig.store.getRecord(SESSION)?.options).toMatchObject({ fastMode: 'true' })
    expect(await fixture.read()).toMatchObject({ current: { fastMode: true } })
    expect(await fixture.read()).not.toHaveProperty('speed')
    expect(fixture.rig.adapter.acquire).not.toHaveBeenCalled()
  })
})
