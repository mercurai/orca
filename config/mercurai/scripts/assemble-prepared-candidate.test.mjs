import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  TAG,
  git,
  commit,
  createFixture,
  addPatch,
  seriesOn,
  preparedFixture,
  writeManifest,
  assemble,
  snapshot,
  assertRefused
} from './assemble-main-fixture.mjs'

test('promotion keeps the reviewed candidate SHA and reserved release tag across Git commit dates', () => {
  const fx = createFixture()
  const patches = seriesOn(fx, fx.frozen)
  writeManifest(fx, { base: fx.frozen, patches })
  const preparation = assemble(fx, {
    mainSha: fx.frozen,
    committerDate: '2001-01-01T00:00:00Z'
  })
  assert.equal(preparation.status, 0, preparation.log)
  const preparedCandidateSha = git(fx, fx.work, 'rev-parse', 'HEAD')
  git(
    fx,
    fx.work,
    'push',
    '-q',
    'origin',
    `${preparedCandidateSha}:refs/heads/patch/reviewed-candidate`
  )
  const preparedReleaseTag = `${TAG}-mercurai.7`
  const before = snapshot(fx)

  const promotion = assemble(fx, {
    mainSha: fx.frozen,
    preparedCandidateSha,
    preparedReleaseTag,
    committerDate: '2001-01-02T00:00:00Z'
  })

  assert.equal(promotion.status, 0, promotion.log)
  assert.deepEqual(
    {
      candidateSha: git(fx, fx.work, 'rev-parse', 'HEAD'),
      releaseTag: promotion.outputs.release_tag
    },
    { candidateSha: preparedCandidateSha, releaseTag: preparedReleaseTag },
    'promotion must reuse the reviewed commit and reserved version, not recreate either identity'
  )
  assert.equal(promotion.outputs.tree, preparation.outputs.tree)
  assert.equal(
    promotion.outputs.series,
    patches.map((patch) => `${patch.branch}:${patch.commit}`).join(',')
  )
  assert.equal(git(fx, fx.origin, 'for-each-ref'), before.origin, 'assembly publishes nothing')
})

for (const missing of ['preparedCandidateSha', 'preparedReleaseTag']) {
  test(`prepared promotion refuses a missing ${missing}`, () => {
    const { fx, preparedCandidateSha, preparedReleaseTag } = preparedFixture()
    const inputs = { mainSha: fx.frozen, preparedCandidateSha, preparedReleaseTag }
    delete inputs[missing]
    const before = snapshot(fx)
    assertRefused(fx, before, assemble(fx, inputs), [
      'PREPARED_CANDIDATE_SHA',
      'PREPARED_RELEASE_TAG'
    ])
  })
}

for (const malformed of ['a'.repeat(39), 'A'.repeat(40), 'patch/reviewed-candidate']) {
  test(`prepared promotion refuses malformed candidate SHA ${malformed}`, () => {
    const { fx, preparedReleaseTag } = preparedFixture()
    const before = snapshot(fx)
    assertRefused(
      fx,
      before,
      assemble(fx, { mainSha: fx.frozen, preparedCandidateSha: malformed, preparedReleaseTag }),
      ['PREPARED_CANDIDATE_SHA']
    )
  })
}

for (const malformed of [
  'v9.9.9-mercurai.7',
  `${TAG}-mercurai.0`,
  `${TAG}-mercurai.07`,
  `${TAG}-mercurai.7;echo`
]) {
  test(`prepared promotion refuses malformed reserved tag ${malformed}`, () => {
    const { fx, preparedCandidateSha } = preparedFixture()
    const before = snapshot(fx)
    assertRefused(
      fx,
      before,
      assemble(fx, { mainSha: fx.frozen, preparedCandidateSha, preparedReleaseTag: malformed }),
      ['PREPARED_RELEASE_TAG']
    )
  })
}

test('prepared promotion refuses an already used reserved tag without allocating another', () => {
  const { fx, preparedCandidateSha, preparedReleaseTag } = preparedFixture()
  git(fx, fx.seed, 'tag', preparedReleaseTag, fx.tagSha)
  git(fx, fx.seed, 'push', '-q', fx.origin, `refs/tags/${preparedReleaseTag}`)
  const before = snapshot(fx)
  assertRefused(
    fx,
    before,
    assemble(fx, { mainSha: fx.frozen, preparedCandidateSha, preparedReleaseTag }),
    ['PREPARED_RELEASE_TAG', 'already used']
  )
})

