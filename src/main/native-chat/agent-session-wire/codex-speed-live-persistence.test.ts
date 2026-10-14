// The live option boundary over the real Codex adapter. `performSetOption` lets the adapter change its
// live option map and only then writes the durable record, so a write that fails must not leave the new
// map for the next dispatch: an autonomous or cross-client send would spend a tier nobody acknowledged,
// or send past a refusal whose block was cleared in memory only.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { CODEX_STRUCTURED_AGENT } from '../../codex/codex-structured-agent-definition'
import { refusedCodexServiceTier } from '../../codex/codex-structured-speed-intent'
import type { CodexStructuredSessionAdapter } from '../../codex/codex-structured-session-adapter'
import {
  USER_MESSAGE,
  adapterFor,
  answerWithOpenedTurn,
  fakeCodex,
  identityFor
} from '../../codex/codex-structured-session-adapter-fixture'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { agentModelCatalogSessionAccess } from '../agent-model-catalog/agent-model-catalog-fingerprint'
import { AgentModelCatalogStore } from '../agent-model-catalog/agent-model-catalog-store'
import { claudeAndCodexAgents } from './structured-agent-session-adapter-router-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { performSetOption, type AgentSessionTurnContext } from './structured-agent-session-turns'

const SESSION = 'session-live-persistence'
const FENCE = 7
const ACCOUNT_HOME = '/codex/home'
// The model the fake provider's thread reports, so the catalog row below is the one the session uses.
const MODEL = 'gpt-live'
// Synthetic ids: the catalog decides which tiers exist.
const STANDARD = { value: 'default', label: 'Standard' }
const FAST = { value: 'Tier.Fast-77a', label: 'Fast' }
const ULTRA = { value: 'Tier.Ultra-9c1', label: 'Ultrafast' }
const ACKNOWLEDGED: Readonly<Record<string, string>> = { model: MODEL, serviceTier: FAST.value }
// An option the adapter does not recognise: the record owns it and every rewrite must carry it.
const UNRELATED: Readonly<Record<string, string>> = { unrelatedSavedOption: 'keep-this' }
// What a `turn/start` may name: neither an unrecognised saved option nor a refusal record is among them.
const TURN_START_FIELDS = [
  'threadId',
  'clientUserMessageId',
  'input',
  'model',
  'effort',
  'approvalsReviewer',
  'personality',
  'serviceTier'
]

let root: string | null = null
const journals = createTrackedJournalOpener()

