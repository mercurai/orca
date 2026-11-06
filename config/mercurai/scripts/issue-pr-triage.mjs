import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

import { parkItem } from './release-state.mjs'

/**
 * Triage classifies and parks. It never closes, labels, comments on, or merges anything: a task spec is the
 * only output, and a separate reviewed workflow or a human acts on it.
 */
export const TRIAGE_LABELS = ['actionable', 'needs-decision', 'stale', 'duplicate', 'superseded']

const DAY = 86_400_000
const SYNC_PREFIXES = [/^fork-sync tag:/i, /^fork-sync guard:/i, /^fork-sync:/i]

function isSyncIssue(title) {
  return SYNC_PREFIXES.some((prefix) => prefix.test(String(title ?? '')))
}

function ageDays(iso, now) {
  const parsed = Date.parse(String(iso ?? ''))
  if (!Number.isFinite(parsed)) {
    return null
  }
  return Math.floor((now - parsed) / DAY)
}

/** Evidence is a quoted line from the item itself; a label without a quote is not a finding. */
function evidenceFor(body, patterns) {
  const text = String(body ?? '')
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match) {
      const line = text.slice(Math.max(0, match.index - 60), match.index + 120).split('\n')[0]
      return line.trim().slice(0, 200)
    }
  }
  return null
}

const ACTIONABLE_EVIDENCE = [
  /\bat [\w./-]+\.(?:ts|tsx|mjs|cjs|js|py|rs|go):\d+/,
  /steps to reproduce/i,
  /expected(?: behaviour| behavior)?:.*\n.*actual/i,
  /\b(?:panic|unexpected EOF|TypeError|ReferenceError|ENOENT|EACCES)\b/,
  /\b(?:add|fix|implement|regression test)\b.*\b[\w./-]+\.(?:ts|tsx|mjs|cjs|md)\b/i
]

export function classifyItem(item, { now = Date.now(), staleDays = 7 } = {}) {
  if (!item || !Number.isInteger(item.number) || item.number <= 0) {
    throw new TypeError('item.number must be a positive integer')
  }
  const kind = item.pullRequest === true ? 'pr' : 'issue'
  const key = `${kind}:${item.number}`
  const title = String(item.title ?? '')
  const age = ageDays(item.updatedAt ?? item.createdAt, now)
  const labels = Array.isArray(item.labels) ? item.labels.map((label) => String(label)) : []
  const base = { kind, number: item.number, key, title, ageDays: age, labels }

  if (isSyncIssue(title)) {
    return { ...base, label: 'needs-decision', reason: 'fork-sync bookkeeping is owned by the release coordinator', evidence: title }
  }
  if (item.state && item.state !== 'open') {
    return { ...base, label: 'superseded', reason: `item is already ${item.state}`, evidence: `state=${item.state}` }
  }
  if (labels.includes('duplicate')) {
    return { ...base, label: 'duplicate', reason: 'labelled duplicate', evidence: 'label=duplicate' }
  }
  if (labels.includes('do-not-merge') || labels.includes('needs-design')) {
    return { ...base, label: 'needs-decision', reason: `labelled ${labels.find((l) => l === 'do-not-merge' || l === 'needs-design')}`, evidence: `labels=${labels.join(',')}` }
  }
  if (age !== null && age >= staleDays && (kind === 'pr' || labels.includes('stale-candidate'))) {
    return {
      ...base,
      label: 'stale',
      reason: `${kind} has had no activity for ${age} days (threshold ${staleDays})`,
      evidence: `updatedAt=${item.updatedAt ?? 'unknown'}`
    }
  }
  if (kind === 'pr' && String(item.headRefName ?? '').startsWith('ci-only/')) {
    return {
      ...base,
      label: 'stale',
      reason: 'ci-only lane branch, kept out of the default branch by convention',
      evidence: `head=${item.headRefName}`
    }
  }
  const evidence = evidenceFor(item.body, ACTIONABLE_EVIDENCE)
  if (evidence) {
    return { ...base, label: 'actionable', reason: 'the body names a concrete failure or a file to change', evidence }
  }
  return {
    ...base,
    label: 'needs-decision',
    reason: 'no reproduction, stack trace, or named file to act on',
    evidence: `bodyLength=${String(item.body ?? '').length}`
  }
}

