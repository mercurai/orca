import { describe, expect, it } from 'vitest'
import { buildDispatchPreamble } from './preamble'

const piParams = {
  taskId: 'task_pi',
  dispatchId: 'ctx_pi',
  taskSpec: 'Implement the assigned issue within the declared file claims.',
  coordinatorHandle: 'term_coordinator',
  workerHandle: 'structworker_pi',
  reportingMode: 'pi-tool' as const
}

describe('Pi worker reporting preamble', () => {
  it('uses the bounded reporting tool without requiring an unavailable shell', () => {
    const preamble = buildDispatchPreamble(piParams)
    expect(preamble).toContain('harness_report')
    for (const operation of ['status', 'heartbeat', 'ask', 'resume', 'inbox', 'complete']) {
      expect(preamble).toContain(`"operation":"${operation}"`)
    }
    expect(preamble).not.toContain('```sh')
    expect(preamble).not.toContain('orchestration send')
    expect(preamble).not.toContain('orchestration check')
    expect(preamble).toContain('5 minutes')
    expect(preamble).toContain(piParams.taskSpec)
  })

  it('keeps task identity and routing host-owned', () => {
    const preamble = buildDispatchPreamble(piParams)
    expect(preamble).toContain('host-owned')
    expect(preamble).toContain('Run, Task, Dispatch')
    expect(preamble).toContain('recipient')
    expect(preamble).toContain('executable')
    expect(preamble).not.toContain('--from')
    expect(preamble).not.toContain('--dispatch-id')
    expect(preamble).not.toContain('--dispatch-capability')
  })

  it('requires explicit completion and preserves the export and review boundary', () => {
    const preamble = buildDispatchPreamble(piParams)
    expect(preamble).toContain('agent_settled')
    expect(preamble).toContain('final text')
    expect(preamble).toContain('worker_done')
    expect(preamble).toContain('seal')
    expect(preamble).toContain('zero outstanding')
    expect(preamble).toContain('workerRelease')
    expect(preamble).toContain('child exit')
    expect(preamble).toContain('export')
    expect(preamble).toContain('Sol review')
    expect(preamble).toContain('CI')
    expect(preamble).not.toContain('workerStop')
  })

  it('resumes unanswered questions and retries uncertain completion without a new mutation', () => {
    const preamble = buildDispatchPreamble(piParams)
    expect(preamble).toContain('messageId')
    expect(preamble).toContain('do not ask again')
    expect(preamble).toContain('same mutation')
    expect(preamble).toContain('inbox')
  })

  it('retains drift warnings while refusing subworker shell recipes', () => {
    const preamble = buildDispatchPreamble({
      ...piParams,
      canDispatchSubWorkers: true,
      baseDrift: { base: 'main', behind: 2, recentSubjects: ['fix: admission'] }
    })
    expect(preamble).toContain('fix: admission')
    expect(preamble).not.toContain('worker-start')
    expect(preamble).not.toContain('```sh')
  })
})
