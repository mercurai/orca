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
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  claudeAndCodexAgents,
  claudeAndCodexRouter
} from './structured-agent-session-adapter-router-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { performSetOption, type AgentSessionTurnContext } from './structured-agent-session-turns'
import { codexFastTierId } from '../../../shared/codex-service-tier-selection'

const SESSION = 'session-live-persistence'
const FENCE = 7
const ACCOUNT_HOME = '/codex/home'
// The model the fake provider's thread reports, so the catalog row below is the one the session uses.
const MODEL = 'gpt-live'
const OTHER_MODEL = 'gpt-live-other'
// The fake thread reports `medium`; `high` is the effort a test may switch to.
const EFFORTS = [
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
]
// Synthetic ids: the catalog decides which tiers exist.
const STANDARD = { value: 'default', label: 'Standard' }
const FAST = { value: 'Tier.Fast-77a', label: 'Fast' }
const ULTRA = { value: 'Tier.Ultra-9c1', label: 'Ultrafast' }
const ACKNOWLEDGED: Readonly<Record<string, string>> = { model: MODEL, serviceTier: FAST.value }
const ACKNOWLEDGED_STANDARD: Readonly<Record<string, string>> = {
  model: MODEL,
  serviceTier: STANDARD.value
}
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
 *  record's options are what the host's own acquisition read returns for that saved map. It is
 *  acquired through a router over the real adapter, so a test picks which of the two its
 *  mutations go through; reads and sends always use the adapter itself. `alternatives` adds
 *  efforts to the row and a second model, so an effort or model write is accepted by the adapter.
 *  The legacy Fast map is derived from the same rows, so a row with no Fast tier never names one. */
