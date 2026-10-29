import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { test } from 'node:test'
import { filenames, fixture, tag } from './publication-github-fixture.mjs'

function refused(result) {
  assert.notEqual(
    result.status,
    0,
    `publisher must refuse; stdout=${result.stdout}; stderr=${result.stderr}`
  )
  assert.deepEqual(result.state.writes, [], 'refusal must make no GitHub writes')
}

test('first publication uploads exactly the three update assets and exposes the requested tag', (t) => {
  const fx = fixture(t)
  fx.state.releases = []
  fx.state.latest = null
  const result = fx.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.state.releases.length, 1)
  const [published] = result.state.releases
  assert.equal(published.tag_name, tag)
  assert.equal(published.draft, false)
  assert.equal(result.state.latest, published.id)
  assert.deepEqual(published.assets.map((asset) => asset.name).toSorted(), filenames.toSorted())
  for (const asset of published.assets) {
    assert.deepEqual(Buffer.from(asset.content, 'base64'), fx.files[asset.name])
  }
})

for (const [name, mutate] of [
  [
    'a renamed default controller branch',
    (rows) => {
      rows['repos/mercurai/orca'].default_branch = 'replacement-controller'
    }
  ],
  [
    'a controller changed during packaging',
    (rows) => {
      rows['repos/mercurai/orca/git/ref/heads/mercurai'].object.sha = '0'.repeat(40)
    }
  ],
  [
    'a review rerun started during packaging',
    (rows) => {
      rows['repos/mercurai/orca/actions/runs/77'].run_attempt = 2
    }
  ],
  [
    'an unsuccessful latest owner review',
    (rows) => {
      rows['repos/mercurai/orca/actions/runs/77'].conclusion = 'failure'
    }
  ],
  [
    'a different triggering owner',
    (rows) => {
      rows['repos/mercurai/orca/actions/runs/77'].triggering_actor = {
        login: 'different-owner',
        id: 20
      }
    }
  ],
  [
    'a different review workflow',
    (rows) => {
      rows['repos/mercurai/orca/actions/workflows/fork-accept-release-review.yml'].id = 34
    }
  ],
  [
    'a qualification rerun started during packaging',
    (rows) => {
      rows['repos/mercurai/orca/actions/runs/81'].run_attempt = 2
    }
  ],
  [
    'an unfinished latest qualification',
    (rows) => {
      rows['repos/mercurai/orca/actions/runs/81'].status = 'in_progress'
      rows['repos/mercurai/orca/actions/runs/81'].conclusion = null
    }
  ],
  [
    'another qualification dispatch',
    (rows) => {
      rows['repos/mercurai/orca/actions/runs/81'].display_title = 'qualify another-dispatch'
    }
  ],
  [
    'a qualification from another controller',
    (rows) => {
      rows['repos/mercurai/orca/actions/runs/81'].head_sha = '0'.repeat(40)
    }
  ],
  [
    'a replaced qualification workflow',
    (rows) => {
      rows['repos/mercurai/orca/actions/workflows/fork-qualify-release.yml'].id = 23
    }
  ],
  [
    'an expired owner-review artifact',
    (rows) => {
      rows['repos/mercurai/orca/actions/artifacts/99'].expired = true
    }
  ],
  [
    'an artifact past its expiry date',
    (rows) => {
      rows['repos/mercurai/orca/actions/artifacts/99'].expires_at = '2000-01-01T00:00:00Z'
    }
  ],
  [
    'a replaced owner-review artifact',
    (rows) => {
      rows['repos/mercurai/orca/actions/artifacts/99'].digest = `sha256:${'0'.repeat(64)}`
    }
  ],
  [
    'an artifact from another review run',
    (rows) => {
      rows['repos/mercurai/orca/actions/artifacts/99'].workflow_run.id = 78
    }
  ]
]) {
  test(`refuses ${String(name)} before any channel mutation`, (t) => {
    const fx = fixture(t)
    fx.state.releases = []
    fx.state.latest = null
    mutate(fx.state.authorization)
    refused(fx.run())
  })
}

