import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { createFixture, git } from './assemble-main-fixture.mjs'

const root = resolve(import.meta.dirname, '../../..')
const source = readFileSync(
  resolve(root, '.github/workflows/fork-sync-upstream.yml'),
  'utf8'
).replaceAll('\r\n', '\n')
const header = source.slice(0, source.indexOf('\njobs:\n'))
const mirror = source.slice(source.indexOf('\n  mirror:\n'))
const jobCondition = /^ {4}if: (.+)$/m.exec(mirror)?.[1]
const steps = mirror
  .split(/^ {6}- /m)
  .slice(1)
  .map((body) => ({
    name: /^name: (.+)$/m.exec(body)?.[1],
    condition: /^ {8}if: (.+)$/m.exec(body)?.[1],
    body
  }))
const step = (name) => {
  const found = steps.find((value) => value.name === name)
  assert.ok(found, `workflow step exists: ${name}`)
  return found
}
const tag = 'v1.4.241'
const pin = `${tag}@${'a'.repeat(40)}`
const modeName = 'Decide whether this run may push'
const allowedName = 'Mirror the owner-allowed tag'
const writers = [
  'Mirror main (fast-forward only)',
  'Mirror new tags',
  'Hand the newest release tag to fork-rebase-patches',
  'Mirror upstream branches under upstream/*',
  'Merge main forward into the fork branch',
  'Report a guarded upstream range as an issue',
  'Report a merge conflict as an issue',
  allowedName,
  'Hand the owner-allowed tag to fork-rebase-patches',
  'Open review issues for skipped release tags'
]

function context(inputs = {}, options = {}) {
  const event = options.event ?? 'workflow_dispatch'
  return {
    github: {
      event_name: event,
      ref_name: options.branch ?? 'mercurai',
      repository: 'fixture/orca',
      event: { repository: { default_branch: 'mercurai' } }
    },
    inputs: {
      mirror_tag_only: false,
      mirror_branches: false,
      dry_run: false,
      allow_tag: '',
      allow_guarded_merge_sha: '',
      ...inputs
    },
    env: {},
    secrets: { FORK_BOT_TOKEN: 'synthetic-token-no-service-access' },
    steps: {
      mode: { outputs: { push: '', tag_only: '' } },
      fetch: { outcome: options.fetch ?? 'success', outputs: {} },
      guard: { outputs: { refused: options.refused ?? 'false', allowed: 'false' } },
      tags: { outputs: { rebase_tag: tag } },
      dispatch: { outputs: { dispatched_tag: '', dispatched_sha: '' } },
      allowtag: {
        outputs: { tag: event === 'workflow_dispatch' && inputs.allow_tag ? tag : '', sha: '' }
      },
      merge: {
        outputs: { guarded: options.guarded ?? 'false', conflict: options.conflict ?? 'false' }
      },
      mainmirror: { outcome: 'success' }
    },
    cancelled: () => options.cancelled === true,
    always: () => true,
    success: () => options.cancelled !== true && options.fetch !== 'failure',
    failure: () => options.fetch === 'failure'
  }
}

function evaluate(expression, state) {
  const code = expression.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, '')
  return runInNewContext(code, state, {
    timeout: 1000,
    codeGeneration: { strings: false, wasm: false }
  })
}

function environment(body, indent, state) {
  const values = {}
  const pattern = new RegExp(`^ {${indent}}([A-Z_]+): (.+)$`, 'gm')
  for (const [, name, raw] of body.matchAll(pattern)) {
    const value = raw.startsWith('${{') ? evaluate(raw, state) : raw.replace(/^['"]|['"]$/g, '')
    values[name] = value === undefined || value === null ? '' : String(value)
  }
  return values
}

function script(body, state) {
  const lines = body.split('\n')
  const at = lines.indexOf('        run: |')
  assert.notEqual(at, -1, 'the actual workflow step has an executable Bash block')
  return lines
    .slice(at + 1)
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n')
    .replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expression) => String(evaluate(expression, state)))
}

function isolatedEnvironment(initial = process.env) {
  return Object.fromEntries(
    Object.entries(initial).filter(
      ([key]) =>
        !/^(GH_|GITHUB_|GIT_|BASH_ENV$|ENV$|NODE_OPTIONS$|ALLOW_TAG$|ALLOWED_SHA$|MIRROR_TAG_ONLY$|MIRROR_BRANCHES$|DRY_RUN$|DISPATCHED_|FORK_)/i.test(
          key
        )
    )
  )
}

