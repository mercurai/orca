import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const workflow = readFileSync(
  resolve(import.meta.dirname, '..', '..', '..', '.github', 'workflows', 'fork-sync-upstream.yml'),
  'utf8'
).replaceAll('\r\n', '\n')
const code = workflow
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')
const header = code.slice(0, code.indexOf('\njobs:\n'))
const steps = code
  .slice(code.indexOf('\njobs:\n'))
  .split(/^ {6}- /m)
  .slice(1)
const nameOf = (step) => /^name: (.+)$/m.exec(step)?.[1]
const step = (name) => {
  const found = steps.find((item) => nameOf(item) === name)
  assert.ok(found, `Missing workflow step: ${name}`)
  return found
}
const mode = step('Decide whether this run may push')
const MAIN = 'Mirror main (fast-forward only)'
const MERGE = 'Merge main forward into the fork branch'
const SIDE_EFFECTS = [
  'Mirror new tags',
  'Hand the newest release tag to fork-rebase-patches',
  'Mirror upstream branches under upstream/*',
  'Report a guarded upstream range as an issue',
  'Report a merge conflict as an issue',
  'Mirror the owner-allowed tag',
  'Hand the owner-allowed tag to fork-rebase-patches',
  'Open review issues for skipped release tags'
]
const WRITERS = [MAIN, MERGE, ...SIDE_EFFECTS]
const SHA = 'a'.repeat(40)