async function openLiveSession(
  tiers: readonly { value: string; label: string }[],
  saved: Readonly<Record<string, string>> = ACKNOWLEDGED,
  alternatives = false
) {
  const codex = fakeCodex()
  codex.routes['turn/start'] = answerWithOpenedTurn(codex, 'turn-1')
  const modelCatalog = new AgentModelCatalogStore()
  const access = agentModelCatalogSessionAccess(modelCatalog, CODEX_STRUCTURED_AGENT, ACCOUNT_HOME)!
  const fastTierId = codexFastTierId(tiers)
  modelCatalog.recordSuccess(
    access.fingerprint,
    'codex',
    {
      models: [
        {
          id: MODEL,
          label: 'GPT Live',
          isDefault: true,
          efforts: alternatives ? EFFORTS : [],
          ...(alternatives ? { defaultEffort: 'medium' } : {}),
          serviceTiers: [...tiers]
        },
        ...(alternatives
          ? [
              {
                id: OTHER_MODEL,
                label: 'GPT Other',
                isDefault: false,
                efforts: [],
                serviceTiers: [...tiers]
              }
            ]
          : [])
      ],
      fastModeTierByModel: new Map<string, string>(fastTierId ? [[MODEL, fastTierId]] : []),
      origin: 'live-session'
    },
    'discovery'
  )
  const adapter = adapterFor(codex, { codexHome: ACCOUNT_HOME }, [], { modelCatalog })
  const router = claudeAndCodexRouter({ claude: adapter, codex: adapter }, async () => {})
  await router.acquire({
    identity: identityFor(SESSION),
    fence: FENCE,
    spawnToken: 'spawn-1',
    options: saved
  })
  const recorded =
    adapter.readAcquisitionOptions({ sessionId: SESSION, fence: FENCE, priorOptions: saved }) ?? {}
  expect(recorded).toMatchObject(saved)
  return { codex, adapter, router, recorded }
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
  adapter: StructuredAgentSessionAdapter,
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

describe('the same failed durable write through the adapter router', () => {
  const failure = new Error('disk full')

  /** An explicit expensive tier accepted live whose write is then refused by the store. */
  async function failedUltraThroughRouter() {
    const session = await openLiveSession([STANDARD, FAST, ULTRA])
    const durable = durableStore(session.recorded)
    const ctx = await contextFor(session.router, durable)
    durable.persistOptions.mockRejectedValueOnce(failure)

    await expect(pickTier(ctx, ULTRA.value)).rejects.toBe(failure)

    return { ...session, durable, ctx }
  }

  it('restores the acknowledged tier and blocks the request, as the adapter alone does', async () => {
    const { adapter, codex, durable } = await failedUltraThroughRouter()

    expect(durable.publish).not.toHaveBeenCalled()
    expectRefusedBeforeWire(codex, await dispatchNext(adapter))
    const report = await adapter.readOptions({ sessionId: SESSION, fence: FENCE })
    expect(report.current.serviceTier).toBe(FAST.value)
    expect(report.speed?.selection).toMatchObject({ tierId: ULTRA.value })
    expect(report.speed?.selection.state).not.toBe('ready')
  })

  it('leaves a replacement child alone when the failed write began under an earlier fence', async () => {
    const { adapter, codex, router, recorded } = await openLiveSession([STANDARD, FAST, ULTRA])
    const durable = durableStore(recorded)
    expect(await pickTier(await contextFor(router, durable), ULTRA.value)).toMatchObject({
      ok: true
    })

    router.recoverFailedOptionPersistence({
      sessionId: SESSION,
      fence: FENCE - 1,
      key: 'serviceTier',
      value: STANDARD.value,
      priorOptions: recorded
    })

    const report = await adapter.readOptions({ sessionId: SESSION, fence: FENCE })
    expect(report.current.serviceTier).toBe(ULTRA.value)
    expect((await dispatchNext(adapter)).state).toBe('admitted')
    expect(turnStarts(codex).map((call) => call.params?.serviceTier)).toEqual([ULTRA.value])
  })

  it('answers for a session no live owner holds without throwing', async () => {
    const { router } = await openLiveSession([STANDARD, FAST])

    expect(() =>
      router.recoverFailedOptionPersistence({
        sessionId: 'session-never-routed',
        fence: FENCE,
        key: 'serviceTier',
        value: FAST.value,
        priorOptions: {}
      })
    ).not.toThrow()
  })

  describe('when the restore itself fails', () => {
    // Reading the record throws, as a corrupt copy would, after the live map took the unsaved tier.
    const unreadable = new Proxy<Record<string, string>>(
      {},
      {
        ownKeys: () => {
          throw new Error('record unreadable')
        }
      }
    )

    async function liveWithUnsavedUltra(alternatives = false) {
      const session = await openLiveSession([STANDARD, FAST, ULTRA], ACKNOWLEDGED, alternatives)
      await session.router.setOption({
        sessionId: SESSION,
        key: 'serviceTier',
        value: ULTRA.value,
        fence: FENCE
      })
      expect(() =>
        session.router.recoverFailedOptionPersistence({
          sessionId: SESSION,
          fence: FENCE,
          key: 'serviceTier',
          value: ULTRA.value,
          priorOptions: unreadable
        })
      ).toThrow('record unreadable')
      return session
    }

    it('keeps new turns refused rather than spending the unsaved tier', async () => {
      const { adapter, codex } = await liveWithUnsavedUltra()

      expectRefusedBeforeWire(codex, await dispatchNext(adapter))
    })

    it('still sends into the running turn, which carries no speed', async () => {
      const { adapter, codex, router } = await openLiveSession([STANDARD, FAST, ULTRA])
      expect((await dispatchNext(adapter)).state).toBe('admitted')
      await router.setOption({
        sessionId: SESSION,
        key: 'serviceTier',
        value: ULTRA.value,
        fence: FENCE
      })
      expect(() =>
        router.recoverFailedOptionPersistence({
          sessionId: SESSION,
          fence: FENCE,
          key: 'serviceTier',
          value: ULTRA.value,
          priorOptions: unreadable
        })
      ).toThrow('record unreadable')

      const steered = await adapter.dispatch({
        sessionId: SESSION,
        clientMessageId: 'message-2',
        body: USER_MESSAGE,
        fence: FENCE
      })

      expect(steered.state).toBe('admitted')
      expect(turnStarts(codex)).toHaveLength(1)
    })

    it('reports the storage failure, not the restore failure, from the mutation', async () => {
      const { router, recorded } = await liveWithUnsavedUltra()
      const durable = durableStore(recorded)
      const ctx = await contextFor(router, durable)
      durable.persistOptions.mockRejectedValueOnce(failure)
      vi.spyOn(router, 'recoverFailedOptionPersistence').mockImplementationOnce(() => {
        throw new Error('restore failed')
      })

      await expect(pickTier(ctx, STANDARD.value)).rejects.toBe(failure)

      expect(durable.publish).not.toHaveBeenCalled()
    })

    it('lifts the quarantine only for an accepted speed pick that is durably saved', async () => {
      const { adapter, codex, router, recorded } = await liveWithUnsavedUltra()
      const durable = durableStore(recorded)

      const replaced = await pickTier(await contextFor(router, durable), STANDARD.value)

      expect(replaced).toMatchObject({ ok: true })
      expect((await dispatchNext(adapter)).state).toBe('admitted')
      expect(turnStarts(codex).map((call) => call.params?.serviceTier)).toEqual([STANDARD.value])
    })

    it('restores the record and blocks that pick when it is not saved either', async () => {
      const { adapter, codex, router, recorded } = await liveWithUnsavedUltra()
      const durable = durableStore(recorded)
      durable.persistOptions.mockRejectedValueOnce(failure)

      await expect(pickTier(await contextFor(router, durable), STANDARD.value)).rejects.toBe(
        failure
      )

      // Restored to the record, with the unsaved Standard kept as the blocked request.
      expectRefusedBeforeWire(codex, await dispatchNext(adapter))
      const report = await adapter.readOptions({ sessionId: SESSION, fence: FENCE })
      expect(report.current.serviceTier).toBe(FAST.value)
      expect(report.speed?.selection).toMatchObject({ tierId: STANDARD.value })
    })

    /** What a read and the next send must say while the live Ultrafast has no readable record behind
     *  it: it is the person's blocked request, never stored, never ready, never claimed as applied.
     *  `stored` is the tier the record verifiably holds; with an unreadable record none can be named. */
    async function expectUltraRequestedNotStored(
      session: LiveSession,
      stored: string | undefined
    ): Promise<void> {
      const report = await session.adapter.readOptions({ sessionId: SESSION, fence: FENCE })
      const selection = report.speed?.selection
      expect(report.current.serviceTier).toBe(stored)
      expect(report.current.model).toBe(MODEL)
      expect(report.current.effort).not.toBe('high')
      expect(selection).toMatchObject({ tierId: ULTRA.value })
      expect(['unknown', 'unavailable']).toContain(selection?.state)
      expect(report.speed?.applied).toBeUndefined()
      expect(report.speed?.processing).toBeUndefined()
      expectRefusedBeforeWire(session.codex, await dispatchNext(session.adapter))
    }

    it('reads the unsaved tier as a blocked request, not as the stored or ready speed', async () => {
      const session = await liveWithUnsavedUltra()

      await expectUltraRequestedNotStored(session, undefined)
    })

    /** The unsaved tier, then a valid model or effort write the store also refuses, with the record
     *  readable this time and still holding the saved map the failed picks started from. */
    async function laterWriteFailsToSave(pick: { key: string; value: string }) {
      // Alternatives, so the adapter accepts the pick and only the store refuses it.
      const session = await liveWithUnsavedUltra(true)
      const durable = durableStore(session.recorded)
      const later = new Error('disk full again')
      durable.persistOptions.mockRejectedValueOnce(later)

      await expect(
        performSetOption(await contextFor(session.router, durable), pick)
      ).rejects.toBe(later)

      expect(durable.persistOptions).toHaveBeenCalledOnce()
      expect(durable.publish).not.toHaveBeenCalled()
      expect(durable.current()).toEqual(session.recorded)
      return session
    }

    it('keeps the unsaved tier as the request when a later effort write fails to save', async () => {
      const session = await laterWriteFailsToSave({ key: 'effort', value: 'high' })

      // The restore now succeeds, so the record's own tier is current beside the kept request.
      await expectUltraRequestedNotStored(session, FAST.value)
    })

    it('does not save the unsaved tier when a later effort write succeeds, even after reacquire', async () => {
      const { adapter, codex, router, recorded } = await liveWithUnsavedUltra(true)
      const durable = durableStore(recorded)

      const saved = await performSetOption(await contextFor(router, durable), {
        key: 'effort',
        value: 'high'
      })

      expect(saved).toMatchObject({ ok: true })
      expect(durable.current()).toMatchObject({ model: MODEL, serviceTier: FAST.value, effort: 'high' })
      const report = await adapter.readOptions({ sessionId: SESSION, fence: FENCE })
      expect(report.current.serviceTier).toBe(FAST.value)
      expect(report.speed?.selection).toMatchObject({ tierId: ULTRA.value })
      expect(report.speed?.selection.state).not.toBe('ready')
      expectRefusedBeforeWire(codex, await dispatchNext(adapter))
      const again = await openLiveSession([STANDARD, FAST, ULTRA], durable.current(), true)
      const reread = await again.adapter.readOptions({ sessionId: SESSION, fence: FENCE })
      expect(reread.current.serviceTier).toBe(FAST.value)
      expect(reread.speed?.selection).toMatchObject({ tierId: ULTRA.value })
      expect(reread.speed?.selection.state).not.toBe('ready')
      expectRefusedBeforeWire(again.codex, await dispatchNext(again.adapter))
    })

    it('keeps the unsaved tier as the request when a later model write fails to save', async () => {
      const session = await laterWriteFailsToSave({ key: 'model', value: OTHER_MODEL })

      await expectUltraRequestedNotStored(session, FAST.value)
    })
  })
})

describe('a saved option the adapter does not recognise, across speed writes', () => {
  const SAVED = { ...ACKNOWLEDGED, ...UNRELATED }

  it('survives an accepted canonical speed write in the complete persisted map', async () => {
    const { adapter, recorded } = await openLiveSession([STANDARD, FAST, ULTRA], SAVED)
    const durable = durableStore(recorded)

    const picked = await pickTier(await contextFor(adapter, durable), ULTRA.value)

    expect(picked).toMatchObject({ ok: true })
    expect(durable.current()).toMatchObject({
      model: MODEL,
      serviceTier: ULTRA.value,
      ...UNRELATED
    })
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

// A pick the adapter accepts live and the store then refuses is blocked in memory only: the durable
// record never learned of it. Nothing below claims it survives a restart. Each later write that also
// fails to save must leave that block, and the acknowledged tier beside it, exactly as they were.
type MemoryOnlyBlock = {
  name: string
  tiers: readonly { value: string; label: string }[]
  saved: Readonly<Record<string, string>>
  /** The pick whose durable write fails, and what the adapter then offers the store. */
  pick: { key: string; value: string }
  offered: Record<string, string>
  /** What the next read reports as requested, beside `current` as the acknowledged tier. */
  requested: { tierId?: string; legacyFastMode?: true }
  current: string
  /** An explicit canonical pick the catalog advertises. */
  replacement: string
}

const MEMORY_ONLY_BLOCKS: readonly MemoryOnlyBlock[] = [
  {
    name: 'an advertised paid tier',
    tiers: [STANDARD, FAST, ULTRA],
    saved: ACKNOWLEDGED,
    pick: { key: 'serviceTier', value: ULTRA.value },
    offered: { serviceTier: ULTRA.value },
    requested: { tierId: ULTRA.value },
    current: FAST.value,
    replacement: STANDARD.value
  },
  {
    // The catalog has an explicit Standard-only row, so no tier id can resolve the legacy toggle.
    name: 'an unresolved legacy Fast toggle over explicit Standard',
    tiers: [STANDARD],
    saved: ACKNOWLEDGED_STANDARD,
    pick: { key: 'fastMode', value: 'true' },
    offered: { fastMode: 'true' },
    requested: { legacyFastMode: true },
    current: STANDARD.value,
    replacement: STANDARD.value
  }
]

const LATER_WRITES = [
  { name: 'effort change', pick: { key: 'effort', value: 'high' } },
  { name: 'model change', pick: { key: 'model', value: OTHER_MODEL } }
]

type LiveSession = Awaited<ReturnType<typeof openLiveSession>>

async function blockedInMemory(block: MemoryOnlyBlock, path: 'adapter' | 'router') {
  const session = await openLiveSession(block.tiers, block.saved, true)
  const durable = durableStore(session.recorded)
  const ctx = await contextFor(path === 'router' ? session.router : session.adapter, durable)
  const failure = new Error('disk full')
  durable.persistOptions.mockRejectedValueOnce(failure)

  await expect(performSetOption(ctx, block.pick)).rejects.toBe(failure)

  // The adapter accepted the pick and offered it; only the store refused it.
  expect(durable.persistOptions).toHaveBeenCalledWith(expect.objectContaining(block.offered))
  expect(durable.publish).not.toHaveBeenCalled()
  expect(durable.current()).toEqual(session.recorded)
  return { ...session, durable, ctx }
}

/** The block is still in force: no write reaches the provider, the read reports the unsaved request
 *  beside the acknowledged tier, and no claim of an applied or processed tier appears. */
async function expectStillBlocked(
  session: LiveSession & { durable: ReturnType<typeof durableStore> },
  block: MemoryOnlyBlock
): Promise<void> {
  expectRefusedBeforeWire(session.codex, await dispatchNext(session.adapter))
  const report = await session.adapter.readOptions({ sessionId: SESSION, fence: FENCE })
  const selection = report.speed?.selection
  expect(report.current.serviceTier).toBe(block.current)
  expect(report.current.model).toBe(MODEL)
  expect(selection).toMatchObject(block.requested)
  expect(['unknown', 'unavailable']).toContain(selection?.state)
  // Never the acknowledged Standard presented as ready.
  expect(selection?.tierId).not.toBe(STANDARD.value)
  expect(report.speed?.applied).toBeUndefined()
  expect(report.speed?.processing).toBeUndefined()
}

function expectNoPrivateSpeedState(options: Readonly<Record<string, string>> | undefined): void {
  expect(Object.keys(options ?? {}).filter((key) => /refused|quarantine/i.test(key))).toEqual([])
}

describe.each(MEMORY_ONLY_BLOCKS)('$name whose durable write failed', (block) => {
  describe.each(['adapter', 'router'] as const)('through the %s', (path) => {
    const replacement = { key: 'serviceTier', value: block.replacement }

    it('stays blocked, reading the acknowledged tier beside the unsaved request', async () => {
      const session = await blockedInMemory(block, path)

      await expectStillBlocked(session, block)
    })

    it.each(LATER_WRITES)(
      'stays blocked when a later $name also fails to save',
      async ({ pick }) => {
        const session = await blockedInMemory(block, path)
        const later = new Error('disk full again')
        session.durable.persistOptions.mockRejectedValueOnce(later)

        await expect(performSetOption(session.ctx, pick)).rejects.toBe(later)

        expect(session.durable.persistOptions).toHaveBeenCalledTimes(2)
        expect(session.durable.publish).not.toHaveBeenCalled()
        expect(session.durable.current()).toEqual(session.recorded)
        await expectStillBlocked(session, block)
      }
    )

    it('keeps the earlier request when an explicit replacement also fails to save', async () => {
      const session = await blockedInMemory(block, path)
      const later = new Error('disk full again')
      session.durable.persistOptions.mockRejectedValueOnce(later)

      await expect(performSetOption(session.ctx, replacement)).rejects.toBe(later)

      expect(session.durable.publish).not.toHaveBeenCalled()
      expect(session.durable.current()).toEqual(session.recorded)
      await expectStillBlocked(session, block)
    })

    it('releases the block for a durably accepted replacement and sends exactly its id', async () => {
      const session = await blockedInMemory(block, path)
      session.durable.persistOptions.mockRejectedValueOnce(new Error('disk full again'))
      await expect(performSetOption(session.ctx, replacement)).rejects.toThrow('disk full again')

      const replaced = await performSetOption(session.ctx, replacement)

      expect(replaced).toMatchObject({ ok: true, value: replacement })
      expect(session.durable.publish).toHaveBeenCalledOnce()
      expect(session.durable.current()).toMatchObject({
        model: MODEL,
        serviceTier: block.replacement
      })
      expect(session.durable.current()).not.toHaveProperty('fastMode')
      expectNoPrivateSpeedState(session.durable.current())
      expectNoPrivateSpeedState(replaced.ok ? replaced.value.options : undefined)
      expect((await dispatchNext(session.adapter)).state).toBe('admitted')
      const starts = turnStarts(session.codex)
      expect(starts).toHaveLength(1)
      expect(starts[0]?.params).toMatchObject({ serviceTier: block.replacement })
      expectOnlyPublicTurnFields(starts[0]?.params)
    })
  })
})
