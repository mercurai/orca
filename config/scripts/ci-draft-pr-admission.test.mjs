import { readFileSync, readdirSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { compileAggregateExpression } from './pr-aggregate-gate-context.mjs'

const workflows = readdirSync('.github/workflows').flatMap((file) => {
  const workflow = parse(readFileSync(`.github/workflows/${file}`, 'utf8'))
  // The LoC reporter updates PR metadata rather than running CI.
  return Object.hasOwn(workflow.on ?? {}, 'pull_request') && file !== 'pr-test-loc.yml'
    ? [{ file, workflow, repository: file.startsWith('fork-') ? 'mercurai/orca' : 'stablyai/orca' }]
    : []
})

function admitted(
  condition,
  draft,
  needs = {},
  eventName = 'pull_request',
  repository = 'stablyai/orca'
) {
  return (
    compileAggregateExpression(condition ?? 'true', ['github', 'needs', 'inputs'])({
      github: {
        event_name: eventName,
        repository,
        ref: 'refs/heads/non-default-candidate',
        sha: 'a'.repeat(40),
        event: { pull_request: { draft } }
      },
      needs,
      inputs: {}
    }).coerceString() === 'true'
  )
}

it.each(workflows)('$file starts no CI jobs for a draft PR', ({ workflow, repository }) => {
  const needs = Object.fromEntries(
    Object.keys(workflow.jobs).map((id) => [id, { result: 'skipped', outputs: {} }])
  )
  for (const [id, job] of Object.entries(workflow.jobs)) {
    // Jobs without a status function inherit success(), so skipped parents block them.
    if (job.needs && !/\b(?:cancelled|always|success|failure)\(/.test(job.if ?? '')) {
      continue
    }
    expect(admitted(job.if, true, needs, 'pull_request', repository), id).toBe(false)
  }
})

it.each(workflows)(
  '$file starts CI when ready and cancels it when drafted',
  ({ workflow, repository }) => {
    const types = workflow.on.pull_request.types
    expect(types).toEqual(
      expect.arrayContaining([
        'opened',
        'synchronize',
        'reopened',
        'ready_for_review',
        'converted_to_draft'
      ])
    )
    expect(
      Object.values(workflow.jobs).some(
        (job) => !job.needs && admitted(job.if, false, {}, 'pull_request', repository)
      )
    ).toBe(true)
    const concurrency = workflow.concurrency['cancel-in-progress']
    expect(
      typeof concurrency === 'boolean'
        ? concurrency
        : admitted(concurrency, true, {}, 'pull_request', repository)
    ).toBe(true)
  }
)

it.each(workflows)('$file keeps its non-PR entry points eligible', ({ workflow, repository }) => {
  const needs = Object.fromEntries(
    Object.keys(workflow.jobs).map((id) => [id, { result: 'success', outputs: {} }])
  )
  for (const event of Object.keys(workflow.on).filter((name) => name !== 'pull_request')) {
    for (const [id, job] of Object.entries(workflow.jobs)) {
      expect(admitted(job.if, true, needs, event, repository), `${event}/${id}`).toBe(
        admitted(job.if, false, needs, event, repository)
      )
    }
  }
})

for (const { file, workflow, repository } of workflows.filter(({ file }) =>
  file.startsWith('fork-')
)) {
  it(`${file} keeps fork-only manual exact-head testing available`, () => {
    for (const job of Object.values(workflow.jobs)) {
      expect(admitted(job.if, true, {}, 'workflow_dispatch', repository)).toBe(true)
      expect(admitted(job.if, false, {}, 'pull_request', 'stablyai/orca')).toBe(false)
      const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'))
      expect(checkout.with['persist-credentials']).toBe(false)
      expect(checkout.with.ref).toBeUndefined()
    }
    expect(workflow.permissions).toEqual({ contents: 'read' })
  })
}

it('keeps the root and README guards on ready docs-only PRs without another runner', () => {
  const { workflow: prWorkflow } = workflows.find(({ file }) => file === 'pr.yml')
  const detector = prWorkflow.jobs.code_paths
  const eligible = compileAggregateExpression(detector.if ?? 'true', ['github', 'steps', 'needs'])
  expect(admitted(detector.if, true)).toBe(false)
  expect(admitted(prWorkflow.jobs.verify.if, true)).toBe(false)
  for (const shouldRun of ['false', 'true']) {
    expect(
      eligible({
        github: { event_name: 'pull_request', event: { pull_request: { draft: false } } },
        steps: { filter: { outputs: { should_run: shouldRun } } },
        needs: {}
      }).coerceString()
    ).toBe('true')
  }
  expect(detector.needs).toBeUndefined()
  for (const name of ['Reject new root-level files and folders', 'Check README local links']) {
    const step = detector.steps.find((candidate) => candidate.name === name)
    expect(step).toBeDefined()
    expect(step.if).toBeUndefined()
  }
  expect(prWorkflow.jobs.root_directory_guard).toBeUndefined()
})