function runMode(t, state, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-sync-mode-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const output = join(directory, 'github-output')
  const globals = header.slice(header.indexOf('\nenv:\n') + '\nenv:\n'.length)
  state.env = environment(globals, 2, state)
  if (!evaluate(jobCondition, state)) {
    return { skipped: true, status: 0, outputs: {} }
  }
  const result = spawnSync('bash', ['-c', script(step(modeName).body, state)], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...isolatedEnvironment(),
      ...state.env,
      ...environment(step(modeName).body, 10, state),
      GITHUB_EVENT_NAME: state.github.event_name,
      GITHUB_OUTPUT: output,
      ...overrides
    }
  })
  assert.equal(result.error, undefined, result.error?.message)
  const rawOutput = existsSync(output) ? readFileSync(output, 'utf8') : ''
  const outputs = Object.fromEntries(
    rawOutput
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf('=')
        return [line.slice(0, at), line.slice(at + 1)]
      })
  )
  state.steps.mode.outputs = { push: '', tag_only: '', ...outputs }
  const previousSuccess = state.success()
  const previousFailure = state.failure()
  state.success = () => result.status === 0 && previousSuccess
  state.failure = () => result.status !== 0 || previousFailure
  return { ...result, outputs, rawOutput }
}

function enabledRoutes(state) {
  if (!evaluate(jobCondition, state)) {
    return []
  }
  return writers.filter((name) => {
    const condition = step(name).condition ?? 'success()'
    const statusCheck = /\b(?:always|cancelled|success|failure)\(\)/.test(condition)
    return (statusCheck || state.success()) && Boolean(evaluate(condition, state))
  })
}

test('the tag-only switch is a manual boolean input that defaults to false', () => {
  assert.match(
    header,
    /^ {6}mirror_tag_only:\n(?: {8}.+\n)*? {8}type: boolean\n(?: {8}.+\n)*? {8}default: false$/m
  )
})

test('tag-only mode selects only the approved tag route despite unrelated guard and issue outputs', (t) => {
  for (const refused of ['false', 'true']) {
    const state = context(
      { mirror_tag_only: true, allow_tag: pin },
      { refused, guarded: 'true', conflict: 'true' }
    )
    const result = runMode(t, state)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(result.outputs, { tag_only: 'true', push: 'true' })
    assert.deepEqual(enabledRoutes(state), [allowedName])
  }
})

test('tag-only dry-run enables no write route', (t) => {
  const state = context(
    { mirror_tag_only: true, allow_tag: pin, dry_run: true },
    { guarded: 'true', conflict: 'true' }
  )
  const result = runMode(t, state)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.outputs.push, 'false')
  assert.deepEqual(enabledRoutes(state), [])
})

for (const inputs of [
  { mirror_tag_only: true },
  { mirror_tag_only: true, allow_tag: pin, mirror_branches: true },
  { mirror_tag_only: true, allow_tag: pin, allow_guarded_merge_sha: 'a'.repeat(40) },
  { mirror_tag_only: true, allow_tag: pin, allow_guarded_merge_sha: 'not-a-sha' }
]) {
  test(`contradictory or missing tag-only input cannot authorize a push: ${JSON.stringify(inputs)}`, (t) => {
    const state = context(inputs, { guarded: 'true', conflict: 'true' })
    const result = runMode(t, state)
    assert.notEqual(result.status, 0)
    assert.notEqual(result.outputs.push, 'true')
    assert.doesNotMatch(result.rawOutput, /^push=true$/m)
    assert.deepEqual(enabledRoutes(state), [])
  })
}

for (const value of ['', 'TRUE', '1', 'true; echo unsafe']) {
  test(`a tampered tag-only environment flag ${JSON.stringify(value)} is refused before push authorization`, (t) => {
    const state = context({ mirror_tag_only: true, allow_tag: pin })
    const result = runMode(t, state, { MIRROR_TAG_ONLY: value })
    assert.notEqual(result.status, 0)
    assert.notEqual(result.outputs.push, 'true')
    assert.doesNotMatch(result.rawOutput, /^push=true$/m)
    assert.deepEqual(enabledRoutes(state), [])
  })
}

test('a nondefault workflow branch cannot enter the privileged tag-only job', (t) => {
  const state = context({ mirror_tag_only: true, allow_tag: pin }, { branch: 'feature/untrusted' })
  const result = runMode(t, state)
  assert.equal(result.skipped, true)
  assert.deepEqual(enabledRoutes(state), [])
})

test('normal manual sync keeps its existing mirror, dispatch, merge and tag-issue routes', (t) => {
  const state = context()
  const result = runMode(t, state)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.outputs.tag_only, 'false')
  assert.deepEqual(enabledRoutes(state), [
    writers[0],
    writers[1],
    writers[2],
    writers[4],
    writers[9]
  ])
})

test('normal explicit branch and approved-tag inputs retain their existing routes', (t) => {
  const state = context({ mirror_branches: true, allow_tag: pin })
  const result = runMode(t, state)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.outputs.tag_only, 'false')
  assert.deepEqual(enabledRoutes(state), [
    writers[0],
    writers[1],
    writers[2],
    writers[3],
    writers[4],
    writers[7],
    writers[8],
    writers[9]
  ])
})

