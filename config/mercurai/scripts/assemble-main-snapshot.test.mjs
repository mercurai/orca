import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  TAG,
  SHA_VAR,
  SERIES,
  git,
  commit,
  createFixture,
  addPatch,
  seriesOn,
  addUpstreamReleaseBranchCommit,
  writeManifest,
  assemble,
  snapshot,
  assertMainRefused,
  subjects
} from './assemble-main-fixture.mjs'

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
  writeManifest(fx, {
    base: fx.frozen,
    patches: [...patches, { branch: 'patch/parked', status: 'planned' }]
  })
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
  assert.equal(
    git(fx, fx.work, 'ls-tree', '--name-only', 'HEAD', 'later.txt'),
    '',
    'main past the freeze is excluded'
  )
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
  assert.equal(
    run.outputs.series,
    patches.map((patch) => `${patch.branch}:${patch.commit}`).join(',')
  )

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

test('the workflow takes the frozen sha as an input and every job checks out the dispatched commit', () => {
  const file = resolve(
    import.meta.dirname,
    '..',
    '..',
    '..',
    '.github',
    'workflows',
    'fork-assemble-release.yml'
  )
  const workflow = readFileSync(file, 'utf8').replaceAll('\r\n', '\n')
  assert.match(workflow, /^ {6}upstream_main_sha:\n/m)
  assert.match(workflow, /^ {2}UPSTREAM_MAIN_SHA: \$\{\{ inputs\.upstream_main_sha \}\}$/m)
  assert.deepEqual(
    workflow.match(/^ {10}ref: .*$/gm),
    Array(5).fill('          ref: ${{ github.sha }}')
  )
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
    writeManifest(fx, {
      base: fx.frozen,
      patches: [beta, { ...alpha, commit: malformed(alpha.commit) }]
    })
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
  [
    'advanced',
    (fx, name, pinned) => addPatch(fx, name, pinned, { file: 'extra.txt', content: 'extra' })
  ],
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
