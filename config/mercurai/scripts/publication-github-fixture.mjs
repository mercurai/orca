// Execute the publisher's actual Bash against an isolated GitHub boundary; never use credentials or network.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const workflow = readFileSync(
  resolve(import.meta.dirname, '../../../.github/workflows/fork-release-win-build.yml'),
  'utf8'
).replaceAll('\r\n', '\n')
export const tag = 'v1.4.241-mercurai.9'
const candidate = {
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  controllerSha: 'c'.repeat(40),
  manifestSha: 'd'.repeat(40),
  policySha: 'e'.repeat(64),
  version: tag.slice(1),
  series: [`patch/example:${'f'.repeat(40)}`],
  upstream: {
    repository: 'stablyai/orca',
    mainSha: '7'.repeat(40),
    stableTag: 'v1.4.241',
    stableCommit: '8'.repeat(40)
  }
}
const owner = { login: 'release-owner', id: 19 }
const reviewRun = {
  id: 77,
  workflow_id: 33,
  run_attempt: 1,
  repository: { full_name: 'mercurai/orca' },
  path: '.github/workflows/fork-accept-release-review.yml',
  event: 'workflow_dispatch',
  head_branch: 'mercurai',
  head_sha: candidate.controllerSha,
  status: 'completed',
  conclusion: 'success',
  actor: owner,
  triggering_actor: owner
}
const reviewArtifact = {
  id: 99,
  name: 'release-review-77-1',
  expired: false,
  expires_at: '2999-01-01T00:00:00Z',
  size_in_bytes: 1024,
  digest: `sha256:${'9'.repeat(64)}`,
  workflow_run: { id: 77, head_sha: candidate.controllerSha, head_branch: 'mercurai' }
}
const qualificationRun = {
  id: 81,
  workflow_id: 22,
  run_attempt: 1,
  repository: { full_name: 'mercurai/orca' },
  path: '.github/workflows/fork-qualify-release.yml',
  event: 'workflow_dispatch',
  head_branch: 'mercurai',
  head_sha: candidate.controllerSha,
  status: 'completed',
  conclusion: 'success',
  display_title: 'qualify assembly-80-1'
}
const provenance = {
  schemaVersion: 1,
  sourceRepository: 'mercurai/orca',
  tag,
  candidate,
  qualification: { runId: 81, attempt: 1, workflowId: 22, dispatchId: 'assembly-80-1' },
  review: {
    schemaVersion: 1,
    scope: 'candidate-and-controller',
    verdict: 'approved',
    ownerAccepted: true,
    openBlockers: [],
    candidate,
    reviewer: {
      identity: 'independent fixture reviewer',
      independent: true,
      evidenceSummary: 'Synthetic reviewed candidate',
      evidenceSha256: '6'.repeat(64)
    },
    authentication: {
      repository: 'mercurai/orca',
      workflowId: 33,
      workflowPath: '.github/workflows/fork-accept-release-review.yml',
      controllerRef: 'refs/heads/mercurai',
      controllerSha: candidate.controllerSha,
      runId: 77,
      attempt: 1,
      actor: owner,
      triggeringActor: owner
    }
  },
  reviewArtifact,
  receiptSha256: '1'.repeat(64)
}
export const filenames = ['orca-windows-setup.exe', 'orca-windows-setup.exe.blockmap', 'latest.yml']

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
    if (state.changeReviewOnUpload) {
      state.authorization['repos/mercurai/orca/actions/runs/77'].run_attempt++
      state.changeReviewOnUpload = false
    }
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
      if (method === 'PUT' && endpoint?.endsWith('/contents/README.md') && state.emptyHistory) {
        state.emptyHistory = false
        save()
        output({ commit: { sha: '2'.repeat(40) } })
        return
      }
      fail(`unsupported synthetic mutation: ${args.join(' ')}`)
    }
    if (Object.hasOwn(state.authorization, endpoint)) {
      if (state.authorizationError === endpoint || state.authorizationError === true) {
        fail('HTTP 403: synthetic authorization read refusal')
      }
      output(state.authorization[endpoint])
      return
    }
    if (endpoint === 'repos/mercurai/orca-mercurai') {
      output({ full_name: 'mercurai/orca-mercurai' })
      return
    }
    if (endpoint?.includes('/commits')) {
      if (state.emptyHistory) {
        if (args.includes('--include')) {
          output(
            'HTTP/2.0 409 Conflict\r\ncontent-type: application/json\r\n\r\n{"message":"Git Repository is empty."}'
          )
        }
        fail('HTTP 409: Git Repository is empty.')
      }
      if (state.historyError) {
        if (args.includes('--include')) {
          output(`HTTP/2.0 ${state.historyError} Error\r\n\r\n{"message":"synthetic refusal"}`)
        }
        fail(`HTTP ${state.historyError}: synthetic history refusal`)
      }
      if (args.includes('--include')) {
        output('HTTP/2.0 200 OK\r\n\r\n')
      }
      output([{ sha: '2'.repeat(40) }])
      return
    }
    if (state.inventoryError && endpoint?.includes('/releases')) {
      fail('HTTP 503: synthetic inventory failure')
    }
    if (endpoint?.endsWith('/releases/latest')) {
      if (state.latestError) {
        fail('HTTP 503: synthetic latest verification failure')
      }
      const latest = state.releases.find((release) => release.id === state.latest)
      if (!latest) {
        fail('HTTP 404: no latest release')
      }
      output(metadata(latest))
      return
    }
    if (/\/releases(?:\?|$)/.test(endpoint ?? '')) {
      if (state.inventoryOverride) {
        output(state.inventoryOverride)
        return
      }
      const pages = []
      for (let index = 0; index < state.releases.length; index += state.pageSize) {
        pages.push(state.releases.slice(index, index + state.pageSize).map(metadata))
      }
      output(
        args.includes('--paginate')
          ? args.includes('--slurp')
            ? pages.length
              ? pages
              : [[]]
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
    const releaseId = /\/releases\/(\d+)$/.exec(endpoint ?? '')
    if (releaseId) {
      if (state.lookupError) {
        fail('HTTP 403: synthetic lookup refusal')
      }
      const release = state.releases.find((item) => item.id === Number(releaseId[1]))
      if (!release) {
        fail('HTTP 404: release not found')
      }
      output(metadata(release))
      return
    }
  }
  fail(`unsupported synthetic gh command: ${args.join(' ')}`)
}

