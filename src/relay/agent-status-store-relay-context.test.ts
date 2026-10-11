import { describe, expect, it } from 'vitest'
import { createAgentChildWorkAdmission } from '../shared/agent-status-child-work-admission'
import { createAgentStatusStore } from '../shared/agent-status-store'
import { makeStructuredAgentStatusSubject } from '../shared/agent-status-subject'

const trustedSubject = makeStructuredAgentStatusSubject(
  {
    executionHostId: 'ssh:relay-host-a',
    wslDistro: null,
    workspaceId: 'folder-workspace-a',
    workspaceKind: 'folder'
  },
  'session_11111111-1111-4111-8111-111111111111'
)

describe('agent status store relay context', () => {
  it('instantiates the same shared core and completes an admission/snapshot round-trip', () => {
    const authority = createAgentStatusStore({ epoch: 'relay-epoch-a', mode: 'authority' })
    expect(
      authority.applyMutation({ parent: { subject: trustedSubject, firstObservedAt: 10 } })
    ).not.toBeNull()
    const admission = createAgentChildWorkAdmission(authority, {
      mintChildWorkId: () => 'relay-child-1'
    })

    expect(
      admission.announce({
        parent: trustedSubject,
        provider: 'claude',
        aliases: [{ segmentId: 'segment-1', aliasKind: 'task_id', alias: 'task-1' }],
        fence: { invocationId: 'invocation-1', generation: 1 },
        lifetime: 'current',
        kind: 'agent',
        state: 'working',
        membership: 'live',
        observedAt: 20,
        stoppable: true,
        provenance: { source: 'transport', producerId: 'relay-fixture' }
      })
    ).toMatchObject({ accepted: true, childWorkId: 'relay-child-1' })

    const replica = createAgentStatusStore({ epoch: 'replica-placeholder', mode: 'replica' })
    expect(replica.applySnapshot(authority.getSnapshot())).toBe(true)
    expect(replica.getParent(trustedSubject)?.firstObservedAt).toBe(10)
    expect(replica.getChildren(trustedSubject)[0]?.childWorkId).toBe('relay-child-1')
  })
})
