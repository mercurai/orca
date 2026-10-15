// The complete option map through the production record store: proved at start, picked at rest
// through a registered definition, reloaded from disk, and restored when the provider resumes the
// same conversation. The conversation's provider thread and account home never move.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type {
  AgentSessionModelOption,
  AgentSessionOptionsResult
} from '../../../shared/agent-session-wire'
import {
  normalizeCodexServiceTierOptions,
  readCodexServiceTierOptions
} from '../../../shared/codex-service-tier-selection'
import { CODEX_STRUCTURED_AGENT } from '../../codex/codex-structured-agent-definition'
import type { AgentModelCatalogService } from '../agent-model-catalog/agent-model-catalog-service'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import type { StructuredAgentDefinition } from './structured-agent-definition'
import { StructuredAgentRegistry } from './structured-agent-registry'
import { readNativeSessionOptions } from './structured-agent-session-option-restoration'
import { recordStructuredAgentSessionOptionIntent } from './structured-agent-session-options-read'

const NOW = 1_800_000_000_000
const SESSION = 'session-tier-round-trip'
const MODEL = 'synthetic-model-a'
const ULTRA_ID = 'Tier.Ultra-9c1'
const ACCOUNT_HOME = { variable: 'CODEX_HOME', path: '/accounts/codex' }
const THREAD = 'thread-tier-round-trip'
let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-codex-tier-round-trip-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

const MODELS: AgentSessionModelOption[] = [
  {
    id: MODEL,
    label: 'Model A',
    isDefault: true,
    efforts: [],
    serviceTiers: [
      { value: 'default', label: 'Standard' },
      { value: ULTRA_ID, label: 'Ultrafast' }
    ]
  }
]

const modelCatalog: Pick<AgentModelCatalogService, 'read'> = {
  read: async () => ({ origin: 'probe', models: MODELS, fetchedAt: 1 })
}

const CODEX_AT_REST: StructuredAgentDefinition = {
  ...CODEX_STRUCTURED_AGENT,
  capabilities: {
    ...CODEX_STRUCTURED_AGENT.capabilities,
    rewind: false,
    compact: false,
    threadGoal: false
  },
  restingOptions: {
    acceptsKey: (key) => key === 'serviceTier' || key === 'model' || key === 'fastMode',
    fallbackModels: () => null,
    effortDefaultsToModel: false,
    normalizeOptions: normalizeCodexServiceTierOptions,
    readOptions: readCodexServiceTierOptions
  }
}

const agents = new StructuredAgentRegistry([
  {
    definition: CODEX_AT_REST,
    adapter: {
      acquire: vi.fn(),
      dispatch: vi.fn(),
      cancelTurn: vi.fn(),
      answerPrompt: vi.fn(),
      setOption: vi.fn(),
      compact: vi.fn(),
      changeThreadGoal: vi.fn()
    }
  }
])

/** A Codex record the provider proved at start, reporting Standard on a thread it created. */
async function provenRecord() {
  const store = await openTestAgentSessionRecordStore(directory)
  const reserved = await store.reserveOwner({
    sessionId: SESSION,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    provider: 'codex',
    accountHome: ACCOUNT_HOME,
    expectedFence: null,
    spawnToken: 'spawn-tier',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'indeterminate', reason: 'new session' },
    operation: {
      callerKey: 'client-1',
      operationId: '1800000000000-00000000000000000000000000000000',
      fingerprint: 'tier-create'
    },
    now: NOW
  })
  const fence = reserved.record.lease.runtimeFence
  await store.commitProcessIdentity({
    sessionId: SESSION,
    fence,
    process: { hostId: 'local', pid: 4242, processStartTimeMs: NOW - 1, spawnToken: 'spawn-tier' },
    now: NOW
  })
  const options = await readNativeSessionOptions({
    adapter: {
      readOptions: async () => ({
        models: MODELS,
        current: { model: MODEL, effort: 'low', serviceTier: 'default' }
      })
    },
    sessionId: SESSION,
    fence
  })
  await store.proveOwner({
    sessionId: SESSION,
    fence,
    link: {
      linkId: 'codex-tier-1',
      handle: codexProviderHandle(THREAD),
      origin: 'created',
      mintedAtFence: fence,
      observedAt: NOW
    },
    now: NOW,
    ...(options ? { options } : {})
  })
  return { store, fence }
}

