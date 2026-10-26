// Execute the publisher's actual Bash against an isolated GitHub boundary; never use credentials or network.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { test } from 'node:test'

const workflow = readFileSync(
  resolve(import.meta.dirname, '../../../.github/workflows/fork-release-win-build.yml'),
  'utf8'
).replaceAll('\r\n', '\n')
const tag = 'v1.4.241-mercurai.9'
const candidate = {
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  controllerSha: 'c'.repeat(40),
  manifestSha: 'd'.repeat(40),
  policySha: 'e'.repeat(64),
  version: tag.slice(1),
  series: [`patch/example:${'f'.repeat(40)}`]
}
const provenance = {
  schemaVersion: 1,
  sourceRepository: 'mercurai/orca',
  tag,
  candidate,
  qualification: { runId: 81, attempt: 1, dispatchId: 'assembly-80-1' },
  receiptSha256: '1'.repeat(64)
}
const filenames = ['orca-windows-setup.exe', 'orca-windows-setup.exe.blockmap', 'latest.yml']

function stepScript(name) {
  const lines = workflow.split('\n')
  const start = lines.indexOf(`      - name: ${name}`)
  assert.notEqual(start, -1, `publisher step exists: ${name}`)
  let end = start + 1
  while (end < lines.length && !/^ {6}- /.test(lines[end]) && !/^ {2}\w/.test(lines[end])) {
    end++
  }
  const block = lines.slice(start, end)
  const run = block.indexOf('        run: |')
  assert.notEqual(run, -1, `${name} runs fixed Bash`)
  const script = []
  for (const line of block.slice(run + 1)) {
    if (line.trim() && !line.startsWith('          ')) {
      break
    }
    script.push(line.slice(10))
  }
  return script.join('\n')
}

// This is only the API boundary. All publication decisions come from the checked-in workflow.
function syntheticGithub() {
  const fs = require('node:fs')
  const path = require('node:path')
  const crypto = require('node:crypto')
  const args = process.argv.slice(2)
  const statePath = process.env.PUBLICATION_FIXTURE_STATE
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  const option = (name) => args[args.indexOf(name) + 1]
  const save = () => fs.writeFileSync(statePath, JSON.stringify(state))
  const output = (value) =>
    process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value))
  const fail = (message) => {
    process.stderr.write(message)
    process.exit(1)
  }
  const metadata = (release) => ({
    ...release,
    assets: release.assets.map(({ content: _content, ...asset }) => asset)
  })
  const upload = (release, filename) => {
    const bytes = fs.readFileSync(filename)
    const name = path.basename(filename)
    const existing = release.assets.find((asset) => asset.name === name)
    if (existing && !args.includes('--clobber')) {
      fail('HTTP 422: asset already exists')
    }
    release.assets = release.assets.filter((asset) => asset.name !== name)
    release.assets.push({
      id: state.nextId++,
      name,
      size: bytes.length,
      state: 'uploaded',
      digest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
      content: bytes.toString('base64')
    })
  }
  const recordWrite = () => {
    state.writes.push(args)
    save()
  }

  if (args[0] === 'release') {
    const command = args[1]
    const target = args[2]
    const release = state.releases.find((item) => item.tag_name === target)
    if (command === 'view') {
      if (state.lookupError) {
        fail('HTTP 403: synthetic lookup refusal')
      }
      if (!release) {
        fail('HTTP 404: release not found')
      }
      if (args.includes('--jq') && option('--jq') === '.assets[].name') {
        output(release.assets.map((asset) => asset.name).join('\n'))
      } else {
        output(metadata(release))
      }
      return
    }
    if (command === 'edit') {
      recordWrite()
      if (!release) {
        fail('HTTP 404: release not found')
      }
      if (args.includes('--draft=true')) {
        release.draft = true
      }
      if (args.includes('--draft=false')) {
        release.draft = false
      }
      if (args.includes('--latest')) {
        state.latest = release.id
      }
      save()
      return
    }
    if (command === 'upload') {
      recordWrite()
      if (!release) {
        fail('HTTP 404: release not found')
      }
      for (const filename of args.filter((arg) => arg.startsWith('dist/'))) {
        upload(release, filename)
      }
      save()
      return
    }
    if (command === 'create') {
      recordWrite()
      if (release) {
        fail('HTTP 422: release exists')
      }
      const created = {
        id: state.nextId++,
        tag_name: target,
        draft: args.includes('--draft'),
        prerelease: false,
        body: args.includes('--notes-file')
          ? fs.readFileSync(option('--notes-file'), 'utf8')
          : option('--notes'),
        assets: []
      }
      for (const filename of args.filter((arg) => arg.startsWith('dist/'))) {
        upload(created, filename)
      }
      state.releases.push(created)
      save()
      return
    }
    if (command === 'download') {
      if (!release) {
        fail('HTTP 404: release not found')
      }
      const directory = args.includes('--dir') ? option('--dir') : '.'
      fs.mkdirSync(directory, { recursive: true })
      for (const asset of release.assets) {
        if (!args.includes('--pattern') || asset.name === option('--pattern')) {
          fs.writeFileSync(path.join(directory, asset.name), Buffer.from(asset.content, 'base64'))
        }
      }
      return
    }
  }
  if (args[0] === 'api') {
    const endpoint = args.find((arg) => arg.startsWith('repos/'))
    const method = args.includes('-X')
      ? option('-X')
      : args.includes('--method')
        ? option('--method')
        : 'GET'
    if (method !== 'GET') {
      recordWrite()
      fail(`unsupported synthetic mutation: ${args.join(' ')}`)
    }
    if (endpoint?.includes('/commits')) {
      output([{ sha: '2'.repeat(40) }])
      return
    }
    if (state.inventoryError && endpoint?.includes('/releases')) {
      fail('HTTP 503: synthetic inventory failure')
    }
    if (endpoint?.endsWith('/releases/latest')) {
      const latest = state.releases.find((release) => release.id === state.latest)
      if (!latest) {
        fail('HTTP 404: no latest release')
      }
      output(metadata(latest))
      return
    }
    if (/\/releases(?:\?|$)/.test(endpoint ?? '')) {
      const pages = []
      for (let index = 0; index < state.releases.length; index += state.pageSize) {
        pages.push(state.releases.slice(index, index + state.pageSize).map(metadata))
      }
      output(
        args.includes('--paginate')
          ? args.includes('--slurp')
            ? pages
            : pages.flat()
          : (pages[0] ?? [])
      )
      return
    }
    const assets = /\/releases\/(\d+)\/assets/.exec(endpoint ?? '')
    if (assets) {
      const release = state.releases.find((item) => item.id === Number(assets[1]))
      if (!release) {
        fail('HTTP 404: release not found')
      }
      const value = metadata(release).assets
      output(args.includes('--slurp') ? [value] : value)
      return
    }
  }
  fail(`unsupported synthetic gh command: ${args.join(' ')}`)
}

