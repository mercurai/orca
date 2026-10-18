// assemble-release.sh builds a release from a stable upstream tag. Main mode adds an optional
// UPSTREAM_MAIN_SHA: a frozen commit of official stablyai/orca main, plus every active patch pinned
// by `commit:` in the manifest. The tag still names the version floor and the release name.
//
// These run the real assemble-release.sh against disposable git repositories: `up.git` stands for
// official stablyai/orca (its URL is rewritten to the local bare repo through the process's own
// GIT_CONFIG_COUNT, the way test-fork-series-scripts.sh routes UPSTREAM_REPO), `origin.git` is the
// fork, `work` is the fork checkout on `mercurai`. Nothing touches the network.
//
// CI requirements (fork-scripts-test, "Node scripts" step, no workflow change): bash, git with
// GIT_CONFIG_GLOBAL (2.32+), mikefarah yq on PATH (the assemble jobs use it too), Node 24.
// Run with `node --test "config/mercurai/scripts/*.test.mjs"` from the repo root.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'

const script = resolve(import.meta.dirname, 'assemble-release.sh')
const TAG = 'v1.4.224'
const OFFICIAL_URL = 'https://github.com/stablyai/orca'
const SHA_VAR = 'UPSTREAM_MAIN_SHA'
// Inherited settings that change what the script or its git calls do: assembler inputs and shell startup files.
const INHERITED_ENV = new Set(['TAG', SHA_VAR, 'BASH_ENV', 'ENV'])
const IDENTITY = {
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid'
}
const roots = []

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true })
  }
})

const posix = (path) => path.replaceAll('\\', '/')

/** The host environment minus git, tag, snapshot and shell-startup settings, so only the fixture's reach the script. */
function cleanEnv(root) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    const name = key.toUpperCase()
    if (!name.startsWith('GIT_') && !INHERITED_ENV.has(name)) {
      env[key] = value
    }
  }
  return { ...env, GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
}

