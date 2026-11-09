import assert from 'node:assert/strict'
import { test } from 'node:test'

import { applyTriage, buildTaskSpec, buildTriageQueue, classifyItem, taskSpecPath } from './issue-pr-triage.mjs'
import { checkTaskSpec } from './release-agent-dispatch.mjs'
import { createState, findParked } from './release-state.mjs'

const NOW = Date.parse('2026-11-03T17:00:00Z')
const DAY = 86_400_000
const SHA = 'a'.repeat(40)

function target() {
  return {
    upstreamMainSha: SHA,
    stableTag: 'v1.4.242',
    stableTagSha: SHA,
    controllerSha: SHA,
    patchHeads: [{ branch: 'patch/current-main-release', commit: SHA }]
  }
}

function issue(overrides = {}) {
  return {
    number: 90,
    title: 'Shell wrapper breaks bash -c quoting',
    body: 'Fails at src/main/shell/wrapper.ts:41 with unexpected EOF while looking for a matching quote.',
    state: 'open',
    labels: ['bug'],
    createdAt: new Date(NOW - 3 * DAY).toISOString(),
    updatedAt: new Date(NOW - 2 * DAY).toISOString(),
    pullRequest: false,
    ...overrides
  }
}

test('classifies an issue with a file:line and a failure as actionable', () => {
  const result = classifyItem(issue(), { now: NOW })

  assert.equal(result.label, 'actionable')
  assert.equal(result.key, 'issue:90')
  assert.match(result.evidence, /src\/main\/shell\/wrapper\.ts:41/)
})

test('classifies a draft with no recent activity as stale, quoting its age', () => {
  const result = classifyItem(
    issue({
      number: 39,
      title: 'ci-only: dry-run assembly (do not merge)',
      body: 'nothing to see',
      pullRequest: true,
      headRefName: 'ci-only/v1.4.224/assembly-dry-run-2',
      labels: [],
      updatedAt: new Date(NOW - 23 * DAY).toISOString()
    }),
    { now: NOW }
  )

  assert.equal(result.label, 'stale')
  assert.match(result.reason, /23 days/)
})

test('classifies an empty report as needing a decision, never as actionable', () => {
  const result = classifyItem(issue({ number: 91, title: 'Something feels slow', body: '' }), { now: NOW })

  assert.equal(result.label, 'needs-decision')
  assert.match(result.reason, /no reproduction/)
})

test('leaves fork-sync bookkeeping to the coordinator', () => {
  const result = classifyItem(
    issue({ number: 43, title: 'fork-sync guard: upstream main abc changes guarded paths; nothing was pushed', body: '' }),
    { now: NOW }
  )

  assert.equal(result.label, 'needs-decision')
  assert.match(result.reason, /release coordinator/)
})

test('honours duplicate and do-not-merge labels before any content heuristic', () => {
  assert.equal(classifyItem(issue({ labels: ['duplicate'] }), { now: NOW }).label, 'duplicate')
  assert.equal(classifyItem(issue({ labels: ['do-not-merge'] }), { now: NOW }).label, 'needs-decision')
})

