// What the picker shows for a chat's speed is what its next turn runs, on any host's answer.

import { describe, expect, it, vi } from 'vitest'
import { CODEX_SESSION_OPTION_CATALOG } from '../../shared/agent-session-option-catalog-claude-codex'
import type { AgentSessionModelOption } from '../../shared/agent-session-wire'
import {
  applyStructuredAgentSessionOptions,
  commitStructuredAgentSessionOption,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot,
  type StructuredAgentSessionOptionState
} from '../../shared/structured-agent-session-options'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { CodexAcquisitionWindow } from './codex-structured-acquisition-window'
import { CodexBackgroundTaskTracker } from './codex-background-task-tracker'
import { createCodexDispatchEchoes } from './codex-structured-dispatch-echo'
import { createCodexTurnOpenWaits } from './codex-structured-turn-open-wait'
import type { CodexSession } from './codex-structured-session-state'
import { startCodexTurn } from './codex-structured-turn-start'
import { readLiveCodexSessionOptions } from './codex-structured-session-options'

const tiers = (...values: string[]) => values.map((value) => ({ value, label: value }))
// M1 offers Fast and Flex; M2 offers only Ultrafast.
const MODELS: AgentSessionModelOption[] = [
  { id: 'm1', label: 'M1', isDefault: true, efforts: [], serviceTiers: tiers('priority', 'flex') },
  { id: 'm2', label: 'M2', isDefault: false, efforts: [], serviceTiers: tiers('ultrafast') }
]

/** The tier the first turn after a start carries, and the session's tier after a live read. */
async function hostRuns(
  saved: Record<string, string>,
  ageMs = 0,
  child?: { tiers?: readonly string[]; reported?: string }
) {
  let now = 1
  const store = new AgentModelCatalogStore({ now: () => now })
  store.recordSuccess(
    'codex-account',
    'codex',
    { models: MODELS, complete: true, origin: 'probe' },
    'discovery'
  )
  now += ageMs
  let offline = false
  const request = vi.fn(async (method: string, _params?: Record<string, unknown>) => {
    if (method !== 'model/list') {
      return { turn: { id: 'turn-1' } }
    }
    if (offline) {
      throw new Error('offline')
    }
    return {
      data: [
        {
          model: saved.model,
          supportedReasoningEfforts: [],
          ...(child?.tiers ? { additionalSpeedTiers: child.tiers } : {})
        }
      ],
      nextCursor: null
    }
  })
  const session: CodexSession = {
    connection: {
      pid: 1,
      closed: false,
      request,
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => true
    },
    backgroundTasks: new CodexBackgroundTaskTracker('thread-1'),
    ended: false,
    fence: 1,
    acquisitionGeneration: 'generation-1',
    threadId: 'thread-1',
    prompts: new CodexAcquisitionWindow().prompts,
    options: new Map(Object.entries(saved)),
    reportedOptions: child?.reported ? { serviceTier: child.reported, serviceTierKnown: true } : {},
    catalogAccess: { store, fingerprint: 'codex-account', accountHomePath: '/account' },
    dispatchEchoes: createCodexDispatchEchoes(),
    turnOpenWaits: createCodexTurnOpenWaits(),
    translator: null
  }
  const shown = child
    ? (await readLiveCodexSessionOptions(session, undefined)).current.serviceTier
    : undefined
  if (child) {
    offline = true
    store.recordFailure('codex-account', 'offline', 'codex')
  }
  try {
    await startCodexTurn(session, {
      clientMessageId: 'message-1',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'go' }] }
    })
  } catch (error) {
    expect(request.mock.calls.some(([method]) => method === 'turn/start')).toBe(false)
    expect(session.options.get('serviceTier')).toBe(saved.serviceTier)
    throw error
  }
  const firstTurn = request.mock.calls.find(([method]) => method === 'turn/start')?.[1]
  await readLiveCodexSessionOptions(session, undefined)
  return {
    firstTurn: firstTurn?.serviceTier,
    afterLiveRead: session.options.get('serviceTier'),
    ...(child ? { shown } : {})
  }
}

/** A host's answer naming the saved values; an older host marks no defaults. */
function answered(saved: Record<string, string>, marksDefaults: boolean) {
  return applyStructuredAgentSessionOptions(
    createStructuredAgentSessionOptionState('codex', CODEX_SESSION_OPTION_CATALOG),
    CODEX_SESSION_OPTION_CATALOG,
    { models: MODELS, current: { ...saved, ...(marksDefaults ? { defaulted: [] } : {}) } }
  )
}

function shownTier(state: StructuredAgentSessionOptionState): string | undefined {
  const kind = structuredAgentSessionOptionSnapshot(state).find(
    (entry) => entry.id === 'serviceTier'
  )?.kind
  return kind?.type === 'select' ? kind.currentValue : undefined
}

describe("a Codex chat's speed, shown and sent", () => {
  it('refuses paid speed after discovery failure, including reported opaque tiers', async () => {
    for (const [child, tier] of [
      [{ tiers: ['priority'] }, 'priority'],
      [{ tiers: ['ultrafast'] }, 'priority'],
      [{}, 'priority'],
      [{ tiers: [] }, 'priority'],
      [{ tiers: [], reported: 'opaque' }, 'opaque'],
      [{ tiers: [], reported: 'ultrafast' }, 'ultrafast']
    ] as const) {
      await expect(hostRuns({ model: 'm2', serviceTier: tier }, 120_000, child)).rejects.toMatchObject({
        kind: 'speedSupportUnknown'
      })
    }
  })

  it('preserves unavailable selection on modern and older hosts without dispatching a downgrade', async () => {
    for (const tier of ['priority', 'flex']) {
      const saved = { model: 'm2', serviceTier: tier }
      for (const marksDefaults of [true, false]) {
        expect(shownTier(answered(saved, marksDefaults))).toBe(tier)
      }
      await expect(hostRuns(saved)).rejects.toMatchObject({ kind: 'speedUnavailable' })
    }
  })

  it('sends the exact advertised tier and retains it through live reads and model changes', async () => {
    for (const tier of ['priority', 'flex']) {
      await expect(hostRuns({ model: 'm1', serviceTier: tier })).resolves.toEqual({
        firstTurn: tier,
        afterLiveRead: tier
      })
    }
    const back = commitStructuredAgentSessionOption(
      answered({ model: 'm2', serviceTier: 'flex' }, true),
      'model',
      'm1'
    )
    expect(shownTier(back)).toBe('flex')
    await expect(hostRuns({ model: 'm1', serviceTier: 'flex' })).resolves.toMatchObject({
      firstTurn: 'flex'
    })
  })
})