function fixture(t, { requestedTag = tag } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'orca-publication-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dist = join(root, 'dist')
  const bin = join(root, 'bin')
  mkdirSync(dist)
  mkdirSync(bin)
  const bytes = Buffer.from('synthetic installer bytes, never executable')
  const sha512 = createHash('sha512').update(bytes).digest('base64')
  const files = {
    'orca-windows-setup.exe': bytes,
    'orca-windows-setup.exe.blockmap': Buffer.from('synthetic blockmap'),
    'latest.yml': Buffer.from(
      `version: ${requestedTag.slice(1)}\nfiles:\n  - url: orca-windows-setup.exe\n    sha512: ${sha512}\n    size: ${bytes.length}\npath: orca-windows-setup.exe\nsha512: ${sha512}\nreleaseDate: '2026-10-26T00:00:00.000Z'\n`
    )
  }
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dist, name), content)
  }
  const expected = structuredClone(provenance)
  expected.tag = requestedTag
  expected.candidate.version = requestedTag.slice(1)
  const assetRecords = filenames.map((name, index) => ({
    id: index + 10,
    name,
    size: files[name].length,
    state: 'uploaded',
    digest: `sha256:${createHash('sha256').update(files[name]).digest('hex')}`,
    content: files[name].toString('base64')
  }))
  const publication = {
    ...expected,
    buildRunId: 101,
    assets: assetRecords.map(({ name, size, digest }) => ({ name, size, sha256: digest.slice(7) }))
  }
  const release = {
    id: 1,
    tag_name: requestedTag,
    draft: false,
    prerelease: false,
    body: JSON.stringify(publication),
    assets: assetRecords
  }
  const state = { releases: [release], latest: 1, nextId: 100, pageSize: 1, writes: [] }
  const statePath = join(root, 'state.json')
  const executable = join(bin, 'gh')
  writeFileSync(executable, `#!/usr/bin/env node\n(${syntheticGithub.toString()})()\n`)
  chmodSync(executable, 0o755)
  const script = join(root, 'publisher.sh')
  writeFileSync(
    script,
    [
      'Check the release files',
      'Make sure the channel repo has a commit',
      'Publish the release',
      'Verify the update manifest is public'
    ]
      .map(stepScript)
      .join('\n')
  )
  const run = () => {
    writeFileSync(statePath, JSON.stringify(state))
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(GH_|GITHUB_|BASH_ENV$|ENV$|TAG$|BUILD_SHA$|CHANNEL_REPO$)/i.test(key)
      )
    )
    const result = spawnSync('bash', [script], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20000,
      env: {
        ...inherited,
        PATH: `${bin.replaceAll('\\', '/')}:${process.env.PATH}`,
        GH_TOKEN: 'synthetic-token-no-service-access',
        GH_REPO: 'mercurai/orca',
        GITHUB_REPOSITORY: 'mercurai/orca',
        CHANNEL_REPO: 'mercurai/orca-mercurai',
        GITHUB_RUN_ID: '101',
        GITHUB_RUN_ATTEMPT: '2',
        GITHUB_SHA: candidate.controllerSha,
        TAG: requestedTag,
        BUILD_SHA: candidate.commit,
        QUALIFICATION_RUN_ID: '81',
        PROMOTION_PROVENANCE: JSON.stringify(expected),
        PUBLICATION_FIXTURE_STATE: statePath,
        GITHUB_OUTPUT: join(root, 'output'),
        RUNNER_TEMP: root
      }
    })
    assert.equal(result.error, undefined, `publisher shell launched: ${result.error?.message}`)
    return { ...result, state: JSON.parse(readFileSync(statePath, 'utf8')) }
  }
  return { run, state, release, files, publication, requestedTag }
}

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