test('normal sync still reports guard and merge issues while preserving the independent approved-tag route', (t) => {
  const state = context({ allow_tag: pin }, { refused: 'true', guarded: 'true', conflict: 'true' })
  const result = runMode(t, state)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(enabledRoutes(state), [
    writers[5],
    writers[6],
    writers[7],
    writers[8],
    writers[9]
  ])
})

test('missing validated mode output cannot enable any unrelated write route', (t) => {
  const state = context(
    { allow_tag: pin, mirror_branches: true },
    { guarded: 'true', conflict: 'true' }
  )
  runMode(t, state)
  state.steps.mode.outputs = { push: 'true', tag_only: '' }
  assert.deepEqual(
    enabledRoutes(state).filter((name) => name !== allowedName),
    []
  )
})

test('a schedule cannot acquire the manual tag-only override from injected input values', (t) => {
  const state = context({ mirror_tag_only: true, allow_tag: pin }, { event: 'schedule' })
  const result = runMode(t, state)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.outputs.tag_only, 'false')
  assert.equal(state.env.ALLOW_TAG, '')
  assert.deepEqual(enabledRoutes(state), [
    writers[0],
    writers[1],
    writers[2],
    writers[4],
    writers[9]
  ])
})

test('normal report-only sync preserves local merge analysis without enabling token-bearing writes', (t) => {
  const state = context({ dry_run: true })
  const result = runMode(t, state)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(enabledRoutes(state), [writers[4]])
  assert.equal(environment(step(writers[4]).body, 10, state).GH_TOKEN, '')
})

for (const options of [{ cancelled: true }, { fetch: 'failure' }]) {
  test(`tag-only mode cannot mirror after cancellation or fetch failure: ${JSON.stringify(options)}`, (t) => {
    const state = context({ mirror_tag_only: true, allow_tag: pin }, options)
    runMode(t, state)
    assert.deepEqual(enabledRoutes(state), [])
  })
}

function runAllowedTag(state, fx) {
  const globals = header.slice(header.indexOf('\nenv:\n') + '\nenv:\n'.length)
  state.env = environment(globals, 2, state)
  const helper = resolve(import.meta.dirname, 'mirror-allowed-tag.sh').replaceAll('\\', '/')
  const body = script(step(allowedName).body, state).replaceAll(
    '/tmp/mirror-allowed-tag.sh',
    helper
  )
  const result = spawnSync('bash', ['-c', body], {
    cwd: fx.work,
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...isolatedEnvironment(fx.env),
      ...state.env,
      GH_TOKEN: 'synthetic-token-no-service-access',
      GIT_CONFIG_GLOBAL: join(fx.root, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ALLOW_PROTOCOL: 'file',
      FORK_STATE_DIR: fx.state,
      GITHUB_OUTPUT: fx.out,
      DISPATCHED_TAG: '',
      DISPATCHED_SHA: ''
    }
  })
  assert.equal(result.error, undefined, result.error?.message)
  return result
}

const remoteRefs = (fx) => git(fx, fx.origin, 'for-each-ref', '--format=%(refname) %(objectname)')

test('the unchanged approved-tag step writes exactly one tag in a real local Git fixture', () => {
  const fx = createFixture()
  git(fx, fx.work, 'update-ref', `refs/upstream-tags/${tag}`, fx.tagSha)
  const before = remoteRefs(fx)
  const state = context({ mirror_tag_only: true, allow_tag: `${tag}@${fx.tagSha}` })
  const result = runAllowedTag(state, fx)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.deepEqual(
    remoteRefs(fx).split('\n').toSorted(),
    [...before.split('\n'), `refs/tags/${tag} ${fx.tagSha}`].toSorted()
  )
  assert.equal(readFileSync(fx.out, 'utf8'), `tag=${tag}\nsha=${fx.tagSha}\n`)
})

for (const scenario of ['missing', 'malformed', 'moved-upstream', 'wrong-origin']) {
  test(`the existing pin helper refuses ${scenario} approval without changing any remote ref`, () => {
    const fx = createFixture()
    git(fx, fx.work, 'update-ref', `refs/upstream-tags/${tag}`, fx.tagSha)
    if (scenario === 'moved-upstream') {
      git(fx, fx.work, 'update-ref', `refs/upstream-tags/${tag}`, fx.frozen)
    }
    if (scenario === 'wrong-origin') {
      git(fx, fx.work, 'push', fx.origin, `${fx.tip}:refs/tags/${tag}`)
    }
    const allowTag =
      scenario === 'missing'
        ? ''
        : scenario === 'malformed'
          ? `${tag}@short`
          : `${tag}@${fx.tagSha}`
    const before = remoteRefs(fx)
    const result = runAllowedTag(context({ mirror_tag_only: true, allow_tag: allowTag }), fx)
    assert.equal(
      result.status,
      scenario === 'wrong-origin' ? 5 : scenario === 'moved-upstream' ? 4 : 2
    )
    assert.equal(remoteRefs(fx), before)
    assert.equal(existsSync(fx.out) ? readFileSync(fx.out, 'utf8') : '', '')
  })
}
