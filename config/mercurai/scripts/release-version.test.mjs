import assert from 'node:assert/strict'
import { test } from 'node:test'

import { allocateMercuraiVersion, resolveCandidateVersion } from './release-version.mjs'

test('allocates the next fork suffix from the tags that exist', () => {
  assert.equal(allocateMercuraiVersion({ baseVersion: 'v1.4.242' }), 'v1.4.242-mercurai.1')
  assert.equal(
    allocateMercuraiVersion({
      baseVersion: 'v1.4.242',
      existingTags: ['v1.4.241', 'v1.4.242-mercurai.1', 'v1.4.242-mercurai.2']
    }),
    'v1.4.242-mercurai.3'
  )
})

test('does not reuse a suffix from a different upstream version', () => {
  assert.equal(
    allocateMercuraiVersion({
      baseVersion: 'v1.4.243',
      existingTags: ['v1.4.242-mercurai.7']
    }),
    'v1.4.243-mercurai.1'
  )
})

test('reuses the version a crashed candidate already owns', () => {
  const existingTags = ['v1.4.242-mercurai.3']

  assert.deepEqual(
    resolveCandidateVersion({ baseVersion: 'v1.4.242', existingTags, candidateTag: 'v1.4.242-mercurai.3' }),
    { version: 'v1.4.242-mercurai.3', reused: true }
  )
  assert.deepEqual(resolveCandidateVersion({ baseVersion: 'v1.4.242', existingTags }), {
    version: 'v1.4.242-mercurai.4',
    reused: false
  })
})

test('refuses a recorded tag that no longer exists instead of allocating another', () => {
  assert.throws(
    () =>
      resolveCandidateVersion({
        baseVersion: 'v1.4.242',
        existingTags: [],
        candidateTag: 'v1.4.242-mercurai.3'
      }),
    /does not exist/
  )
  assert.throws(() => allocateMercuraiVersion({ baseVersion: 'main' }), /stable version/)
})