type RecordStore = Awaited<ReturnType<typeof openTestAgentSessionRecordStore>>

function identityOf(record: ReturnType<RecordStore['getRecord']>) {
  return {
    provider: record?.provider,
    accountHome: record?.accountHome,
    providerHandleChain: record?.providerHandleChain
  }
}

/** An at-rest pick, persisted through the production store exactly as a mutation's context does. */
function pickTier(store: RecordStore, fence: number, value: string) {
  return recordStructuredAgentSessionOptionIntent(
    { store, agents, modelCatalog },
    {
      sessionId: SESSION,
      persistOptions: async (options) => {
        await store.replaceSessionOptions({ sessionId: SESSION, fence, options, now: NOW + 1 })
      },
      publish: vi.fn()
    },
    { key: 'serviceTier', value }
  )
}

/** The provider resumes the conversation and reports `current`; the record keeps the restored map. */
async function resumeReporting(
  store: RecordStore,
  fence: number,
  current: AgentSessionOptionsResult['current']
): Promise<void> {
  const priorOptions = store.getRecord(SESSION)?.options
  const restored = await readNativeSessionOptions({
    adapter: { readOptions: async () => ({ models: MODELS, current }) },
    sessionId: SESSION,
    fence,
    ...(priorOptions ? { priorOptions } : {})
  })
  await store.replaceSessionOptions({
    sessionId: SESSION,
    fence,
    options: restored ?? {},
    now: NOW + 2
  })
}

const STANDARD_OPTIONS = { model: MODEL, effort: 'low', serviceTier: 'default' }

describe('a Codex tier pick through the production record store', () => {
  it('stores the reported canonical tier with the owner proof, on disk', async () => {
    await provenRecord()

    const reopened = await openTestAgentSessionRecordStore(directory)

    expect(reopened.getRecord(SESSION)?.options).toEqual(STANDARD_OPTIONS)
  })

  it('persists the complete normalized map on disk and keeps the conversation identity', async () => {
    const { store, fence } = await provenRecord()
    const before = identityOf(store.getRecord(SESSION))

    const picked = await pickTier(store, fence, ULTRA_ID)

    expect(picked).toMatchObject({ ok: true })
    const reopened = await openTestAgentSessionRecordStore(directory)
    expect(reopened.getRecord(SESSION)?.options).toEqual({
      ...STANDARD_OPTIONS,
      serviceTier: ULTRA_ID
    })
    expect(identityOf(reopened.getRecord(SESSION))).toEqual(before)
  })

  it('leaves the stored map untouched when the catalog refuses the pick', async () => {
    const { store, fence } = await provenRecord()

    const refused = await pickTier(store, fence, 'Tier.NotListed-1')

    expect(refused).toMatchObject({ ok: false })
    const reopened = await openTestAgentSessionRecordStore(directory)
    expect(reopened.getRecord(SESSION)?.options).toEqual(STANDARD_OPTIONS)
  })

  describe('when the provider later resumes the same conversation', () => {
    it('keeps the picked tier while the report names none', async () => {
      const { store, fence } = await provenRecord()
      await pickTier(store, fence, ULTRA_ID)
      const before = identityOf(store.getRecord(SESSION))

      await resumeReporting(store, fence, { model: MODEL })

      const reopened = await openTestAgentSessionRecordStore(directory)
      expect(reopened.getRecord(SESSION)?.options).toEqual({
        model: MODEL,
        serviceTier: ULTRA_ID
      })
      expect(identityOf(reopened.getRecord(SESSION))).toEqual(before)
    })

    it('replaces the picked tier only with the one the provider acknowledges', async () => {
      const { store, fence } = await provenRecord()
      await pickTier(store, fence, ULTRA_ID)

      await resumeReporting(store, fence, {
        model: MODEL,
        effort: 'low',
        serviceTier: 'default',
        fastMode: false
      })

      const reopened = await openTestAgentSessionRecordStore(directory)
      expect(reopened.getRecord(SESSION)?.options).toEqual({
        model: MODEL,
        effort: 'low',
        serviceTier: 'default'
      })
    })
  })
})