/** One task spec per actionable item. It is markdown, contains no placeholder token, and is safe to dispatch. */
export function buildTaskSpec(item) {
  const kind = item.kind === 'pr' ? 'pull request' : 'issue'
  const lines = [
    `# Task: ${item.title || `${kind} ${item.number}`}`,
    '',
    `Repo: mercurai/orca`,
    `Item: ${kind} ${item.number} (${item.key})`,
    `Base: the frozen candidate sha recorded in the release state`,
    '',
    '## Objective',
    '',
    `Resolve ${kind} ${item.number}: ${item.title || '(untitled)'}`,
    '',
    '## Evidence',
    '',
    '```',
    item.evidence || '(none quoted)',
    '```',
    '',
    '## Writable paths',
    '',
    item.writablePaths?.length
      ? item.writablePaths.map((path) => `- ${path}`).join('\n')
      : '- determine from the evidence above; touch nothing outside the failing area',
    '',
    '## Acceptance',
    '',
    '- The behaviour named in the evidence is reproduced by a test before it is fixed.',
    '- The new test fails without the change and passes with it.',
    '- No unrelated file is modified, and no release gate is weakened.',
    '- Report the files changed, the test command, and its result.',
    '',
    '## Attempt limit',
    '',
    'One initial attempt and at most two evidence-driven corrections. On the third failure, report the blocker.',
    ''
  ]
  return lines.join('\n')
}

export function buildTriageQueue(items, { now = Date.now(), staleDays = 7 } = {}) {
  if (!Array.isArray(items)) {
    throw new TypeError('items must be an array')
  }
  const classified = items.map((item) => classifyItem(item, { now, staleDays }))
  const actionable = classified.filter((item) => item.label === 'actionable')
  const parked = classified.filter((item) => item.label !== 'actionable')
  return {
    actionable,
    parked,
    tasks: actionable.map((item) => ({ key: item.key, path: taskSpecPath(item.key), spec: buildTaskSpec(item) })),
    counts: {
      actionable: actionable.length,
      parked: parked.length,
      stale: classified.filter((item) => item.label === 'stale').length,
      needsDecision: classified.filter((item) => item.label === 'needs-decision').length
    }
  }
}

export function taskSpecPath(key) {
  return `.release-state/task-spec-${String(key).replace(/[^A-Za-z0-9._-]/g, '-')}.md`
}

/** Merge the queue into durable state: park everything that is not actionable, and clear items that left. */
export function applyTriage(state, { items, now = Date.now(), staleDays = 7 } = {}) {
  const queue = buildTriageQueue(items, { now, staleDays })
  let next = state
  for (const item of queue.parked) {
    next = parkItem(
      next,
      {
        kind: 'issue-pr',
        key: item.key,
        reason: `${item.label}: ${item.reason}`,
        unblocksAt: null,
        evidence: { number: item.number, title: item.title, quoted: item.evidence }
      },
      { now: new Date(now).toISOString() }
    )
  }
  const parkedKeys = new Set(queue.parked.map((item) => item.key))
  for (const entry of next.parked ?? []) {
    if (entry.kind !== 'issue-pr' || parkedKeys.has(entry.key)) {
      continue
    }
    next = {
      ...next,
      version: next.version + 1,
      parked: next.parked.filter((candidate) => !(candidate.kind === 'issue-pr' && candidate.key === entry.key)),
      updatedAt: new Date(now).toISOString()
    }
  }
  return { state: next, queue }
}

