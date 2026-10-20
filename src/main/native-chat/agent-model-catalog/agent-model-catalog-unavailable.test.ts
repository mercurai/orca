import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import { agentModelCatalogFingerprint } from './agent-model-catalog-fingerprint'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import {
  agentsWithChangedLaunchSettings,
  createAgentModelCatalogSettingsExpiry,
  expireAgentModelCatalogsForSettings
} from './agent-model-catalog-account-expiry'
import {
  AGENT_MODEL_CATALOG_FAILURE_TTL_MS,
  AgentModelCatalogStore,
  type AgentModelCatalogProbe,
  type AgentModelCatalogSuccess
} from './agent-model-catalog-store'
import { AgentModelCatalogUnavailableError } from './agent-model-catalog-unavailable'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import type { AgentSessionAccountHome } from '../../../shared/agent-session-account-home'

// Why a chat cannot start, as the probe found it: the reason rides every catalog answer until a
// later probe answers again, and a chat's own listing never replaces it.

const HOME = '/homes/selected'
const ACCOUNT_HOME = { variable: 'CODEX_HOME', path: HOME } as const
const FINGERPRINT = agentModelCatalogFingerprint({
  agent: 'codex',
  accountHomeVariable: 'CODEX_HOME',
  accountHomePath: HOME,
  wslDistro: null
})
const SIGNED_OUT = { reason: 'notSignedIn', account: 'system' } as const