afterEach(async () => {
  await journals.closeAll()
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

/** A live Codex session whose account catalog advertises exactly `tiers`, holding `saved`. The
 *  record's options are what the host's own acquisition read returns for that saved map. */
async function openLiveSession(
  tiers: readonly { value: string; label: string }[],
  saved: Readonly<Record<string, string>> = ACKNOWLEDGED
) {
  const codex = fakeCodex()
  codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'turn-1')
  const modelCatalog = new AgentModelCatalogStore()
  const access = agentModelCatalogSessionAccess(modelCatalog, CODEX_STRUCTURED_AGENT, ACCOUNT_HOME)!
  modelCatalog.recordSuccess(
    access.fingerprint,
    'codex',
    {
      models: [
        { id: MODEL, label: 'GPT Live', isDefault: true, efforts: [], serviceTiers: [...tiers] }
      ],
      fastModeTierByModel: new Map([[MODEL, FAST.value]]),
      origin: 'live-session'
    },
    'discovery'
  )
  const adapter = adapterFor(codex, { codexHome: ACCOUNT_HOME }, [], { modelCatalog })
  await adapter.acquire({
    identity: identityFor(SESSION),
    fence: FENCE,
    spawnToken: 'spawn-1',
    options: saved
  })
  const recorded =
    adapter.readAcquisitionOptions({ sessionId: SESSION, fence: FENCE, priorOptions: saved }) ?? {}
  expect(recorded).toMatchObject(saved)
  return { codex, adapter, recorded }
}

/** The record's options as the durable store holds them; only a write that resolves changes them. */
function durableStore(initial: Readonly<Record<string, string>>): {
  current: () => Readonly<Record<string, string>>
  persistOptions: Mock<AgentSessionTurnContext['persistOptions']>
  publish: Mock<AgentSessionTurnContext['publish']>
} {
  let stored = { ...initial }
  return {
    current: () => stored,
    persistOptions: vi.fn(async (next: Readonly<Record<string, string>>) => {
      stored = { ...next }
    }),
    publish: vi.fn(() => {})
  }
}

/** Every action reads the durable options as they stand then, as a mutation's own context does. */
async function contextFor(
  adapter: CodexStructuredSessionAdapter,
  durable: Pick<ReturnType<typeof durableStore>, 'current' | 'persistOptions' | 'publish'>
): Promise<AgentSessionTurnContext> {
  root ??= await mkdtemp(join(tmpdir(), 'orca-codex-speed-live-persistence-'))
  return {
    logger: createStructuredAgentSessionLogger(),
    sessionId: SESSION,
    journal: await journals.open({ identity: identityFor(SESSION), stateDirectory: root }),
    fence: FENCE,
    adapter,
    agents: claudeAndCodexAgents(adapter),
    agent: 'codex',
    get persistedOptions() {
      return durable.current()
    },
    persistOptions: durable.persistOptions,
    resolvedBy: 'client-1',
    publish: durable.publish,
    now: () => 1
  }
}

function pickTier(ctx: AgentSessionTurnContext, value: string) {
  return performSetOption(ctx, { key: 'serviceTier', value })
}

function dispatchNext(adapter: CodexStructuredSessionAdapter) {
  return adapter.dispatch({
    sessionId: SESSION,
    clientMessageId: 'message-1',
    body: USER_MESSAGE,
    fence: FENCE
  })
}

function turnStarts(codex: Awaited<ReturnType<typeof openLiveSession>>['codex']) {
  return codex.connections
    .flatMap((connection) => connection.calls)
    .filter((call) => call.method === 'turn/start')
}

/** A send the host refused before the wire: a definite rejection, and the provider saw no write. */
function expectRefusedBeforeWire(
  codex: Awaited<ReturnType<typeof openLiveSession>>['codex'],
  outcome: Awaited<ReturnType<typeof dispatchNext>>
): void {
  expect(outcome.state).toBe('rejected')
  expect(turnStarts(codex)).toEqual([])
}

function expectOnlyPublicTurnFields(params: Record<string, unknown> | undefined): void {
  expect(TURN_START_FIELDS).toEqual(expect.arrayContaining(Object.keys(params ?? {})))
}

describe('an explicit expensive tier whose durable write fails', () => {
  async function failedUltra() {
    const session = await openLiveSession([STANDARD, FAST, ULTRA])
    const durable = durableStore(session.recorded)
    const ctx = await contextFor(session.adapter, durable)
    const failure = new Error('disk full')
    durable.persistOptions.mockRejectedValueOnce(failure)

    await expect(pickTier(ctx, ULTRA.value)).rejects.toBe(failure)

    return { ...session, durable, ctx, failure }
  }

  it('propagates the failure, publishes nothing and leaves the durable map at the acknowledged tier', async () => {
    const { durable, recorded } = await failedUltra()

    expect(durable.persistOptions).toHaveBeenCalledOnce()
    expect(durable.publish).not.toHaveBeenCalled()
    expect(durable.current()).toEqual(recorded)
    expect(durable.current()).toMatchObject(ACKNOWLEDGED)
  })

  it('refuses the next dispatch before any write, never spending the unacknowledged tier', async () => {
    const { adapter, codex } = await failedUltra()

    const outcome = await dispatchNext(adapter)

    // Not Ultrafast, and not the previous Fast either: the person's choice has no acknowledged answer.
    expectRefusedBeforeWire(codex, outcome)
  })

  it('reports the acknowledged tier as current beside the blocked request, with no processing claim', async () => {
    const { adapter } = await failedUltra()

    const report = await adapter.readOptions({ sessionId: SESSION, fence: FENCE })

    expect(report.current.serviceTier).toBe(FAST.value)
    expect(report.speed?.selection).toMatchObject({ tierId: ULTRA.value })
    expect(report.speed?.selection.state).not.toBe('ready')
    expect(report.speed?.applied).toBeUndefined()
  })

  it('sends exactly the tier a retried pick durably acknowledges', async () => {
    const { adapter, codex, ctx, durable } = await failedUltra()

    const retried = await pickTier(ctx, ULTRA.value)

    expect(retried).toMatchObject({ ok: true, value: { key: 'serviceTier', value: ULTRA.value } })
    // The block is released with the acknowledgement: no refusal record remains beside the tier.
    expect(durable.current()).toMatchObject({ model: MODEL, serviceTier: ULTRA.value })
    expect(refusedCodexServiceTier(durable.current())).toBeUndefined()
    const outcome = await dispatchNext(adapter)
    expect(outcome.state).toBe('admitted')
    expect(turnStarts(codex).map((call) => call.params?.serviceTier)).toEqual([ULTRA.value])
  })
})

describe('an accepted replacement of a recorded refusal whose durable write fails', () => {
  /** The refusal arrives through the adapter's real unsupported-tier path, not a fabricated map. */
  async function refusedUltra() {
    const session = await openLiveSession([STANDARD, FAST])
    const durable = durableStore(session.recorded)
    const ctx = await contextFor(session.adapter, durable)

    const refused = await pickTier(ctx, ULTRA.value)

    expect(refused).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid', details: { reason: 'optionRejected' } }
    })
    expect(durable.persistOptions).toHaveBeenCalledOnce()
    expect(durable.publish).toHaveBeenCalledOnce()
    // The accepted tier stays canonical; the refused request is remembered beside it.
    expect(durable.current()).toMatchObject(ACKNOWLEDGED)
    expect(refusedCodexServiceTier(durable.current())).toBe(ULTRA.value)
    return { ...session, durable, ctx, refusedRecord: durable.current() }
  }

  it('keeps the recorded refusal durable and publishes nothing more', async () => {
    const { ctx, durable, refusedRecord } = await refusedUltra()
    const failure = new Error('disk full')
    durable.persistOptions.mockRejectedValueOnce(failure)

    // Standard is advertised, so the adapter accepts it and clears its in-memory block.
    await expect(pickTier(ctx, STANDARD.value)).rejects.toBe(failure)

    expect(durable.publish).toHaveBeenCalledOnce()
    expect(durable.current()).toEqual(refusedRecord)
  })

  it('keeps the next dispatch blocked, writing no tier at all', async () => {
    const { adapter, codex, ctx, durable } = await refusedUltra()
    durable.persistOptions.mockRejectedValueOnce(new Error('disk full'))
    await expect(pickTier(ctx, STANDARD.value)).rejects.toThrow('disk full')

    const outcome = await dispatchNext(adapter)

    expectRefusedBeforeWire(codex, outcome)
  })

  it('keeps reporting the acknowledged tier as current beside the still-blocked request', async () => {
    const { adapter, ctx, durable } = await refusedUltra()
    durable.persistOptions.mockRejectedValueOnce(new Error('disk full'))
    await expect(pickTier(ctx, STANDARD.value)).rejects.toThrow('disk full')

    const report = await adapter.readOptions({ sessionId: SESSION, fence: FENCE })

    expect(report.current.serviceTier).toBe(FAST.value)
    expect(report.speed?.selection).toMatchObject({ tierId: ULTRA.value })
    expect(report.speed?.selection.state).not.toBe('ready')
  })

  it('lifts the block only when the replacement is durably acknowledged, then sends it alone', async () => {
    const { adapter, codex, ctx, durable } = await refusedUltra()

    const replaced = await pickTier(ctx, STANDARD.value)

    expect(replaced).toMatchObject({ ok: true })
    expect(durable.current()).toMatchObject({ model: MODEL, serviceTier: STANDARD.value })
    expect(refusedCodexServiceTier(durable.current())).toBeUndefined()
    const outcome = await dispatchNext(adapter)
    expect(outcome.state).toBe('admitted')
    const [start] = turnStarts(codex)
    expect(start?.params).toMatchObject({ serviceTier: STANDARD.value })
    // The remembered refusal is never a request field.
    expect(Object.values(start?.params ?? {})).not.toContain(ULTRA.value)
    expectOnlyPublicTurnFields(start?.params)
  })
})