export function fixture(t, { requestedTag = tag } = {}) {
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
  expected.candidate.upstream.stableTag = requestedTag.split('-mercurai.')[0]
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
  const state = {
    releases: [release],
    latest: 1,
    nextId: 100,
    pageSize: 1,
    writes: [],
    authorization: {
      'repos/mercurai/orca': { full_name: 'mercurai/orca', default_branch: 'mercurai' },
      'repos/mercurai/orca/git/ref/heads/mercurai': {
        ref: 'refs/heads/mercurai',
        object: { sha: candidate.controllerSha, type: 'commit' }
      },
      'repos/mercurai/orca/actions/workflows/fork-accept-release-review.yml': {
        id: 33,
        path: '.github/workflows/fork-accept-release-review.yml'
      },
      'repos/mercurai/orca/actions/workflows/fork-qualify-release.yml': {
        id: 22,
        path: '.github/workflows/fork-qualify-release.yml'
      },
      'repos/mercurai/orca/actions/runs/77': structuredClone(reviewRun),
      'repos/mercurai/orca/actions/runs/81': structuredClone(qualificationRun),
      'repos/mercurai/orca/actions/artifacts/99': structuredClone(reviewArtifact)
    }
  }
  const statePath = join(root, 'state.json')
  const executable = join(bin, 'gh')
  writeFileSync(executable, `#!/usr/bin/env node\n(${syntheticGithub.toString()})()\n`)
  chmodSync(executable, 0o755)
  const script = join(root, 'publisher.sh')
  writeFileSync(
    script,
    [
      'Check the release files',
      'Check channel repository access',
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