function git(fx, cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    env: { ...fx.env, ...IDENTITY },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

/** One commit on the seed repo's current branch; returns its sha. */
function commit(fx, file, content, subject) {
  writeFileSync(join(fx.seed, file), content)
  git(fx, fx.seed, 'add', file)
  git(fx, fx.seed, 'commit', '-q', '-m', subject)
  return git(fx, fx.seed, 'rev-parse', 'HEAD')
}

/**
 * upstream main: tag (v1.4.224) -> frozen -> tip, in up.git and mirrored into origin.git. The fork
 * branch `mercurai` is main plus a fork-only commit. `work` is a fork checkout of `mercurai`.
 */
function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-main-snapshot-'))
  roots.push(root)
  writeFileSync(join(root, 'gitconfig'), '')
  const fx = {
    root,
    env: cleanEnv(root),
    up: join(root, 'up.git'),
    origin: join(root, 'origin.git'),
    seed: join(root, 'seed'),
    work: join(root, 'work'),
    state: join(root, 'state'),
    out: join(root, 'github-output')
  }
  mkdirSync(fx.state)
  git(fx, root, 'init', '-q', '--bare', '-b', 'main', fx.up)
  git(fx, fx.up, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
  git(fx, root, 'init', '-q', '--bare', '-b', 'main', fx.origin)
  git(fx, root, 'init', '-q', '-b', 'main', fx.seed)
  fx.tagSha = commit(fx, 'base.txt', 'one', 'upstream 1.4.224')
  git(fx, fx.seed, 'tag', TAG)
  fx.frozen = commit(fx, 'feature.txt', 'feature', 'upstream main: feature')
  fx.tip = commit(fx, 'later.txt', 'later', 'upstream main: later')
  for (const remote of [fx.up, fx.origin]) {
    git(fx, fx.seed, 'push', '-q', remote, 'main', `refs/tags/${TAG}`)
  }
  git(fx, fx.seed, 'checkout', '-q', '-b', 'mercurai')
  fx.forkOnly = commit(fx, 'fork-note.txt', 'fork', 'fork-only commit')
  git(fx, fx.seed, 'push', '-q', fx.origin, 'mercurai')
  git(fx, fx.seed, 'checkout', '-q', 'main')
  git(fx, root, 'clone', '-q', fx.origin, fx.work)
  git(fx, fx.work, 'checkout', '-q', 'mercurai')
  return fx
}

/** patch/<name> is `on` plus one commit, pushed to the fork (force: it may replace an earlier one). */
function addPatch(fx, name, on, { file = `${name}.txt`, content = name } = {}) {
  git(fx, fx.seed, 'checkout', '-q', '-B', `patch/${name}`, on)
  const sha = commit(fx, file, content, `patch ${name}`)
  git(fx, fx.seed, 'push', '-q', '-f', fx.origin, `patch/${name}`)
  git(fx, fx.seed, 'checkout', '-q', 'main')
  return sha
}

const SERIES = [
  { name: 'beta', status: 'ours-only' },
  { name: 'alpha', status: 'upstream-open' }
]

/** The two-patch series [beta (ours-only), alpha (upstream-open)], both on `on`, each pinned to its branch head. */
function seriesOn(fx, on, base = on) {
  return SERIES.map(({ name, status }) => ({
    branch: `patch/${name}`,
    status,
    base,
    commit: addPatch(fx, name, on)
  }))
}

/** A commit on an upstream release branch: in upstream, but not in main. */
function addUpstreamReleaseBranchCommit(fx) {
  git(fx, fx.seed, 'checkout', '-q', '-B', 'release-1.4', fx.tagSha)
  const sha = commit(fx, 'release-only.txt', 'release', 'upstream release branch')
  git(fx, fx.seed, 'push', '-q', fx.up, 'release-1.4:refs/heads/release/1.4')
  git(fx, fx.seed, 'checkout', '-q', 'main')
  return sha
}

function writeManifest(fx, { base, patches, release = 'release/mercurai' }) {
  const lines = [`base: "${base}"`, `release_branch: ${release}`, 'patches:']
  for (const patch of patches) {
    lines.push(`  - branch: ${patch.branch}`, `    status: ${patch.status ?? 'ours-only'}`)
    if (patch.base !== undefined) {
      lines.push(`    base: "${patch.base}"`)
    }
    if (patch.commit !== undefined) {
      lines.push(`    commit: "${patch.commit}"`)
    }
  }
  writeFileSync(join(fx.root, 'manifest.yaml'), `${lines.join('\n')}\n`)
}

/** Runs assemble-release.sh in the fork checkout; `mainSha` undefined leaves UPSTREAM_MAIN_SHA unset. */
function assemble(fx, { tag = TAG, mainSha } = {}) {
  writeFileSync(fx.out, '')
  const insteadOf = `url.${posix(fx.up)}.insteadOf`
  const env = {
    ...fx.env,
    TAG: tag,
    MANIFEST: posix(join(fx.root, 'manifest.yaml')),
    MANIFEST_WORK: posix(join(fx.root, 'manifest-work.yaml')),
    GITHUB_OUTPUT: posix(fx.out),
    FORK_STATE_DIR: posix(fx.state),
    UPSTREAM_REPO: 'stablyai/orca',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: insteadOf,
    GIT_CONFIG_VALUE_0: `${OFFICIAL_URL}.git`,
    GIT_CONFIG_KEY_1: insteadOf,
    GIT_CONFIG_VALUE_1: OFFICIAL_URL,
    GIT_CONFIG_KEY_2: insteadOf,
    GIT_CONFIG_VALUE_2: 'git@github.com:stablyai/orca.git'
  }
  if (mainSha !== undefined) {
    env[SHA_VAR] = mainSha
  }
  const result = spawnSync('bash', [posix(script)], { cwd: fx.work, env, encoding: 'utf8' })
  const raw = readFileSync(fx.out, 'utf8')
  const outputs = Object.fromEntries(
    raw
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
  )
  return { status: result.status, log: `${result.stdout}${result.stderr}`, raw, outputs }
}

function snapshot(fx) {
  return {
    head: git(fx, fx.work, 'rev-parse', 'HEAD'),
    origin: git(fx, fx.origin, 'for-each-ref'),
    up: git(fx, fx.up, 'for-each-ref')
  }
}

/** The workflow-command diagnostics only; git's own fetch and checkout output never counts as a refusal reason. */
function errorLines(log) {
  return log.split(/\r?\n/).filter((line) => line.startsWith('::error::'))
}

/** Asserts a refused run: an ::error:: line names each of `mentions`; nothing written, built or published. */
function assertRefused(fx, before, run, mentions) {
  assert.notEqual(run.status, 0, `assembly must be refused:\n${run.log}`)
  const errors = errorLines(run.log)
  assert.ok(errors.length > 0, `assembly must report an ::error:: diagnostic:\n${run.log}`)
  for (const text of mentions) {
    assert.ok(
      errors.some((line) => line.includes(text)),
      `an ::error:: line must name ${text}:\n${run.log}`
    )
  }
  assert.equal(run.raw, '', 'a refused run writes no outputs')
  assert.equal(git(fx, fx.work, 'symbolic-ref', '--short', 'HEAD'), 'mercurai', 'nothing was checked out')
  assert.equal(git(fx, fx.work, 'rev-parse', 'HEAD'), before.head)
  assert.equal(git(fx, fx.work, 'for-each-ref', 'refs/heads/release'), '', 'no release branch was built')
  assert.equal(git(fx, fx.origin, 'for-each-ref'), before.origin, 'the fork was not changed')
  assert.equal(git(fx, fx.up, 'for-each-ref'), before.up, 'upstream was not changed')
}

/** Assembles in main mode and asserts it is refused. */
function assertMainRefused(fx, mainSha, mentions) {
  const before = snapshot(fx)
  assertRefused(fx, before, assemble(fx, { mainSha }), mentions)
}

function subjects(fx, range) {
  return git(fx, fx.work, 'log', '--reverse', '--format=%s', range)
}

test('the fixture tools are on PATH', () => {
  for (const tool of ['git', 'yq']) {
    const probe = spawnSync(tool, ['--version'], { encoding: 'utf8' })
    assert.equal(probe.status, 0, `${tool} must run: ${probe.error?.message ?? probe.stderr}`)
  }
})

test('tag mode is unchanged: no UPSTREAM_MAIN_SHA, or an empty one, builds the tag plus the series', () => {
  const fx = createFixture()
  addPatch(fx, 'gamma', fx.tagSha)
  writeManifest(fx, { base: TAG, patches: [{ branch: 'patch/gamma', base: TAG }] })
  for (const mainSha of [undefined, '']) {
    const run = assemble(fx, { mainSha })
    assert.equal(run.status, 0, run.log)
    assert.equal(run.outputs.release_branch, 'release/mercurai')
    assert.equal(run.outputs.release_tag, `${TAG}-mercurai.1`)
    assert.equal(run.outputs.tree, git(fx, fx.work, 'rev-parse', 'HEAD^{tree}'))
    assert.equal(subjects(fx, `${TAG}..HEAD`), 'patch gamma')
    assert.equal(git(fx, fx.work, 'diff', '--name-only', TAG, 'HEAD'), 'gamma.txt')
  }
})

test('main mode builds the frozen main commit plus the pinned series in manifest order', () => {
  const fx = createFixture()
  git(fx, fx.seed, 'tag', `${TAG}-mercurai.3`, fx.tagSha)
  git(fx, fx.seed, 'push', '-q', fx.origin, `refs/tags/${TAG}-mercurai.3`)
  const patches = seriesOn(fx, fx.frozen)
  writeManifest(fx, { base: fx.frozen, patches: [...patches, { branch: 'patch/parked', status: 'planned' }] })
  const before = snapshot(fx)

  const run = assemble(fx, { mainSha: fx.frozen })

  assert.equal(run.status, 0, run.log)
  assert.equal(run.outputs.release_branch, 'release/mercurai')
  assert.equal(run.outputs.release_tag, `${TAG}-mercurai.4`)
  assert.equal(git(fx, fx.work, 'symbolic-ref', '--short', 'HEAD'), 'release/mercurai')
  assert.equal(run.outputs.tree, git(fx, fx.work, 'rev-parse', 'HEAD^{tree}'))
  assert.equal(subjects(fx, `${fx.frozen}..HEAD`), 'patch beta\npatch alpha')
  assert.equal(git(fx, fx.work, 'diff', '--name-only', fx.frozen, 'HEAD'), 'alpha.txt\nbeta.txt')
  assert.equal(git(fx, fx.work, 'show', 'HEAD:feature.txt'), 'feature')
  assert.equal(git(fx, fx.work, 'ls-tree', '--name-only', 'HEAD', 'later.txt'), '', 'main past the freeze is excluded')
  assert.equal(git(fx, fx.origin, 'for-each-ref'), before.origin, 'assembly publishes nothing')
})

test('main mode reports the base commit and every patch commit it assembled', () => {
  const fx = createFixture()
  const patches = seriesOn(fx, fx.frozen)
  writeManifest(fx, { base: fx.frozen, patches })

  const run = assemble(fx, { mainSha: fx.frozen })

  assert.equal(run.status, 0, run.log)
  const report = `${run.log}\n${run.raw}`
  for (const sha of [fx.frozen, ...patches.map((patch) => patch.commit)]) {
    assert.ok(report.includes(sha), `the log or outputs must report ${sha}:\n${report}`)
  }
})

test('a second assembly of the same tuple is identical after upstream and the fork mirror moved on', () => {
  const fx = createFixture()
  writeManifest(fx, { base: fx.frozen, patches: seriesOn(fx, fx.frozen) })
  const first = assemble(fx, { mainSha: fx.frozen })
  assert.equal(first.status, 0, first.log)

  commit(fx, 'newer.txt', 'newer', 'upstream main: newer')
  for (const remote of [fx.up, fx.origin]) {
    git(fx, fx.seed, 'push', '-q', remote, 'main')
  }
  const second = assemble(fx, { mainSha: fx.frozen })

  assert.equal(second.status, 0, second.log)
  assert.equal(second.outputs.tree, first.outputs.tree)
  assert.equal(second.outputs.release_tag, first.outputs.release_tag)
})

test('main mode outputs the frozen base and the ordered pins; tag mode outputs neither', () => {
  const fx = createFixture()
  const patches = seriesOn(fx, fx.frozen)
  writeManifest(fx, { base: fx.frozen, patches })

  const run = assemble(fx, { mainSha: fx.frozen })

  assert.equal(run.status, 0, run.log)
  assert.equal(run.outputs.upstream_main_sha, fx.frozen)
  assert.equal(run.outputs.series, patches.map((patch) => `${patch.branch}:${patch.commit}`).join(','))

  const tagFx = createFixture()
  addPatch(tagFx, 'gamma', tagFx.tagSha)
  writeManifest(tagFx, { base: TAG, patches: [{ branch: 'patch/gamma', base: TAG }] })
  const tagRun = assemble(tagFx)
  assert.equal(tagRun.status, 0, tagRun.log)
  assert.equal(tagRun.outputs.upstream_main_sha, undefined)
  assert.equal(tagRun.outputs.series, undefined)
})

test('main mode skips a patch pinned at the frozen commit with a warning and still reports its pin', () => {
  const fx = createFixture()
  const patches = seriesOn(fx, fx.frozen)
  git(fx, fx.seed, 'push', '-q', '-f', fx.origin, `${fx.frozen}:refs/heads/patch/zero`)
  const zero = { branch: 'patch/zero', status: 'ours-only', base: fx.frozen, commit: fx.frozen }
  writeManifest(fx, { base: fx.frozen, patches: [zero, ...patches] })

  const run = assemble(fx, { mainSha: fx.frozen })

  assert.equal(run.status, 0, run.log)
  assert.ok(run.log.includes('::warning::patch/zero has no commits beyond'), run.log)
  assert.equal(subjects(fx, `${fx.frozen}..HEAD`), 'patch beta\npatch alpha')
  assert.ok(run.outputs.series.startsWith(`patch/zero:${fx.frozen},`), run.outputs.series)
})

test('the workflow takes the frozen sha as an input and both jobs check out the dispatched commit', () => {
  const file = resolve(import.meta.dirname, '..', '..', '..', '.github', 'workflows', 'fork-assemble-release.yml')
  const workflow = readFileSync(file, 'utf8').replaceAll('\r\n', '\n')
  assert.match(workflow, /^ {6}upstream_main_sha:\n/m)
  assert.match(workflow, /^ {2}UPSTREAM_MAIN_SHA: \$\{\{ inputs\.upstream_main_sha \}\}$/m)
  assert.deepEqual(workflow.match(/^ {10}ref: .*$/gm), Array(2).fill('          ref: ${{ github.sha }}'))
  assert.doesNotMatch(workflow, /^\s+ref: \$\{\{ github\.ref_name \}\}/m)
})

const MALFORMED = [
  ['an uppercase sha', (fx) => fx.frozen.toUpperCase()],
  ['an abbreviated sha', (fx) => fx.frozen.slice(0, 12)],
  ['a 39-character sha', (fx) => fx.frozen.slice(0, 39)],
  ['forty non-hex characters', () => 'g'.repeat(40)],
  ['a branch name', () => 'main'],
  ['a full ref name', () => 'refs/heads/main'],
  ['a sha with a command appended', (fx) => `${fx.frozen};x`]
]

for (const [label, malformed] of MALFORMED) {
  test(`UPSTREAM_MAIN_SHA is refused as ${String(label)}`, () => {
    const fx = createFixture()
    const value = malformed(fx)
    writeManifest(fx, { base: value, patches: seriesOn(fx, fx.frozen, value) })
    assertMainRefused(fx, value, [SHA_VAR])
  })
}

const UNREACHABLE = [
  ['a commit upstream does not have', () => ({ sha: 'd'.repeat(40), on: undefined })],
  [
    'a commit only on an upstream release branch',
    (fx) => {
      const sha = addUpstreamReleaseBranchCommit(fx)
      return { sha, on: sha }
    }
  ],
  ['a commit only on the fork', (fx) => ({ sha: fx.forkOnly, on: fx.forkOnly })]
]

for (const [label, prepare] of UNREACHABLE) {
  test(`UPSTREAM_MAIN_SHA is refused as ${String(label)}, not reachable from upstream main`, () => {
    const fx = createFixture()
    const { sha, on } = prepare(fx)
    writeManifest(fx, { base: sha, patches: seriesOn(fx, on ?? fx.frozen, sha) })
    assertMainRefused(fx, sha, [SHA_VAR])
  })
}

for (const [label, wrong] of [
  ['the tag name', () => TAG],
  ['the tag commit', (fx) => fx.tagSha],
  ['a newer main commit', (fx) => fx.tip]
]) {
  test(`a manifest base of ${String(label)} is refused when UPSTREAM_MAIN_SHA names another commit`, () => {
    const fx = createFixture()
    writeManifest(fx, { base: wrong(fx), patches: seriesOn(fx, fx.frozen) })
    assertMainRefused(fx, fx.frozen, [SHA_VAR])
  })
}

test('a patch recorded on the tag name, not the main commit, is refused by name', () => {
  const fx = createFixture()
  writeManifest(fx, { base: fx.frozen, patches: seriesOn(fx, fx.frozen, TAG) })
  assertMainRefused(fx, fx.frozen, ['patch/beta'])
})

test('a patch recorded on a different main commit is refused by name', () => {
  const fx = createFixture()
  writeManifest(fx, { base: fx.frozen, patches: seriesOn(fx, fx.frozen, fx.tip) })
  assertMainRefused(fx, fx.frozen, ['patch/beta'])
})

test('a patch recorded on the main commit but built on an older commit is refused by name', () => {
  const fx = createFixture()
  const [beta] = seriesOn(fx, fx.frozen)
  const stale = {
    branch: 'patch/alpha',
    status: 'upstream-open',
    base: fx.frozen,
    commit: addPatch(fx, 'alpha', fx.tagSha)
  }
  writeManifest(fx, { base: fx.frozen, patches: [beta, stale] })
  assertMainRefused(fx, fx.frozen, ['patch/alpha'])
})

// Both active statuses are assembled, so both are pinned: beta is ours-only, alpha is upstream-open.
const ACTIVE_STATUSES = SERIES.map(({ name, status }, index) => ({ name, status, index }))

for (const { name, status, index } of ACTIVE_STATUSES) {
  test(`an active ${status} patch without a pinned commit is refused by name`, () => {
    const fx = createFixture()
    const patches = seriesOn(fx, fx.frozen)
    patches[index] = { ...patches[index], commit: undefined }
    writeManifest(fx, { base: fx.frozen, patches })
    assertMainRefused(fx, fx.frozen, [`patch/${name}`])
  })
}

for (const [label, malformed] of [
  ['an abbreviated sha', (sha) => sha.slice(0, 12)],
  ['an uppercase sha', (sha) => sha.toUpperCase()],
  ['a branch name', () => 'patch/alpha']
]) {
  test(`an upstream-open patch pin that is ${String(label)} is refused by name`, () => {
    const fx = createFixture()
    const [beta, alpha] = seriesOn(fx, fx.frozen)
    writeManifest(fx, { base: fx.frozen, patches: [beta, { ...alpha, commit: malformed(alpha.commit) }] })
    assertMainRefused(fx, fx.frozen, ['patch/alpha'])
  })
}

test('a deleted patch branch cannot be satisfied by a cached remote-tracking ref', () => {
  const fx = createFixture()
  const patches = seriesOn(fx, fx.frozen)
  writeManifest(fx, { base: fx.frozen, patches })
  git(fx, fx.work, 'fetch', 'origin', '+refs/heads/patch/*:refs/remotes/origin/patch/*')
  git(fx, fx.seed, 'push', '-q', fx.origin, '--delete', 'patch/alpha')
  assert.equal(git(fx, fx.work, 'rev-parse', 'refs/remotes/origin/patch/alpha'), patches[1].commit)
  assertMainRefused(fx, fx.frozen, ['patch/alpha'])
})

test('an annotated-tag object pointing to an official-main commit is not a commit SHA', () => {
  const fx = createFixture()
  git(fx, fx.seed, 'tag', '-a', 'snapshot-object', fx.frozen, '-m', 'snapshot fixture')
  const tagObject = git(fx, fx.seed, 'rev-parse', 'refs/tags/snapshot-object')
  git(fx, fx.seed, 'push', '-q', fx.origin, 'refs/tags/snapshot-object')
  const patches = seriesOn(fx, fx.frozen).map((patch) => ({ ...patch, base: tagObject }))
  writeManifest(fx, { base: tagObject, patches })
  assertMainRefused(fx, tagObject, [SHA_VAR])
})

test('an active patch whose branch the fork does not have is refused by name', () => {
  const fx = createFixture()
  const patches = seriesOn(fx, fx.frozen)
  const ghost = { branch: 'patch/ghost', base: fx.frozen, commit: 'c'.repeat(40) }
  writeManifest(fx, { base: fx.frozen, patches: [...patches, ghost] })
  assertMainRefused(fx, fx.frozen, ['patch/ghost'])
})

for (const [label, move] of [
  ['advanced', (fx, name, pinned) => addPatch(fx, name, pinned, { file: 'extra.txt', content: 'extra' })],
  ['rewritten', (fx, name) => addPatch(fx, name, fx.frozen, { content: 'rewritten' })]
]) {
  for (const { name, status, index } of ACTIVE_STATUSES) {
    test(`an ${status} patch branch ${String(label)} after its commit was pinned is refused before any checkout`, () => {
      const fx = createFixture()
      const patches = seriesOn(fx, fx.frozen)
      writeManifest(fx, { base: fx.frozen, patches })
      const moved = move(fx, name, patches[index].commit)
      assert.notEqual(moved, patches[index].commit, 'the fixture moved the branch')
      assertMainRefused(fx, fx.frozen, [`patch/${name}`])
    })
  }
}