test('authorization API refusal cannot initialize an empty channel', (t) => {
  const fx = fixture(t)
  fx.state.releases = []
  fx.state.latest = null
  fx.state.emptyHistory = true
  fx.state.authorizationError = true
  refused(fx.run())
})

test('a review rerun during draft upload prevents making that draft public', (t) => {
  const fx = fixture(t)
  fx.state.releases = []
  fx.state.latest = null
  fx.state.changeReviewOnUpload = true
  const result = fx.run()
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.ok(result.state.writes.some((args) => args[0] === 'release' && args[1] === 'upload'))
  assert.equal(result.state.releases[0].draft, true)
  assert.equal(result.state.latest, null)
  assert.equal(
    result.state.writes.some((args) => args[0] === 'release' && args[1] === 'edit'),
    false
  )
})

test('first publication initializes truly empty channel history after admission', (t) => {
  const fx = fixture(t)
  fx.state.releases = []
  fx.state.latest = null
  fx.state.emptyHistory = true
  const result = fx.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.state.emptyHistory, false)
  const bootstrap = result.state.writes.filter((args) => args[0] === 'api')
  assert.equal(bootstrap.length, 1)
  assert.ok(bootstrap[0].includes('repos/mercurai/orca-mercurai/contents/README.md'))
  assert.equal(result.state.releases[0].draft, false)
})

test('inventory failure on an empty channel never initializes repository history', (t) => {
  const fx = fixture(t)
  fx.state.releases = []
  fx.state.emptyHistory = true
  fx.state.inventoryError = true
  refused(fx.run())
})

for (const historyError of [403, 503]) {
  test(`history HTTP ${historyError} never initializes an allegedly empty channel`, (t) => {
    const fx = fixture(t)
    fx.state.releases = []
    fx.state.historyError = historyError
    refused(fx.run())
  })
}

test('an identical published retry succeeds without any GitHub writes', (t) => {
  const fx = fixture(t)
  const result = fx.run()
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.state.writes, [], 'a published retry is read-only')
  assert.deepEqual(result.state.releases, fx.state.releases, 'published release remains unchanged')
})

for (const field of ['commit', 'controllerSha', 'manifestSha', 'policySha']) {
  test(`published retry rejects changed ${field} provenance`, (t) => {
    const fx = fixture(t)
    const changed = structuredClone(fx.publication)
    changed.candidate[field] = '9'.repeat(field === 'policySha' ? 64 : 40)
    fx.release.body = JSON.stringify(changed)
    refused(fx.run())
  })
}

test('published retry rejects changed qualification provenance', (t) => {
  const fx = fixture(t)
  const changed = structuredClone(fx.publication)
  changed.qualification.runId++
  fx.release.body = JSON.stringify(changed)
  refused(fx.run())
})

test('published retry rejects remote asset bytes that differ from the build', (t) => {
  const fx = fixture(t)
  const asset = fx.release.assets[0]
  const changed = Buffer.from('different installer bytes')
  asset.content = changed.toString('base64')
  asset.size = changed.length
  asset.digest = `sha256:${createHash('sha256').update(changed).digest('hex')}`
  refused(fx.run())
})

test('published retry verifies equal bytes when the API omits the asset digest', (t) => {
  const fx = fixture(t)
  fx.release.assets[0].digest = null
  const result = fx.run()
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.state.writes, [])
})

test('published retry rejects same-sized corrupted bytes when the API omits the digest', (t) => {
  const fx = fixture(t)
  const asset = fx.release.assets[0]
  const changed = Buffer.from(fx.files[asset.name])
  changed[0] ^= 1
  asset.content = changed.toString('base64')
  asset.digest = null
  const result = fx.run()
  refused(result)
  assert.match(result.stdout, /downloaded asset bytes differ/)
})

