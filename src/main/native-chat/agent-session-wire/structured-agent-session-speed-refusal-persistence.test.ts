// The generic live option boundary (`performSetOption`) when a provider refuses a pick and hands back
// the complete option map that records the refusal. The generic code persists that map before it
// returns the refusal; it knows no provider's marker key, and a refusal without a map writes nothing.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { claudeAndCodexAgents } from './structured-agent-session-adapter-router-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { AgentSessionOptionRejectedError } from './structured-agent-session-option-error'
import { performSetOption, type AgentSessionTurnContext } from './structured-agent-session-turns'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}

// Synthetic ids: the catalog decides which tiers exist, and the provider owns the marker's key.
const FAST_ID = 'Tier.Fast-77a'
const ULTRA_ID = 'Tier.Ultra-9c1'
const MODEL = 'synthetic-model-a'
const BLOCKED_INTENT_KEY = 'syntheticProviderPrivateBlockedIntent'

const CANONICAL_FAST: Readonly<Record<string, string>> = {
  model: MODEL,
  serviceTier: FAST_ID,
  approvalsReviewer: 'user'
}
const REFUSAL_MAP: Readonly<Record<string, string>> = {
  ...CANONICAL_FAST,
  [BLOCKED_INTENT_KEY]: ULTRA_ID
}
const PICK = { key: 'serviceTier', value: ULTRA_ID }

let root: string | null = null
const journals = createTrackedJournalOpener()

afterEach(async () => {
  await journals.closeAll()
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

/** A provider refusal that carries the complete map to record, as an adapter's boundary throws it. */
function refusalCarryingMap(
  options: Readonly<Record<string, string>>,
  reason: 'optionRejected' | 'providerStarting' = 'optionRejected'
): AgentSessionOptionRejectedError {
  return new AgentSessionOptionRejectedError(new Error('tier is not offered'), reason, options)
}

/** The record's options as the durable store holds them, and the order effects reach it. */
function durableOptions(initial: Readonly<Record<string, string>>): {
  current: () => Readonly<Record<string, string>>
  events: string[]
  persistOptions: Mock<AgentSessionTurnContext['persistOptions']>
  publish: Mock<AgentSessionTurnContext['publish']>
} {
  let stored = { ...initial }
  const events: string[] = []
  return {
    current: () => stored,
    events,
    persistOptions: vi.fn(async (next: Readonly<Record<string, string>>) => {
      events.push('persist')
      stored = { ...next }
    }),
    publish: vi.fn(() => {
      events.push('publish')
    })
  }
}

async function contextFor(
  adapter: Pick<StructuredAgentSessionAdapter, 'setOption'>,
  durable: Pick<ReturnType<typeof durableOptions>, 'persistOptions' | 'publish'>,
  agent: 'claude' | 'codex' = 'codex'
): Promise<AgentSessionTurnContext> {
  root ??= await mkdtemp(join(tmpdir(), 'orca-speed-refusal-persistence-'))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the option boundary reads only `setOption`.
  const wired = adapter as StructuredAgentSessionAdapter
  return {
    logger: createStructuredAgentSessionLogger(),
    sessionId: IDENTITY.sessionId,
    journal: await journals.open({ identity: IDENTITY, stateDirectory: root }),
    fence: 1,
    adapter: wired,
    agents: claudeAndCodexAgents(wired),
    agent,
    persistOptions: durable.persistOptions,
    resolvedBy: 'client-1',
    publish: durable.publish,
    now: () => 1
  }
}

describe('a provider refusal that carries the complete option map', () => {
  it('persists the map once, before publishing, and keeps the canonical tier beside the blocked intent', async () => {
    const durable = durableOptions(CANONICAL_FAST)
    const setOption = vi.fn(async () => {
      throw refusalCarryingMap(REFUSAL_MAP)
    })

    await performSetOption(await contextFor({ setOption }, durable), PICK)

    expect(setOption).toHaveBeenCalledOnce()
    expect(durable.persistOptions).toHaveBeenCalledExactlyOnceWith(REFUSAL_MAP)
    expect(durable.events).toEqual(['persist', 'publish'])
    expect(durable.current()).toEqual({
      model: MODEL,
      serviceTier: FAST_ID,
      approvalsReviewer: 'user',
      [BLOCKED_INTENT_KEY]: ULTRA_ID
    })
  })

  it('still answers with the refusal, never an acknowledgement of the picked value', async () => {
    const durable = durableOptions(CANONICAL_FAST)

    const result = await performSetOption(
      await contextFor(
        {
          setOption: async () => {
            throw refusalCarryingMap(REFUSAL_MAP)
          }
        },
        durable
      ),
      PICK
    )

    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_operation_invalid',
        details: { reason: 'optionRejected' }
      }
    })
    expect(result).not.toHaveProperty('value')
  })

  it('propagates a failure to persist it, publishing nothing and leaving the durable map unchanged', async () => {
    const durable = durableOptions(CANONICAL_FAST)
    const failure = new Error('disk full')
    durable.persistOptions.mockImplementationOnce(async () => {
      durable.events.push('persist')
      throw failure
    })

    const outcome = performSetOption(
      await contextFor(
        {
          setOption: async () => {
            throw refusalCarryingMap(REFUSAL_MAP)
          }
        },
        durable
      ),
      PICK
    )

    await expect(outcome).rejects.toBe(failure)
    expect(durable.persistOptions).toHaveBeenCalledExactlyOnceWith(REFUSAL_MAP)
    expect(durable.publish).not.toHaveBeenCalled()
    expect(durable.events).toEqual(['persist'])
    expect(durable.current()).toEqual(CANONICAL_FAST)
  })
})