describe('a saved option the adapter does not recognise, across speed writes', () => {
  const SAVED = { ...ACKNOWLEDGED, ...UNRELATED }

  it('survives an accepted canonical speed write in the complete persisted map', async () => {
    const { adapter, recorded } = await openLiveSession([STANDARD, FAST, ULTRA], SAVED)
    const durable = durableStore(recorded)

    const picked = await pickTier(await contextFor(adapter, durable), ULTRA.value)

    expect(picked).toMatchObject({ ok: true })
    expect(durable.current()).toMatchObject({ model: MODEL, serviceTier: ULTRA.value, ...UNRELATED })
    expect(refusedCodexServiceTier(durable.current())).toBeUndefined()
    expect(durable.current()).not.toHaveProperty('fastMode')
  })

  it('survives a refused custom tier, with the accepted tier canonical and the request blocked', async () => {
    const { adapter, codex, recorded } = await openLiveSession([STANDARD, FAST], SAVED)
    const durable = durableStore(recorded)

    const refused = await pickTier(await contextFor(adapter, durable), ULTRA.value)

    expect(refused).toMatchObject({ ok: false, refusal: { details: { reason: 'optionRejected' } } })
    expect(durable.current()).toMatchObject(SAVED)
    expect(refusedCodexServiceTier(durable.current())).toBe(ULTRA.value)
    expect(durable.current()).not.toHaveProperty('fastMode')
    const report = await adapter.readOptions({ sessionId: SESSION, fence: FENCE })
    expect(report.current.serviceTier).toBe(FAST.value)
    expect(report.speed?.selection).toMatchObject({ tierId: ULTRA.value })
    expectRefusedBeforeWire(codex, await dispatchNext(adapter))
  })

  it('survives an explicit replacement of the refusal, which resurrects neither the old tier nor the record', async () => {
    const { adapter, codex, recorded } = await openLiveSession([STANDARD, FAST], SAVED)
    const durable = durableStore(recorded)
    const ctx = await contextFor(adapter, durable)
    expect(await pickTier(ctx, ULTRA.value)).toMatchObject({ ok: false })

    const replaced = await pickTier(ctx, STANDARD.value)

    expect(replaced).toMatchObject({ ok: true })
    expect(durable.current()).toMatchObject({
      model: MODEL,
      serviceTier: STANDARD.value,
      ...UNRELATED
    })
    expect(refusedCodexServiceTier(durable.current())).toBeUndefined()
    expect(Object.values(durable.current())).not.toContain(ULTRA.value)
    const outcome = await dispatchNext(adapter)
    expect(outcome.state).toBe('admitted')
    const [start] = turnStarts(codex)
    expect(start?.params).toMatchObject({ serviceTier: STANDARD.value })
    expect(start?.params).not.toHaveProperty('unrelatedSavedOption')
    expect(Object.values(start?.params ?? {})).not.toContain(ULTRA.value)
    expectOnlyPublicTurnFields(start?.params)
  })
})
