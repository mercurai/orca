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
      // Quote the whole line the match sits on. Slicing around the match index cut words in half and made the
      // evidence unreadable in review (`[roblem]`).
      const start = text.lastIndexOf('\n', match.index) + 1
      const end = text.indexOf('\n', match.index)
      const line = text.slice(start, end === -1 ? text.length : end).trim()
      if (line.length > 0) {
        return line.slice(0, 200)
      }
    }
  }
  return null
}

const ACTIONABLE_EVIDENCE = [
  /\bat [\w./-]+\.(?:ts|tsx|mjs|cjs|js|py|rs|go):\d+/,
  /steps to reproduce/i,
  /expected(?: behaviour| behavior)?:.*\n.*actual/i,
  /\b(?:panic|unexpected EOF|TypeError|ReferenceError|ENOENT|EACCES)\b/,
  // The verb forms that actually appear in titles and bodies: Adds, Fixes, Implemented, not only the bare stem.
  /\b(?:add|fix|implement|update|remove|repair)\w*\b.*\b[\w./-]+\.(?:ts|tsx|mjs|cjs|md)\b/i,
  // The fork writes its own work items as a spec: an Implementation section and explicit acceptance criteria.
  /^#{2,3} +(?:implementation|acceptance criteria|target)\b/im
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
  // A ready pull request waiting on review is a decision for the owner, not abandoned work. Only a draft, an
  // `ci-only` lane, or an explicitly stale-labelled item is garbage. Calling the controller PR stale would have
  // the agent propose closing the very fix the release needs.
  const ciOnly = kind === 'pr' && String(item.headRefName ?? '').startsWith('ci-only/')
  const abandonedLane =
    kind === 'pr' && (item.isDraft === true || ciOnly || labels.includes('stale-candidate'))
  if (age !== null && age >= staleDays && abandonedLane) {
    return {
      ...base,
      label: 'stale',
      reason: `${ciOnly ? 'ci-only lane' : 'draft'} ${kind} has had no activity for ${age} days (threshold ${staleDays})`,
      evidence: `updatedAt=${item.updatedAt ?? 'unknown'} head=${item.headRefName ?? 'unknown'}`
    }
  }
  if (kind === 'pr' && age !== null && age >= staleDays) {
    return {
      ...base,
      label: 'needs-decision',
      reason: `ready for review, waiting ${age} days on an owner decision`,
      evidence: `updatedAt=${item.updatedAt ?? 'unknown'}`
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

function gh(argv, what) {
  const result = spawnSync('gh', argv, { encoding: 'utf8', shell: false, windowsHide: true })
  if (result.status !== 0) {
    throw new Error(`${what} failed (${result.status}): ${String(result.stderr ?? '').trim()}`)
  }
  const stdout = String(result.stdout ?? '').trim()
  if (stdout.length === 0) {
    return []
  }
  // `gh api --jq '.[]'` streams one object per line; `gh pr list --json` prints one array. Accept both.
  try {
    const parsed = JSON.parse(stdout)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return stdout
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line))
  }
}

/**
 * Both queues, never one: the fork's backlog is mostly pull requests, and a triage agent that only reads issues
 * would report an empty backlog while eight integration PRs compete for the same release.
 */
function ghItems(repo) {
  const issues = gh(
    [
      'api',
      '--paginate',
      `repos/${repo}/issues?state=open&per_page=100`,
      '--jq',
      '.[] | select(.pull_request == null) | {number, title, body, state, labels: [.labels[].name], updatedAt, createdAt}'
    ],
    'gh api issues'
  )
  const pulls = gh(
    [
      'pr',
      'list',
      '--repo',
      repo,
      '--state',
      'open',
      '--limit',
      '200',
      '--json',
      'number,title,body,isDraft,headRefName,labels,updatedAt,createdAt'
    ],
    'gh pr list'
  ).map((pull) => ({
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: 'open',
    labels: (pull.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name)),
    updatedAt: pull.updatedAt,
    createdAt: pull.createdAt,
    pullRequest: true,
    isDraft: pull.isDraft === true,
    headRefName: pull.headRefName
  }))
  return [...issues, ...pulls]
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
  const explain = values.get('explain') === true
  const staleDays = Number(values.get('stale-days') ?? 7)
  try {
    const items = itemsPath ? JSON.parse(readFileSync(String(itemsPath), 'utf8')) : ghItems(String(repo))
    const now = Date.now()
    if (explain) {
      // One line per item: what it is, why, and the quoted evidence. This is the review surface for a human
      // who does not want to read a JSON blob to find out why their PR was parked.
      const queue = buildTriageQueue(items, { now, staleDays })
      for (const item of queue.actionable
        .concat(queue.parked)
        .sort((left, right) => left.key.localeCompare(right.key))) {
        console.log(`${item.label.padEnd(15)} ${item.key.padEnd(12)} ${item.reason}  [${item.evidence ?? ''}]`)
      }
    } else if (!statePath) {
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