test('builds a queue whose task specs survive the dispatch validator', () => {
  const queue = buildTriageQueue(
    [
      issue(),
      issue({ number: 92, title: 'Crash on start', body: 'TypeError: cannot read property of undefined' }),
      issue({ number: 93, title: 'Vague', body: '' })
    ],
    { now: NOW }
  )

  assert.equal(queue.counts.actionable, 2)
  assert.equal(queue.counts.parked, 1)
  for (const task of queue.tasks) {
    assert.doesNotThrow(() => checkTaskSpec(task.spec))
    assert.equal(task.path, taskSpecPath(task.key))
    assert.match(task.spec, /## Acceptance/)
  }
})

test('parks everything that is not actionable and keeps the actionable items dispatchable', () => {
  const state = createState(target())
  const { state: next, queue } = applyTriage(state, {
    items: [issue(), issue({ number: 93, title: 'Vague', body: '' })],
    now: NOW
  })

  assert.equal(queue.counts.actionable, 1)
  assert.equal(next.parked.length, 1)
  assert.equal(findParked(next, { kind: 'issue-pr', key: 'issue:93' }).reason.startsWith('needs-decision'), true)
  assert.equal(findParked(next, { kind: 'issue-pr', key: 'issue:90' }), null)
})

test('clears an item from the parked list once it becomes actionable', () => {
  const first = applyTriage(createState(target()), {
    items: [issue({ number: 93, title: 'Vague', body: '' })],
    now: NOW
  })
  assert.equal(first.state.parked.length, 1)

  const second = applyTriage(first.state, {
    items: [issue({ number: 93, title: 'Vague', body: 'panic in src/main/x.ts:7' })],
    now: NOW + DAY
  })

  assert.equal(second.state.parked.length, 0)
  assert.equal(second.queue.counts.actionable, 1)
})

test('refuses an item without a usable number instead of guessing', () => {
  assert.throws(() => classifyItem({ title: 'no number' }, { now: NOW }), /item\.number/)
  assert.throws(() => buildTriageQueue('nope', { now: NOW }), /items must be an array/)
})

test('the task spec names the item, the evidence, and the attempt limit', () => {
  const spec = buildTaskSpec(classifyItem(issue(), { now: NOW }))

  assert.match(spec, /Item: issue 90 \(issue:90\)/)
  assert.match(spec, /unexpected EOF/)
  assert.match(spec, /One initial attempt and at most two evidence-driven corrections/)
  assert.doesNotMatch(spec, /<(?:files|paths|n)>/)
})

test('registers a disabled, prompt-file-driven triage automation that cannot publish', async () => {
  const { buildTriageAutomationArgs, buildTriageAutomationSpec } = await import('./issue-pr-triage.mjs')
  const spec = buildTriageAutomationSpec({ statePath: 's.json', repo: 'orca' })
  const args = buildTriageAutomationArgs({ statePath: 's.json', repo: 'orca' })

  assert.equal(spec.provider, 'pi')
  assert.equal(spec.enabled, false)
  assert.match(spec.prompt, /config\/mercurai\/automation\/issue-pr-triage\.md/)
  assert.match(spec.precheck, /--dry-run/)
  assert.equal(args.at(-2), '--disabled')
  assert.equal(args.includes('--enabled'), false)
  assert.doesNotMatch(args.join(' '), /FORK_BOT_TOKEN|--publish/)
})

test('reads both queues: an issue and a pull request are classified side by side', async () => {
  const { buildTriageQueue } = await import('./issue-pr-triage.mjs')
  const queue = buildTriageQueue(
    [
      issue({ number: 90 }),
      issue({
        number: 97,
        title: 'feat(fork): durable release and triage agents',
        body: 'Adds config/mercurai/scripts/release-audit.mjs',
        pullRequest: true,
        headRefName: 'codex/durable-agents-20261103',
        labels: []
      })
    ],
    { now: NOW }
  )

  assert.deepEqual(queue.actionable.map((item) => item.key).sort(), ['issue:90', 'pr:97'])
})

test('a ready pull request waiting on review is a decision, never stale work', () => {
  const result = classifyItem(
    issue({
      number: 88,
      title: 'fix(sync): add reviewed main-only ingestion mode',
      body: 'Adds config/mercurai/scripts/release-audit.mjs',
      pullRequest: true,
      isDraft: false,
      headRefName: 'codex/upstream-main-only-20261029',
      labels: [],
      updatedAt: new Date(NOW - 11 * DAY).toISOString()
    }),
    { now: NOW }
  )

  assert.equal(result.label, 'needs-decision')
  assert.match(result.reason, /ready for review, waiting 11 days/)
})

test('an issue written as a spec with acceptance criteria is actionable', () => {
  const result = classifyItem(
    issue({
      number: 78,
      title: 'Bound Pi worker concurrency by durable execution capacity',
      body: '## Summary\n\nBound Pi worker concurrency.\n\n## Acceptance Criteria\n\n- [ ] Concurrent starts cannot oversubscribe\n',
      labels: ['enhancement']
    }),
    { now: NOW }
  )

  assert.equal(result.label, 'actionable')
  assert.match(result.evidence, /Acceptance Criteria/)
})

test('quotes the whole line the evidence sits on, never a fragment', () => {
  const result = classifyItem(
    issue({
      body: 'Some preamble that is long enough to be cut.\nBash tool calls fail with `unexpected EOF`; 425 occurrences.\nTrailing line.'
    }),
    { now: NOW }
  )

  assert.equal(result.label, 'actionable')
  assert.equal(result.evidence.startsWith('Bash tool calls fail'), true)
})