function ghItems(repo) {
  const result = spawnSync(
    'gh',
    [
      'api',
      '--paginate',
      `repos/${repo}/issues?state=open&per_page=100`,
      '--jq',
      '.[] | select(.pull_request == null) | {number, title, body, state, labels: [.labels[].name], updatedAt, createdAt}'
    ],
    { encoding: 'utf8', shell: false, windowsHide: true }
  )
  if (result.status !== 0) {
    throw new Error(`gh api failed (${result.status}): ${String(result.stderr ?? '').trim()}`)
  }
  return String(result.stdout ?? '')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

function flags(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) {
      continue
    }
    const next = argv[index + 1]
    values.set(argv[index].slice(2), next === undefined || next.startsWith('--') ? true : next)
    if (next !== undefined && !next.startsWith('--')) {
      index += 1
    }
  }
  return values
}

if (process.argv[1] && process.argv[1].endsWith('issue-pr-triage.mjs')) {
  const values = flags(process.argv.slice(2))
  const repo = values.get('repo') ?? 'mercurai/orca'
  const itemsPath = values.get('items')
  const statePath = values.get('state')
  const dryRun = values.get('dry-run') === true
  const staleDays = Number(values.get('stale-days') ?? 7)
  try {
    const items = itemsPath ? JSON.parse(readFileSync(String(itemsPath), 'utf8')) : ghItems(String(repo))
    const now = Date.now()
    if (!statePath) {
      const queue = buildTriageQueue(items, { now, staleDays })
      console.log(JSON.stringify({ dryRun: true, counts: queue.counts, tasks: queue.tasks.map((task) => task.path) }))
    } else {
      const state = JSON.parse(readFileSync(String(statePath), 'utf8'))
      const { state: next, queue } = applyTriage(state, { items, now, staleDays })
      if (!dryRun) {
        const { writeFileSync } = await import('node:fs')
        writeFileSync(String(statePath), `${JSON.stringify(next, null, 2)}\n`)
      }
      console.log(
        JSON.stringify({
          dryRun,
          counts: queue.counts,
          tasks: queue.tasks.map((task) => task.path),
          parked: next.parked.filter((entry) => entry.kind === 'issue-pr').length
        })
      )
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

export const TRIAGE_PROMPT_PATH = 'config/mercurai/automation/issue-pr-triage.md'
const TRIAGE_STATE_PATH = '.release-state/release-state.json'

export const TRIAGE_AUTOMATION_PROMPT = [
  `Read ${TRIAGE_PROMPT_PATH} and follow it exactly.`,
  `Run node config/mercurai/scripts/issue-pr-triage.mjs --state ${TRIAGE_STATE_PATH} --dry-run first.`,
  'If it reports no actionable item, report the counts and stop. A quiet backlog is a success.',
  'Otherwise run it without --dry-run, then dispatch one bounded worker per actionable item through release-agent-dispatch.mjs --spec-file, never more than two live.',
  'Never close, label, comment on, merge, tag, or publish anything.'
].join(' ')

export function buildTriageAutomationSpec({
  statePath = TRIAGE_STATE_PATH,
  repo,
  provider = 'pi',
  promptPath = TRIAGE_PROMPT_PATH
} = {}) {
  if (typeof statePath !== 'string' || statePath.length === 0) {
    throw new TypeError('statePath is required')
  }
  if (typeof promptPath !== 'string' || promptPath.length === 0) {
    throw new TypeError('promptPath is required')
  }
  return {
    name: 'Mercurai issue and PR triage',
    trigger: '0 */2 * * *',
    provider,
    enabled: false,
    promptPath,
    ...(repo ? { repo } : {}),
    precheck: `node config/mercurai/scripts/issue-pr-triage.mjs --state ${statePath} --dry-run`,
    prompt: TRIAGE_AUTOMATION_PROMPT.replaceAll(TRIAGE_STATE_PATH, statePath).replaceAll(
      TRIAGE_PROMPT_PATH,
      promptPath
    )
  }
}

export function buildTriageAutomationArgs(options = {}) {
  const spec = buildTriageAutomationSpec(options)
  return [
    'automations',
    'create',
    '--name',
    spec.name,
    '--trigger',
    spec.trigger,
    '--precheck',
    spec.precheck,
    '--prompt',
    spec.prompt,
    '--provider',
    spec.provider,
    ...(spec.repo ? ['--repo', spec.repo] : []),
    '--disabled',
    '--json'
  ]
}