test('prepared promotion refuses a cached commit outside fetched patch refs', () => {
  const { fx, preparedCandidateSha, preparedReleaseTag } = preparedFixture()
  git(fx, fx.seed, 'checkout', '-q', '-B', 'unpublished-candidate', preparedCandidateSha)
  const untrusted = commit(fx, 'unpublished.txt', 'untrusted', 'unpublished candidate')
  git(fx, fx.work, 'fetch', '-q', fx.seed, untrusted)
  const before = snapshot(fx)
  assertRefused(
    fx,
    before,
    assemble(fx, { mainSha: fx.frozen, preparedCandidateSha: untrusted, preparedReleaseTag }),
    ['PREPARED_CANDIDATE_SHA', 'fetched fork patch branch']
  )
})

test('prepared promotion prunes a deleted candidate branch before trusting its cached ref', () => {
  const { fx, preparedCandidateSha, preparedReleaseTag } = preparedFixture()
  git(fx, fx.work, 'fetch', '-q', 'origin', '+refs/heads/patch/*:refs/remotes/origin/patch/*')
  git(fx, fx.seed, 'push', '-q', fx.origin, '--delete', 'patch/reviewed-candidate')
  const before = snapshot(fx)
  assertRefused(
    fx,
    before,
    assemble(fx, { mainSha: fx.frozen, preparedCandidateSha, preparedReleaseTag }),
    ['PREPARED_CANDIDATE_SHA', 'fetched fork patch branch']
  )
})

test('prepared promotion refuses a trusted candidate that does not contain the pinned base', () => {
  const { fx, preparedReleaseTag } = preparedFixture()
  const wrongBase = addPatch(fx, 'wrong-base', fx.tagSha)
  const before = snapshot(fx)
  assertRefused(
    fx,
    before,
    assemble(fx, { mainSha: fx.frozen, preparedCandidateSha: wrongBase, preparedReleaseTag }),
    ['PREPARED_CANDIDATE_SHA', 'pinned base']
  )
})

test('prepared promotion refuses a different tree and restores the original checkout', () => {
  const { fx, preparedReleaseTag } = preparedFixture()
  const wrongTree = addPatch(fx, 'wrong-tree', fx.frozen)
  const before = snapshot(fx)
  assertRefused(
    fx,
    before,
    assemble(fx, { mainSha: fx.frozen, preparedCandidateSha: wrongTree, preparedReleaseTag }),
    ['PREPARED_CANDIDATE_SHA', 'ordered patch series']
  )
})

for (const checkout of ['original branch', 'detached HEAD', 'target release branch']) {
  test(`prepared output failure preserves ${checkout} and all branch tips`, () => {
    const { fx, preparedCandidateSha, preparedReleaseTag } = preparedFixture()
    git(fx, fx.work, 'branch', 'release/mercurai', fx.tagSha)
    if (checkout === 'detached HEAD') {
      git(fx, fx.work, 'checkout', '-q', '--detach', fx.frozen)
    } else if (checkout === 'target release branch') {
      git(fx, fx.work, 'checkout', '-q', 'release/mercurai')
    }
    const before = snapshot(fx)
    const originalCheckout = git(fx, fx.work, 'rev-parse', '--abbrev-ref', 'HEAD')
    const branchTips = git(fx, fx.work, 'for-each-ref', 'refs/heads/')
    const result = assemble(fx, {
      mainSha: fx.frozen,
      preparedCandidateSha,
      preparedReleaseTag,
      outputSink: fx.state
    })

    assert.notEqual(result.status, 0, result.log)
    assert.match(result.log, /[Ii]s a directory/, 'the output sink fails after composition')
    assert.match(result.log, /patch alpha/, 'the final patch was composed before output failure')
    assert.equal(result.raw, '', 'no release output reaches the ordinary output file')
    assert.equal(
      git(fx, fx.work, 'rev-parse', 'HEAD'),
      before.head,
      'HEAD returns to its exact commit'
    )
    assert.equal(git(fx, fx.work, 'rev-parse', '--abbrev-ref', 'HEAD'), originalCheckout)
    assert.equal(
      git(fx, fx.work, 'for-each-ref', 'refs/heads/'),
      branchTips,
      'all original branch tips remain intact'
    )
    assert.equal(git(fx, fx.origin, 'for-each-ref'), before.origin, 'the fork is unchanged')
    assert.equal(git(fx, fx.up, 'for-each-ref'), before.up, 'upstream is unchanged')
  })
}