function expression(value, context) {
  if (!value.includes('${{')) {
    return value
  }
  const body = /^\$\{\{\s*([\s\S]*?)\s*\}\}$/.exec(value)?.[1]
  assert.ok(body, `Expected one complete workflow expression: ${value}`)
  assert.match(body, /^[\w\s.'()!<>=&|/-]+$/)
  return runInNewContext(
    body,
    { ...context, cancelled: () => context.cancelled === true },
    { timeout: 1000 }
  )
}

function fields(block, indent, context) {
  const result = {}
  for (const [, key, value] of block.matchAll(new RegExp(`^ {${indent}}([A-Z_]+): (.+)$`, 'gm'))) {
    result[key] = String(expression(value, context) ?? '')
  }
  return result
}

function fixture(inputs = {}, eventName = 'workflow_dispatch', refName = 'mercurai') {
  const context = {
    github: {
      event_name: eventName,
      ref_name: refName,
      event: { repository: { default_branch: 'mercurai' } }
    },
    inputs: {
      mirror_main_only: false,
      mirror_branches: false,
      dry_run: false,
      allow_tag: '',
      allow_guarded_merge_sha: '',
      ...inputs
    },
    secrets: { FORK_BOT_TOKEN: 'fixture-only' },
    env: {},
    steps: {
      mode: { outputs: {} },
      guard: { outputs: { refused: 'false', allowed: 'true' } },
      fetch: { outcome: 'success', outputs: { upstream_sha: SHA } },
      tags: { outputs: { rebase_tag: 'v1.2.3' } },
      allowtag: { outputs: { tag: inputs.allow_tag ? 'v1.2.3' : '', sha: SHA } },
      merge: { outputs: { guarded: 'false', conflict: 'false' } },
      dispatch: { outputs: {} },
      mainmirror: { outcome: 'success' }
    }
  }
  context.env = fields(header, 2, context)
  return context
}

function runStep(block, context) {
  const script = /\n {8}run: \|\n([\s\S]*)$/
    .exec(block)?.[1]
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n')
  assert.ok(script, `The actual workflow step must contain its Bash decision: ${nameOf(block)}`)
  const rendered = script.replace(/\$\{\{[\s\S]*?\}\}/g, (value) =>
    String(expression(value, context) ?? '')
  )
  const root = mkdtempSync(join(tmpdir(), 'orca-sync-main-only-'))
  const output = join(root, 'github-output')
  writeFileSync(output, '')
  try {
    const result = spawnSync('bash', ['--noprofile', '--norc', '-c', rendered], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        GITHUB_EVENT_NAME: context.github.event_name,
        GITHUB_OUTPUT: output.replaceAll('\\', '/'),
        ...context.env,
        ...fields(block, 10, context)
      },
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true
    })
    assert.ifError(result.error)
    const lines = readFileSync(output, 'utf8').trim().split('\n').filter(Boolean)
    const outputs = Object.fromEntries(lines.map((line) => line.split(/=(.*)/s).slice(0, 2)))
    return { ...result, outputs, output: lines.join('\n') }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const runMode = (context) => runStep(mode, context)

function condition(block, context, indent = 8) {
  const value = new RegExp(`^ {${indent}}if: (.+)$`, 'm').exec(block)?.[1]
  return value === undefined || Boolean(expression(value, context))
}

function admittedWriters(context) {
  if (!condition(code.slice(code.indexOf('\n  mirror:\n')), context, 4)) {
    return []
  }
  const decision = runMode(context)
  assert.equal(decision.status, 0, decision.stderr)
  context.steps.mode.outputs = decision.outputs
  return WRITERS.filter((name) => condition(step(name), context))
}

test('main-only is an opt-in boolean and its decision precedes every writer', () => {
  const input = /^ {6}mirror_main_only:\n((?: {8}.+\n)+)/m.exec(header)?.[1]
  assert.ok(input, 'Missing explicit mirror_main_only dispatch input.')
  assert.match(input, /^ {8}type: boolean$/m)
  assert.match(input, /^ {8}default: false$/m)
  for (const name of WRITERS) {
    assert.ok(steps.indexOf(mode) < steps.indexOf(step(name)), name)
  }
})

test('a reviewed manual main-only request admits only the main mirror and merge-forward', () => {
  const context = fixture({ mirror_main_only: true, allow_guarded_merge_sha: SHA })
  context.steps.allowtag.outputs.tag = 'v1.2.3'
  const decision = runMode(context)
  assert.equal(decision.status, 0, decision.stderr)
  assert.equal(decision.outputs.main_only, 'true')
  assert.equal(decision.outputs.push, 'true')
  assert.deepEqual(admittedWriters(context), [MAIN, MERGE])
  assert.equal(context.env.ALLOWED_SHA, SHA)
})

for (const [name, inputs, event] of [
  ['missing pin', { allow_guarded_merge_sha: '' }],
  ['short pin', { allow_guarded_merge_sha: 'a'.repeat(39) }],
  ['long pin', { allow_guarded_merge_sha: 'a'.repeat(41) }],
  ['nonhex pin', { allow_guarded_merge_sha: 'g'.repeat(40) }],
  ['multiline pin', { allow_guarded_merge_sha: `${SHA}\n` }],
  ['owner tag', { allow_tag: `v1.2.3@${SHA}` }],
  ['branch mirror', { mirror_branches: true }],
  ['scheduled request', {}, 'schedule'],
  ['repository dispatch', {}, 'repository_dispatch'],
  ['pull request', {}, 'pull_request']
]) {
  test(`main-only rejects ${name} before advertising write permission`, () => {
    const context = fixture(
      { mirror_main_only: true, allow_guarded_merge_sha: SHA, ...inputs },
      event
    )
    const decision = runMode(context)
    assert.notEqual(decision.status, 0, `${name} was accepted: ${decision.stdout}`)
    assert.doesNotMatch(decision.output, /^push=true$/m)
  })
}

test('main-only keeps both upstream range refusal and merge-result refusal effective', () => {
  for (const guard of ['false', 'true']) {
    const context = fixture({ mirror_main_only: true, allow_guarded_merge_sha: SHA })
    context.steps.guard.outputs.refused = guard
    context.steps.merge.outputs.guarded = 'true'
    context.steps.merge.outputs.conflict = 'true'
    assert.deepEqual(admittedWriters(context), guard === 'true' ? [] : [MAIN, MERGE])
  }
  const merge = step(MERGE)
  assert.match(merge, /bash \/tmp\/merge-forward\.sh/)
  assert.match(
    merge,
    /cp config\/mercurai\/scripts\/merge-forward\.sh config\/mercurai\/scripts\/merge-result-guard\.sh \/tmp\//
  )
  assert.match(
    step('Guard every push and the merge-forward'),
    /run: bash config\/mercurai\/scripts\/guard-step\.sh/
  )
})

test('main-only dry-run keeps the merge report-only and supplies it no token', () => {
  const context = fixture({ mirror_main_only: true, allow_guarded_merge_sha: SHA, dry_run: true })
  const decision = runMode(context)
  assert.equal(decision.status, 0, decision.stderr)
  assert.equal(decision.outputs.main_only, 'true')
  assert.equal(decision.outputs.push, 'false')
  assert.deepEqual(admittedWriters(context), [MERGE])
  assert.equal(fields(step(MERGE), 10, context).GH_TOKEN, '')
  assert.ok(step(MERGE).indexOf('report-only run') < step(MERGE).indexOf('GIT_CONFIG_COUNT'))
})

test('untrusted refs cannot reach the protected job, checkout, mode or any writer', () => {
  for (const inputs of [{}, { mirror_main_only: true, allow_guarded_merge_sha: SHA }]) {
    assert.deepEqual(admittedWriters(fixture(inputs, 'workflow_dispatch', 'untrusted-feature')), [])
  }
  assert.match(code, /^ {4}environment:\n {6}name: mercurai-sync$/m)
  assert.match(header, /^permissions:\n {2}contents: read$/m)
  assert.doesNotMatch(header, /\bsecrets\b/)
  assert.match(code, /persist-credentials: false/)
  assert.doesNotMatch(
    step('Guard every push and the merge-forward'),
    /\bsecrets\b|GH_TOKEN|GIT_CONFIG_/
  )
})

test('normal manual mode retains tags, both rebase handoffs, optional branches and review issues', () => {
  const context = fixture({ mirror_branches: true, allow_tag: `v1.2.3@${SHA}` })
  assert.deepEqual(
    admittedWriters(context),
    WRITERS.filter(
      (name) =>
        ![
          'Report a guarded upstream range as an issue',
          'Report a merge conflict as an issue'
        ].includes(name)
    )
  )
  assert.equal(context.steps.mode.outputs.main_only, 'false')
  context.steps.guard.outputs.refused = 'true'
  context.steps.merge.outputs.conflict = 'true'
  assert.deepEqual(admittedWriters(context), [
    'Report a guarded upstream range as an issue',
    'Report a merge conflict as an issue',
    'Mirror the owner-allowed tag',
    'Hand the owner-allowed tag to fork-rebase-patches',
    'Open review issues for skipped release tags'
  ])
})

test('normal schedules still mirror eligible main and tags and normal dry-run stays tokenless', () => {
  const context = fixture({}, 'schedule')
  assert.deepEqual(admittedWriters(context), [
    MAIN,
    MERGE,
    'Mirror new tags',
    'Hand the newest release tag to fork-rebase-patches',
    'Open review issues for skipped release tags'
  ])
  assert.equal(context.env.ALLOWED_SHA, '')
  assert.equal(context.env.ALLOW_TAG, '')
  const dryRun = fixture({ dry_run: true })
  assert.deepEqual(admittedWriters(dryRun), [MERGE])
  assert.equal(fields(step(MERGE), 10, dryRun).GH_TOKEN, '')
})

function resultFixture(dryRun = false) {
  const context = fixture({ mirror_main_only: true, allow_guarded_merge_sha: SHA, dry_run: dryRun })
  context.steps.mode.outputs = { main_only: 'true', push: dryRun ? 'false' : 'true' }
  context.steps.guard.outcome = 'success'
  context.steps.mainmirror.outcome = dryRun ? 'skipped' : 'success'
  context.steps.merge.outcome = 'success'
  return context
}

test('the tokenless main-only result check runs after merge, before issue reporting, unless cancelled', () => {
  const result = step('Verify main-only result')
  assert.ok(steps.indexOf(result) > steps.indexOf(step(MERGE)))
  assert.ok(
    steps.indexOf(result) < steps.indexOf(step('Report a guarded upstream range as an issue'))
  )
  assert.doesNotMatch(result, /\bsecrets\b|GH_TOKEN|GIT_CONFIG_|\bgit push\b|^\s+gh /m)
  const context = resultFixture()
  assert.equal(condition(result, context), true)
  context.steps.mode.outputs.main_only = 'false'
  assert.equal(condition(result, context), false)
  context.steps.mode.outputs.main_only = 'true'
  context.cancelled = true
  assert.equal(condition(result, context), false)
})

test('main-only result accepts successful or unchanged merges and successful dry-run checks', () => {
  for (const dryRun of [false, true]) {
    const result = runStep(step('Verify main-only result'), resultFixture(dryRun))
    assert.equal(result.status, 0, result.stderr)
  }
})

for (const [name, changes] of [
  [
    'range refusal or guard failure',
    [
      ['guard', 'outputs', 'refused', 'true'],
      ['guard', 'outcome', 'failure']
    ]
  ],
  [
    'main mirror failure',
    [
      ['mainmirror', 'outcome', 'failure'],
      ['mainmirror', 'outcome', 'skipped'],
      ['mainmirror', 'outcome', 'cancelled']
    ]
  ],
  [
    'merge failure',
    [
      ['merge', 'outcome', 'failure'],
      ['merge', 'outcome', 'skipped'],
      ['merge', 'outcome', 'cancelled']
    ]
  ],
  ['guarded merge result', [['merge', 'outputs', 'guarded', 'true']]],
  ['merge conflict', [['merge', 'outputs', 'conflict', 'true']]],
  [
    'missing results',
    [
      ['mode', 'outputs', 'push'],
      ['guard', 'outcome'],
      ['guard', 'outputs', 'refused'],
      ['mainmirror', 'outcome'],
      ['merge', 'outcome'],
      ['merge', 'outputs', 'guarded'],
      ['merge', 'outputs', 'conflict']
    ]
  ]
]) {
  test(`main-only result fails closed for ${String(name)}`, () => {
    for (const change of changes) {
      const context = resultFixture()
      const keys = change.slice(0, -1)
      const value = name === 'missing results' ? undefined : change.at(-1)
      const path = name === 'missing results' ? change : keys
      const target = path.slice(0, -1).reduce((current, key) => current[key], context.steps)
      if (value === undefined) {
        delete target[path.at(-1)]
      } else {
        target[path.at(-1)] = value
      }
      const result = runStep(step('Verify main-only result'), context)
      assert.notEqual(result.status, 0, `${String(name)}: ${path.join('.')} was accepted`)
    }
  })
}
