import { describe, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../agent-session-record-test-fixture'
import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import { agentModelCatalogFingerprint } from './agent-model-catalog-fingerprint'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import { AgentModelCatalogUnavailableError } from './agent-model-catalog-unavailable'
import { AgentModelCatalogStore, type AgentModelCatalogSuccess } from './agent-model-catalog-store'

function record(accountHomePath: string) {
  return agentSessionRecordFixture({
    sessionId: 'session-1',
    provider: 'grok',
    accountHome: { variable: 'GROK_HOME', path: accountHomePath },
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'ws-1',
      workspaceKind: 'git-worktree'
    }
  })
}
function listing(id: string): AgentModelCatalogSuccess {
  return { models: [{ id, label: id, isDefault: true, efforts: [] }], origin: 'probe' }
}
function selectedHomeFingerprint(path: string) {
  return agentModelCatalogFingerprint({
    agent: 'grok',
    accountHomeVariable: 'GROK_HOME',
    accountHomePath: path,
    wslDistro: null
  })
}

function liveProducerRig() {
  const rows = new Map(
    ['first', 'second'].map((sessionId) => [
      sessionId,
      {
        ...record('/homes/selected'),
        sessionId
      }
    ])
  )
  const pending = Promise.withResolvers<AgentModelCatalogSuccess>()
  let list = () => pending.promise
  const probe = vi.fn(() => list())
  let now = 1_000
  const store = new AgentModelCatalogStore({ now: () => now })
  const service = createAgentModelCatalogService({
    store,
    getConversation: (id) => {
      const row = rows.get(id)
      return row && agentSessionConversationView(row)
    },
    getRecord: (id) => rows.get(id),
    drivesRecord: () => true,
    resolveAccountHome: async () => ({ variable: 'GROK_HOME', path: '/homes/selected' }),
    probes: { grok: probe }
  })
  return {
    store,
    service,
    rows,
    pending,
    probe,
    fingerprint: selectedHomeFingerprint('/homes/selected'),
    advance: (ms: number) => {
      now += ms
    },
    recover: () => {
      list = async () => listing('recovered')
    }
  }
}

describe('completed live reports alongside canonical discovery', () => {
  it('producer capture alone creates no loading and probe failure settles its waiting read', async () => {
    const r = liveProducerRig()
    const source = r.service.captureSource(r.rows.get('first')!)
    try {
      expect(r.service.snapshot({ agent: 'grok' })).toEqual({
        origin: 'unknown',
        catalogState: 'unknown'
      })
      expect(r.probe).not.toHaveBeenCalled()
      const demand = r.service.demand({ agent: 'grok' })
      await vi.waitFor(() => expect(r.probe).toHaveBeenCalledOnce())
      const waiting = r.service.read({ agent: 'grok', waitForListing: true })
      r.pending.reject(new Error('probe failed before the chat reports'))
      expect(await waiting).toMatchObject({ origin: 'unknown', catalogState: 'unknown' })
      await demand
      expect(r.service.snapshot({ agent: 'grok' })).not.toHaveProperty('listingInProgress')
    } finally {
      source.release?.()
      r.service.stop()
    }
  })

  it('publishes a second producer without waiting for an unreported first producer', async () => {
    const r = liveProducerRig()
    const first = r.service.captureSource(r.rows.get('first')!)
    const second = r.service.captureSource(r.rows.get('second')!)
    try {
      await r.service.prepareSaved({ agent: 'grok' })
      r.service.recordLiveListing('second', { models: listing('second-model').models }, second)
      expect(r.service.snapshot({ agent: 'grok' })).toMatchObject({
        models: [{ id: 'second-model' }]
      })
      expect(r.store.isListing(r.fingerprint)).toBe(false)
      r.service.recordLiveListing(
        'first',
        { models: listing('first-eventual-model').models },
        first
      )
      expect(r.service.snapshot({ agent: 'grok' })).toMatchObject({
        models: [{ id: 'first-eventual-model' }]
      })
      expect(r.probe).not.toHaveBeenCalled()
    } finally {
      first.release?.()
      second.release?.()
      r.service.stop()
    }
  })

  it('ignores a retired producer while retaining a later current report', async () => {
    const r = liveProducerRig()
    const old = r.service.captureSource(r.rows.get('first')!)
    try {
      r.store.expireAgent('grok')
      r.service.retireContext('ws-1')
      const current = r.service.captureSource(r.rows.get('second')!)
      await r.service.prepareSaved({ agent: 'grok' })
      r.service.recordLiveListing('second', { models: listing('current-model').models }, current)
      r.service.recordLiveListing('first', { models: listing('retired-model').models }, old)
      expect(r.service.snapshot({ agent: 'grok' })).toMatchObject({
        models: [{ id: 'current-model' }]
      })
      r.service.recordLiveListing('second', { models: listing('later-model').models }, current)
      expect(r.service.snapshot({ agent: 'grok' })).toMatchObject({
        models: [{ id: 'later-model' }]
      })
      current.release?.()
    } finally {
      old.release?.()
      r.service.stop()
    }
  })

  it.each(['generic', 'held unavailable'] as const)(
    'keeps %s failure through live reports and recovers only by current discovery',
    async (kind) => {
      const r = liveProducerRig()
      const source = r.service.captureSource(r.rows.get('first')!)
      const unavailable = { reason: 'notSignedIn' } as const
      try {
        await r.store.refresh(r.fingerprint, 'grok', () =>
          Promise.reject(
            kind === 'generic'
              ? new Error('probe failed')
              : new AgentModelCatalogUnavailableError(unavailable)
          )
        )
        expect(await r.service.read({ agent: 'grok', waitForListing: true })).toMatchObject({
          origin: 'unknown',
          catalogState: 'unknown'
        })
        expect(r.probe).not.toHaveBeenCalled()
        r.service.recordLiveListing('first', { models: listing('live-model').models }, source)
        const shown = r.service.snapshot({ agent: 'grok' })
        expect(shown).toMatchObject({ models: [{ id: 'live-model' }], catalogState: 'unknown' })
        expect(shown).not.toHaveProperty('listingInProgress')
        expect(r.store.hasActiveFailure(r.fingerprint)).toBe(true)
        if (kind === 'held unavailable') {
          expect(shown.unavailable).toEqual(unavailable)
        }
        r.advance(1)
        r.store.expireFailure(r.fingerprint)
        r.recover()
        await r.service.demand({ agent: 'grok' })
        expect(r.service.snapshot({ agent: 'grok' })).toMatchObject({
          models: [{ id: 'recovered' }],
          catalogState: 'available'
        })
        expect(r.store.hasActiveFailure(r.fingerprint)).toBe(false)
        expect(r.service.snapshot({ agent: 'grok' })).not.toHaveProperty('unavailable')
        expect(r.probe).toHaveBeenCalledOnce()
      } finally {
        source.release?.()
        r.service.stop()
      }
    }
  )
})
