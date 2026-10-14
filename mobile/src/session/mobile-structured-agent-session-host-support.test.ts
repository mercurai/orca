import { describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_CODEX_SERVICE_TIERS_RUNTIME_CAPABILITY,
  AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY,
  AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY,
  AGENT_SESSION_REPEATED_STOP_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import {
  mobileCodexSpeedHostSupport,
  structuredAgentSessionHostSupport
} from './mobile-structured-agent-session-host-support'

describe('mobileCodexSpeedHostSupport', () => {
  it('is unknown before the status probe, then the capability the host advertised', () => {
    expect(mobileCodexSpeedHostSupport(null)).toBe('unknown')
    expect(mobileCodexSpeedHostSupport(structuredAgentSessionHostSupport([]))).toBe('unsupported')
    expect(
      mobileCodexSpeedHostSupport(
        structuredAgentSessionHostSupport([AGENT_SESSION_CODEX_SERVICE_TIERS_RUNTIME_CAPABILITY])
      )
    ).toBe('supported')
  })

  it('reads a support record that predates the capability as not advertised', () => {
    const { codexServiceTiers: _absent, ...legacy } = structuredAgentSessionHostSupport([])

    expect(mobileCodexSpeedHostSupport(legacy)).toBe('unsupported')
  })
})

describe('structuredAgentSessionHostSupport', () => {
  it('reads each structured-session feature from the host capability list', () => {
    const none = {
      promptCancel: false,
      questionAnswers: false,
      queuedMessages: false,
      queuedCommands: false,
      quietRepeatedStop: false,
      statusFeed: false,
      codexServiceTiers: false
    }
    expect(structuredAgentSessionHostSupport([])).toEqual(none)
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY])
    ).toEqual({ ...none, questionAnswers: true })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY])
    ).toEqual({ ...none, promptCancel: true })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY])
    ).toEqual({ ...none, queuedMessages: true })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY])
    ).toEqual({ ...none, queuedCommands: true })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_REPEATED_STOP_RUNTIME_CAPABILITY])
    ).toEqual({ ...none, quietRepeatedStop: true })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY])
    ).toEqual({ ...none, statusFeed: true })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_CODEX_SERVICE_TIERS_RUNTIME_CAPABILITY])
    ).toEqual({ ...none, codexServiceTiers: true })
  })
})
