import { describe, expect, it } from 'vitest'
import { CODEX_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-claude-codex'
import type { AgentSessionModelOption } from './agent-session-wire'
import { buildNativeChatSessionOptionSnapshot } from './native-chat-session-option-snapshot'
import { createNativeChatSessionOptionRecord } from './native-chat-session-option-state'
import { discoveredModel } from './structured-agent-session-discovered-model'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from './structured-agent-session-options'

const model: AgentSessionModelOption = {
  id: 'synthetic-catalog-model',
  label: 'Synthetic catalog model',
  isDefault: true,
  efforts: []
}
const standard = { value: 'default', label: 'Standard' }

function snapshot(row: AgentSessionModelOption, supportsFastMode = false) {
  return structuredAgentSessionOptionSnapshot(
    applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('codex'),
      CODEX_SESSION_OPTION_CATALOG,
      {
        models: [row],
        fastModeSupport: { supported: supportsFastMode },
        current: { model: row.id }
      }
    )
  )
}

describe('catalog-backed structured session speed', () => {
  it('offers an explicit Standard-only speed option for a known empty tier catalog', () => {
    const discovered = discoveredModel({ ...model, serviceTiers: [] }, false)

    expect(discovered.options).toContainEqual(
      expect.objectContaining({
        id: 'serviceTier',
        label: 'Speed',
        kind: { type: 'select', choices: [standard], defaultValue: 'default' }
      })
    )
  })

  it('keeps a Standard-only speed selector visible through the generic snapshot', () => {
    // Supply the known option independently so this exercises snapshot filtering itself.
    const listedModel = {
      ...discoveredModel(model, false),
      options: [
        {
          id: 'serviceTier',
          label: 'Speed',
          kind: { type: 'select' as const, choices: [standard], defaultValue: 'default' },
          apply: {}
        }
      ]
    }
    const record = createNativeChatSessionOptionRecord('codex')
    record.model = { value: model.id, source: 'reported' }
    const descriptors = buildNativeChatSessionOptionSnapshot({
      catalog: { ...CODEX_SESSION_OPTION_CATALOG, models: [listedModel] },
      models: [listedModel],
      record,
      mode: 'live',
      modelLabel: 'Model',
      liveTransport: 'agent-session'
    })

    expect(descriptors).toContainEqual(
      expect.objectContaining({
        id: 'serviceTier',
        kind: expect.objectContaining({ type: 'select', choices: [standard] })
      })
    )
  })

  it('does not invent a known Standard-only tier catalog when tier support is unknown', () => {
    expect(model.serviceTiers).toBeUndefined()
    expect(snapshot(model).map(({ id }) => id)).toEqual(['model'])
  })

  it('preserves an older host Fast toggle when it advertises Fast without tier metadata', () => {
    const descriptors = snapshot({ ...model, supportsFastMode: true }, true)

    expect(descriptors.map(({ id }) => id)).toEqual(['model', 'fastMode'])
    expect(descriptors).toContainEqual(
      expect.objectContaining({
        id: 'fastMode',
        kind: { type: 'boolean', currentValue: false },
        settable: true
      })
    )
  })
})