function listing(id: string, origin: AgentModelCatalogSuccess['origin']): AgentModelCatalogSuccess {
  return {
    models: [{ id, label: id, isDefault: true, efforts: [] }],
    origin
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const signedOut = (): Promise<AgentModelCatalogSuccess> =>
  Promise.reject(new AgentModelCatalogUnavailableError(SIGNED_OUT))

function rig(initialProbe: AgentModelCatalogProbe = signedOut) {
  let now = 1_000
  let answer = initialProbe
  const store = new AgentModelCatalogStore({ now: () => now })
  const probe = vi.fn((home: AgentSessionAccountHome, options?: { signal?: AbortSignal }) =>
    answer(home, options)
  )
  const service = createAgentModelCatalogService({
    store,
    getRecord: () => undefined,
    drivesRecord: () => true,
    resolveAccountHome: async () => ACCOUNT_HOME,
    probes: { codex: probe }
  })
  const chat = { store, fingerprint: FINGERPRINT, accountHomePath: HOME }
  return {
    store,
    probe,
    service,
    chat,
    /** Lets the probe's verdict land. */
    probed: () => store.refresh(FINGERPRINT, 'codex', probe, () => probe(ACCOUNT_HOME)),
    answerWith: (next: AgentModelCatalogProbe) => (answer = next),
    pastTtl: () => (now += AGENT_MODEL_CATALOG_FAILURE_TTL_MS)
  }
}

function unavailableOf(result: AgentSessionModelCatalogResult) {
  return result.unavailable
}

describe('a reason the probe found', () => {
  it("survives the chat's own listing, success or failure; only a probe success clears it", async () => {
    const { store, chat, probed, answerWith, service } = rig()
    await probed()
    // A signed-out Codex still answers model/list for a live chat.
    await store.refresh(FINGERPRINT, 'codex', chat, async () => listing('gpt-live', 'live-session'))
    expect(unavailableOf(await service.read({ agent: 'codex' }))).toEqual(SIGNED_OUT)
    await store.refresh(FINGERPRINT, 'codex', { ...chat }, () =>
      Promise.reject(new Error('401 Unauthorized'))
    )
    store.recordFailure(FINGERPRINT, 'codex model listing failed')
    expect(unavailableOf(await service.read({ agent: 'codex' }))).toEqual(SIGNED_OUT)

    answerWith(async () => listing('gpt-probe', 'probe'))
    await probed()
    const result = await service.read({ agent: 'codex' })
    expect(result).not.toHaveProperty('unavailable')
    expect(result.origin).toBe('probe')
  })

  it('is replaced by a probe failure that names no reason', async () => {
    const { store, probed, answerWith } = rig()
    await probed()
    answerWith(() => Promise.reject(new Error('codex probe timed out')))
    await probed()
    expect(store.failure(FINGERPRINT)).not.toHaveProperty('unavailable')
  })

  it("stays readable past its TTL, whoever asks whether it's active", async () => {
    const { store, probed, pastTtl } = rig()
    await probed()
    pastTtl()
    // The live-chat background catalog skips on this check.
    expect(store.hasActiveFailure(FINGERPRINT)).toBe(false)
    expect(store.failure(FINGERPRINT)?.unavailable).toEqual(SIGNED_OUT)
  })

  it('is expired, not dropped, by a change to that agent’s account settings', async () => {
    const { store, probed } = rig()
    await probed()
    expireAgentModelCatalogsForSettings(store, { activeClaudeManagedAccountId: 'other' })
    expect(store.hasActiveFailure(FINGERPRINT)).toBe(true)
    expireAgentModelCatalogsForSettings(store, { activeCodexManagedAccountId: 'other' })
    expect(store.hasActiveFailure(FINGERPRINT)).toBe(false)
    expect(store.failure(FINGERPRINT)?.unavailable).toEqual(SIGNED_OUT)
  })
})

describe('a probe that lists models but finds the account signed out', () => {
  it('keeps the list for the picker and the reason beside it', async () => {
    const { store, probed, service } = rig(async () => ({
      ...listing('gpt-gateway', 'probe'),
      unavailable: SIGNED_OUT
    }))
    await probed()
    expect(store.get(FINGERPRINT)?.models.map((model) => model.id)).toEqual(['gpt-gateway'])
    expect(await service.read({ agent: 'codex' })).toMatchObject({
      origin: 'probe',
      models: [{ id: 'gpt-gateway' }],
      unavailable: SIGNED_OUT
    })
  })
})

describe('a chat that starts under the account', () => {
  it('makes a held reason due, so the next read re-probes instead of trusting it', async () => {
    const { store, probe, probed, answerWith, service } = rig()
    await probed()
    service.providerStarted({
      ...agentSessionRecordFixture(),
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: HOME },
      location: {
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        wslDistro: null,
        workspaceId: 'workspace',
        workspaceKind: 'folder'
      }
    })
    expect(store.hasActiveFailure(FINGERPRINT)).toBe(false)
    answerWith(async () => listing('gpt-live', 'probe'))
    expect(await service.read({ agent: 'codex', waitForListing: true })).not.toHaveProperty(
      'unavailable'
    )
    expect(probe).toHaveBeenCalledTimes(2)
  })
})

describe('an expired failure that carries no reason', () => {
  it('is dropped, so failures cannot pile up', () => {
    const { store, pastTtl } = rig()
    store.recordFailure(FINGERPRINT, 'listing timed out', 'codex')
    pastTtl()
    expect(store.hasActiveFailure(FINGERPRINT)).toBe(false)
    expect(store.failure(FINGERPRINT)).toBeNull()
    store.recordFailure(FINGERPRINT, 'listing timed out', 'codex')
    expireAgentModelCatalogsForSettings(store, { activeCodexManagedAccountId: 'other' })
    expect(store.failure(FINGERPRINT)).toBeNull()
  })
})

describe('a catalog read that finds a held reason', () => {
  it('serves it from memory inside the TTL, with no new probe', async () => {
    const { probe, probed, service } = rig()
    await probed()
    expect(await service.read({ agent: 'codex', waitForListing: true })).toEqual({
      origin: 'unknown',
      catalogState: 'unknown',
      unavailable: SIGNED_OUT
    })
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('past the TTL, serves it at once and starts one probe; a waiting read gets its answer', async () => {
    const { store, probe, probed, pastTtl, answerWith, service } = rig()
    await probed()
    store.recordSuccess(FINGERPRINT, 'codex', listing('gpt-live', 'live-session'), 'live')
    pastTtl()
    const signIn = deferred<AgentModelCatalogSuccess>()
    answerWith(() => signIn.promise)

    const plain = await service.read({ agent: 'codex' })
    expect(plain).toMatchObject({ origin: 'live-session', listingInProgress: true })
    expect(plain.unavailable).toEqual(SIGNED_OUT)
    const waited = service.read({ agent: 'codex', waitForListing: true })
    expect(probe).toHaveBeenCalledTimes(2)

    signIn.resolve(listing('gpt-probe', 'probe'))
    const answer = await waited
    expect(answer).not.toHaveProperty('unavailable')
    expect(answer).not.toHaveProperty('listingInProgress')
    expect(answer.origin).toBe('probe')
  })

  it.each([
    ['still signed out', signedOut, SIGNED_OUT],
    ['a probe that timed out', () => Promise.reject(new Error('timed out')), undefined]
  ] as const)('a waiting read past the TTL answers %s', async (_case, next, expected) => {
    const { probed, pastTtl, answerWith, service } = rig()
    await probed()
    pastTtl()
    answerWith(next)
    expect(unavailableOf(await service.read({ agent: 'codex', waitForListing: true }))).toEqual(
      expected
    )
  })

  it('re-probes on the next read after an account change, inside the old TTL', async () => {
    const { store, probe, probed, answerWith, service } = rig()
    await probed()
    answerWith(async () => listing('gpt-new-account', 'probe'))
    expireAgentModelCatalogsForSettings(store, { codexManagedAccounts: [] })
    const answer = await service.read({ agent: 'codex', waitForListing: true })
    expect(probe).toHaveBeenCalledTimes(2)
    expect(answer).not.toHaveProperty('unavailable')
  })

  it('never holds a read that does not ask to wait, even on a probe that hangs', async () => {
    const { probed, pastTtl, answerWith, service } = rig()
    await probed()
    pastTtl()
    answerWith(() => new Promise<AgentModelCatalogSuccess>(() => {}))
    expect(await service.read({ agent: 'codex' })).toEqual({
      origin: 'unknown',
      catalogState: 'loading',
      listingInProgress: true,
      unavailable: SIGNED_OUT
    })
  })
})

describe('a probe the host stops', () => {
  it('leaves a held reason as it was', async () => {
    const { store, service, probed, answerWith, pastTtl } = rig()
    await probed()
    pastTtl()
    answerWith(
      (_home, options) =>
        new Promise((_resolve, reject) =>
          options?.signal?.addEventListener('abort', () => reject(new Error('session stopped')))
        )
    )
    await service.read({ agent: 'codex' })
    service.stop()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.failure(FINGERPRINT)?.unavailable).toEqual(SIGNED_OUT)
    expect(store.hasActiveFailure(FINGERPRINT)).toBe(false)
  })
})

describe('a prewarm probe', () => {
  it('sets and clears the reason as a read’s probe does, re-checking it however fresh the catalog', async () => {
    const { store, probe, service, answerWith, pastTtl } = rig(async () => ({
      ...listing('gpt-gateway', 'probe'),
      unavailable: SIGNED_OUT
    }))
    // A saved catalog marks the agent as used here.
    store.recordSuccess(FINGERPRINT, 'codex', listing('gpt-live', 'live-session'), 'live')
    await service.prewarm()
    expect(store.failure(FINGERPRINT)?.unavailable).toEqual(SIGNED_OUT)
    answerWith(async () => listing('gpt-probe', 'probe'))
    await service.prewarm()
    expect(probe).toHaveBeenCalledTimes(1)
    pastTtl()
    expect(store.isStale(store.get(FINGERPRINT)!)).toBe(false)
    await service.prewarm()
    expect(probe).toHaveBeenCalledTimes(2)
    expect(store.failure(FINGERPRINT)).toBeNull()
  })
})

describe("an agent's command or environment change", () => {
  it('re-lists its fresh catalog and re-checks a held "not installed" at the next prewarm', async () => {
    const { store, probe, service, probed, answerWith } = rig(() =>
      Promise.reject(new AgentModelCatalogUnavailableError({ reason: 'cliMissing' }))
    )
    store.recordSuccess(FINGERPRINT, 'codex', listing('gpt-saved', 'probe'), 'discovery')
    await probed()
    expect(store.failure(FINGERPRINT)?.unavailable).toEqual({ reason: 'cliMissing' })
    await service.prewarm()
    expect(probe).toHaveBeenCalledTimes(1)
    const expire = createAgentModelCatalogSettingsExpiry(store, { agentCmdOverrides: {} })
    const fixed = { agentCmdOverrides: { codex: '/opt/codex/bin/codex' } }
    expire(fixed, fixed)
    answerWith(async () => listing('gpt-new', 'probe'))
    await service.prewarm()
    expect(probe).toHaveBeenCalledTimes(2)
    expect(store.failure(FINGERPRINT)).toBeNull()
    expect(store.get(FINGERPRINT)!.models.map((model) => model.id)).toEqual(['gpt-new'])
    // The new listing is the fresh one: nothing is due until the next change.
    await service.prewarm()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('touches only the agents whose command or env changed', () => {
    expect(
      agentsWithChangedLaunchSettings(
        {
          agentCmdOverrides: { codex: 'codex', claude: 'claude' },
          agentDefaultEnv: { claude: { A: '1', B: '2' } }
        },
        {
          agentCmdOverrides: { codex: 'codex', claude: 'claude' },
          agentDefaultEnv: { claude: { B: '2', A: '1' }, pi: { KEY: 'x' } }
        }
      )
    ).toEqual(['pi'])
    expect(agentsWithChangedLaunchSettings({ agentCmdOverrides: { codex: 'codex' } }, {})).toEqual([
      'codex'
    ])
  })
})

describe('a managed account reauthenticated in the same home', () => {
  it('does not let a pre-change pending probe certify the reauthenticated account', async () => {
    const oldProbe = deferred<AgentModelCatalogSuccess>()
    const { store, service, probed } = rig(() => oldProbe.promise)
    store.recordSuccess(FINGERPRINT, 'codex', listing('synthetic-old-model', 'probe'), 'discovery')
    const pending = probed()
    const expire = createAgentModelCatalogSettingsExpiry(store, {})
    expire({ activeCodexManagedAccountId: 'reauthenticated-account' }, {})
    oldProbe.resolve(listing('synthetic-old-model', 'probe'))
    await pending
    const entry = store.get(FINGERPRINT)
    if (!entry) {
      throw new Error('Expected the retained account catalog')
    }
    expect(store.isStale(entry, 'latest')).toBe(true)
    expect(await service.read({ agent: 'codex', savedOnly: true })).toMatchObject({
      catalogState: 'unknown'
    })
  })

  it('holds the old catalog unknown until a fresh account probe answers', async () => {
    const { store, probe, service, answerWith } = rig()
    const saved = listing('synthetic-model', 'probe')
    saved.models[0].serviceTiers = [{ value: 'synthetic-paid-id', label: 'Fast' }]
    store.recordSuccess(FINGERPRINT, 'codex', saved, 'discovery')
    expect(await service.read({ agent: 'codex', savedOnly: true })).toMatchObject({
      catalogState: 'available'
    })
    const expire = createAgentModelCatalogSettingsExpiry(store, {})
    expire(
      {
        codexManagedAccounts: [
          {
            id: 'same-account',
            email: 'reauthenticated@example.test',
            managedHomePath: HOME,
            providerAccountId: 'new-principal',
            workspaceLabel: null,
            workspaceAccountId: null,
            createdAt: 1,
            updatedAt: 2,
            lastAuthenticatedAt: 2
          }
        ]
      },
      {}
    )
    const entry = store.get(FINGERPRINT)
    expect(entry).not.toBeNull()
    if (!entry) {
      throw new Error('Expected the retained same-home catalog')
    }
    expect(store.isStale(entry, 'latest')).toBe(true)
    expect(await service.read({ agent: 'codex', savedOnly: true })).toMatchObject({
      catalogState: 'unknown',
      models: [{ id: 'synthetic-model' }]
    })
    const fresh = deferred<AgentModelCatalogSuccess>()
    answerWith(() => fresh.promise)
    const warming = service.prewarm()
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
    expect(await service.read({ agent: 'codex', savedOnly: true })).toMatchObject({
      catalogState: 'loading'
    })
    fresh.resolve(listing('synthetic-new-principal-model', 'probe'))
    await warming
    expect(await service.read({ agent: 'codex', savedOnly: true })).toMatchObject({
      catalogState: 'available',
      models: [{ id: 'synthetic-new-principal-model' }]
    })
    expect(probe.mock.calls[0]?.[0]).toEqual(ACCOUNT_HOME)
  })
})