describe('a provider refusal that carries no option map', () => {
  it('writes and publishes nothing, so Claude is unchanged', async () => {
    const durable = durableOptions({ model: 'claude-model', effort: 'low' })

    const result = await performSetOption(
      await contextFor(
        {
          setOption: async () => {
            throw new AgentSessionOptionRejectedError(new Error('effort is not offered'))
          }
        },
        durable,
        'claude'
      ),
      { key: 'effort', value: 'max' }
    )

    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_operation_invalid',
        details: { reason: 'optionRejected' }
      }
    })
    expect(durable.persistOptions).not.toHaveBeenCalled()
    expect(durable.publish).not.toHaveBeenCalled()
    expect(durable.current()).toEqual({ model: 'claude-model', effort: 'low' })
  })

  it('does not fabricate Codex state when the provider is still starting', async () => {
    const durable = durableOptions(CANONICAL_FAST)

    const result = await performSetOption(
      await contextFor(
        {
          setOption: async () => {
            throw new AgentSessionOptionRejectedError(
              new Error('the session is still starting'),
              'providerStarting'
            )
          }
        },
        durable
      ),
      PICK
    )

    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_operation_invalid',
        details: { reason: 'providerStarting' }
      }
    })
    expect(durable.persistOptions).not.toHaveBeenCalled()
    expect(durable.publish).not.toHaveBeenCalled()
    expect(durable.current()).toEqual(CANONICAL_FAST)
  })

  it('persists and publishes nothing when a starting provider refusal carries an option map', async () => {
    const durable = durableOptions(CANONICAL_FAST)

    const result = await performSetOption(
      await contextFor(
        {
          setOption: async () => {
            throw refusalCarryingMap(REFUSAL_MAP, 'providerStarting')
          }
        },
        durable
      ),
      PICK
    )

    expect(result).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_operation_invalid',
        details: { reason: 'providerStarting' }
      }
    })
    expect(durable.persistOptions).not.toHaveBeenCalled()
    expect(durable.publish).not.toHaveBeenCalled()
    expect(durable.events).toEqual([])
    expect(durable.current()).toEqual(CANONICAL_FAST)
  })
})

describe('a pick the provider accepts after a refusal', () => {
  it('replaces the whole map the refusal recorded, so the blocked intent is gone', async () => {
    const durable = durableOptions(REFUSAL_MAP)
    const replacement = { model: MODEL, serviceTier: ULTRA_ID, approvalsReviewer: 'user' }

    const result = await performSetOption(
      await contextFor({ setOption: async () => replacement }, durable),
      PICK
    )

    expect(result).toEqual({ ok: true, value: { ...PICK, options: replacement } })
    expect(durable.persistOptions).toHaveBeenCalledExactlyOnceWith(replacement)
    expect(durable.events).toEqual(['persist', 'publish'])
    expect(durable.current()).toEqual(replacement)
    expect(Object.keys(durable.current())).not.toContain(BLOCKED_INTENT_KEY)
  })
})
