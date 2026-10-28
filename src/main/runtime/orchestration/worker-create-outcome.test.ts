import { describe, expect, it } from 'vitest'
import { AgentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import {
  assertWorkerEffectWritePreservesStructuredCreateRefusal,
  hasEligibleStructuredCreateRefusal,
  readStructuredCreateRefusal,
  rememberStructuredCreateRefusal,
  type StructuredCreateRefusalAttempt,
  type StructuredCreateRefusalEffect
} from './worker-create-outcome'

const attempt: StructuredCreateRefusalAttempt = {
  runId: 'run_0123456789ab',
  taskId: 'task_0123456789ab',
  dispatchId: 'ctx_0123456789ab',
  runtimeEpoch: 'runtime_1',
  sessionId: 'session_12345678',
  clientOperationId: '1000000000000-0123456789abcdef0123456789abcdef'
}

function refusal(code: 'structured_agent_session_unsupported' | 'agent_session_operation_unknown') {
  return new AgentSessionRefusalError({ code, message: code })
}

const proof: StructuredCreateRefusalEffect = {
  kind: 'structured_create_refusal',
  schema: 'orca.worker-create-refusal.v1',
  ...attempt,
  refusalCode: 'structured_agent_session_unsupported'
}

describe('structured worker create outcome', () => {
  it('retains only the exact definitive refusal on its originating typed error', () => {
    const definitive = refusal('structured_agent_session_unsupported')
    const unknown = refusal('agent_session_operation_unknown')

    rememberStructuredCreateRefusal(definitive, attempt)

    expect(readStructuredCreateRefusal(definitive)).toEqual<StructuredCreateRefusalEffect>({
      kind: 'structured_create_refusal',
      schema: 'orca.worker-create-refusal.v1',
      ...attempt,
      refusalCode: 'structured_agent_session_unsupported'
    })
    expect(
      readStructuredCreateRefusal(refusal('structured_agent_session_unsupported'))
    ).toBeUndefined()
    rememberStructuredCreateRefusal(unknown, attempt)
    expect(readStructuredCreateRefusal(unknown)).toBeUndefined()
    expect(readStructuredCreateRefusal(new Error('structured_agent_session_unsupported'))).toBeUndefined()
  })

  it.each([
    ['missing run id', 'runId'],
    ['missing task id', 'taskId'],
    ['missing dispatch id', 'dispatchId'],
    ['missing runtime epoch', 'runtimeEpoch'],
    ['missing session id', 'sessionId'],
    ['missing operation id', 'clientOperationId']
  ] as const)('does not mint provenance with %s', (_label, key) => {
    const candidate = { ...attempt }
    Reflect.deleteProperty(candidate, key)
    const error = refusal('structured_agent_session_unsupported')

    rememberStructuredCreateRefusal(error, candidate)

    expect(readStructuredCreateRefusal(error)).toBeUndefined()
  })

  it.each([
    ['whitespace session', { sessionId: ' ' }],
    ['short session', { sessionId: 'short' }],
    ['overlong session', { sessionId: 's'.repeat(129) }],
    ['unsafe session', { sessionId: 'session/123456' }],
    ['arbitrary operation', { clientOperationId: 'not-an-operation' }],
    [
      'operation without separator',
      { clientOperationId: '1000000000000000123456789012345678901234' }
    ],
    ['operation with short digest', { clientOperationId: `1000000000000-${'0'.repeat(31)}` }],
    [
      'operation with long digest',
      { clientOperationId: '1000000000000-0123456789abcdef0123456789abcdef000' }
    ],
    ['malformed run id', { runId: 'run_1' }],
    ['malformed task id', { taskId: 'task_1' }],
    ['malformed dispatch id', { dispatchId: 'ctx_1' }]
  ])('does not mint provenance with %s', (_label, changes) => {
    const error = refusal('structured_agent_session_unsupported')

    rememberStructuredCreateRefusal(error, { ...attempt, ...changes })

    expect(readStructuredCreateRefusal(error)).toBeUndefined()
  })

  it('does not mint readable provenance with extra attempt fields', () => {
    const error = refusal('structured_agent_session_unsupported')
    const candidate = { ...attempt, extra: 'caller input' }

    rememberStructuredCreateRefusal(error, candidate)

    expect(readStructuredCreateRefusal(error)).toBeUndefined()
  })

  it('rejects reserved proof injection and replacement outside the authenticated writer', () => {
    expect(() => assertWorkerEffectWritePreservesStructuredCreateRefusal([], [proof])).toThrow()
    expect(() =>
      assertWorkerEffectWritePreservesStructuredCreateRefusal([proof], [
        { kind: 'worktree', action: 'reused' }
      ])
    ).toThrow()
    expect(() =>
      assertWorkerEffectWritePreservesStructuredCreateRefusal([proof], [proof])
    ).not.toThrow()
    expect(() =>
      assertWorkerEffectWritePreservesStructuredCreateRefusal([], [
        { ...proof, refusalCode: 'forged' }
      ])
    ).toThrow()
  })

  it('requires one exact proof bound to the current attempt and rejects contradictions', () => {
    expect(hasEligibleStructuredCreateRefusal([proof], attempt)).toBe(true)
    expect(hasEligibleStructuredCreateRefusal([proof, proof], attempt)).toBe(false)

    for (const kind of ['terminal', 'session', 'structured_session'] as const) {
      expect(hasEligibleStructuredCreateRefusal([
        proof,
        { kind, action: 'created', id: 'term_1' }
      ], attempt)).toBe(false)
    }
  })

  it.each([
    ['missing kind', (() => {
      const value = { ...proof }
      Reflect.deleteProperty(value, 'kind')
      return value
    })()],
    ['missing schema', (() => {
      const value = { ...proof }
      Reflect.deleteProperty(value, 'schema')
      return value
    })()],
    ['missing run id', (() => {
      const value = { ...proof }
      Reflect.deleteProperty(value, 'runId')
      return value
    })()],
    ['missing task id', (() => {
      const value = { ...proof }
      Reflect.deleteProperty(value, 'taskId')
      return value
    })()],
    ['missing dispatch id', (() => {
      const value = { ...proof }
      Reflect.deleteProperty(value, 'dispatchId')
      return value
    })()],
    ['missing runtime epoch', (() => {
      const value = { ...proof }
      Reflect.deleteProperty(value, 'runtimeEpoch')
      return value
    })()],
    ['missing session id', (() => {
      const value = { ...proof }
      Reflect.deleteProperty(value, 'sessionId')
      return value
    })()],
    ['missing operation id', (() => {
      const value = { ...proof }
      Reflect.deleteProperty(value, 'clientOperationId')
      return value
    })()],
    ['missing refusal code', (() => {
      const value = { ...proof }
      Reflect.deleteProperty(value, 'refusalCode')
      return value
    })()],
    ['extra key', { ...proof, extra: 'caller input' }],
    ['unknown schema', { ...proof, schema: 'orca.worker-create-refusal.v2' }],
    ['wrong refusal', { ...proof, refusalCode: 'agent_session_operation_unknown' }],
    ['whitespace session', { ...proof, sessionId: ' ' }],
    ['short session', { ...proof, sessionId: 'short' }],
    ['overlong session', { ...proof, sessionId: 's'.repeat(129) }],
    ['unsafe session', { ...proof, sessionId: 'session/123456' }],
    ['arbitrary operation', { ...proof, clientOperationId: 'not-an-operation' }],
    ['operation without separator', {
      ...proof,
      clientOperationId: '1000000000000000123456789012345678901234'
    }],
    ['operation with short digest', {
      ...proof,
      clientOperationId: `1000000000000-${'0'.repeat(31)}`
    }],
    ['operation with long digest', {
      ...proof,
      clientOperationId: '1000000000000-0123456789abcdef0123456789abcdef000'
    }],
    ['malformed run id', { ...proof, runId: 'run_1' }],
    ['malformed task id', { ...proof, taskId: 'task_1' }],
    ['malformed dispatch id', { ...proof, dispatchId: 'ctx_1' }],
    ['wrong run binding', { ...proof, runId: 'run_abcdefabcdef' }],
    ['wrong task binding', { ...proof, taskId: 'task_abcdefabcdef' }],
    ['wrong dispatch binding', { ...proof, dispatchId: 'ctx_abcdefabcdef' }],
    ['wrong runtime binding', { ...proof, runtimeEpoch: 'runtime_2' }]
  ] as const)('%s is not eligible', (_label, candidate) => {
    expect(hasEligibleStructuredCreateRefusal([candidate], attempt)).toBe(false)
  })
})