test('a newer published version on a later inventory page refuses downgrade', (t) => {
  const fx = fixture(t)
  fx.state.releases.push({
    ...structuredClone(fx.release),
    id: 2,
    tag_name: 'v1.4.241-mercurai.10'
  })
  fx.state.latest = 2
  refused(fx.run())
})

test('numeric upstream version ordering refuses 1.4.9 after published 1.4.10', (t) => {
  const fx = fixture(t, { requestedTag: 'v1.4.9-mercurai.99' })
  fx.state.releases.push({ ...structuredClone(fx.release), id: 2, tag_name: 'v1.4.10-mercurai.1' })
  fx.state.latest = 2
  refused(fx.run())
})

test('an exact partial draft uploads only its missing assets and preserves existing bytes', (t) => {
  const fx = fixture(t)
  fx.release.draft = true
  fx.release.assets = [fx.release.assets[0]]
  fx.state.latest = null
  const result = fx.run()
  assert.equal(result.status, 0, result.stderr)
  const uploads = result.state.writes.filter(
    (args) => args[0] === 'release' && args[1] === 'upload'
  )
  const uploadedNames = uploads.flatMap((args) =>
    args.filter((arg) => arg.startsWith('dist/')).map((arg) => basename(arg))
  )
  assert.deepEqual(uploadedNames.toSorted(), ['latest.yml', 'orca-windows-setup.exe.blockmap'])
  assert.ok(
    result.state.writes.every(
      (args) => !args.includes('--clobber') && !args.includes('--draft=true')
    )
  )
  assert.equal(result.state.releases[0].assets.find((asset) => asset.name === filenames[0]).id, 10)
  assert.equal(result.state.releases[0].draft, false)
  assert.equal(result.state.latest, 1)
})

test('partial draft with different provenance refuses without uploading', (t) => {
  const fx = fixture(t)
  fx.release.draft = true
  fx.release.assets = []
  fx.release.body = JSON.stringify({ ...fx.publication, receiptSha256: '8'.repeat(64) })
  refused(fx.run())
})

test('release inventory API errors refuse rather than assume an empty channel', (t) => {
  const fx = fixture(t)
  fx.state.inventoryError = true
  refused(fx.run())
})

test('release lookup authorization errors never create a replacement release', (t) => {
  const fx = fixture(t)
  fx.state.lookupError = true
  refused(fx.run())
})

test('an incomplete published release refuses without filling missing assets', (t) => {
  const fx = fixture(t)
  fx.release.assets.pop()
  refused(fx.run())
})

test('duplicate or extra assets refuse without replacing any files', (t) => {
  const fx = fixture(t)
  fx.release.assets.push({ ...fx.release.assets[0], id: 77 })
  refused(fx.run())
})

test('a failed starter upload requires owner recovery without deletion', (t) => {
  const fx = fixture(t)
  fx.release.draft = true
  fx.release.assets[0].state = 'starter'
  refused(fx.run())
})

test('a malformed published version refuses instead of being ignored', (t) => {
  const fx = fixture(t)
  fx.state.releases.push({ ...structuredClone(fx.release), id: 2, tag_name: 'unexpected-version' })
  refused(fx.run())
})

test('malformed inventory page data refuses without writes', (t) => {
  const fx = fixture(t)
  fx.state.inventoryOverride = [{ invalid: 'not an API page' }]
  refused(fx.run())
})

test('failure to verify latest reports failure without hiding the new public release', (t) => {
  const fx = fixture(t)
  fx.state.releases = []
  fx.state.latest = null
  fx.state.latestError = true
  const result = fx.run()
  assert.notEqual(result.status, 0, 'latest lookup failure must be reported')
  assert.equal(result.state.releases.length, 1)
  assert.equal(result.state.releases[0].draft, false, 'publication is never reversed')
  assert.equal(result.state.releases[0].assets.length, 3)
})
