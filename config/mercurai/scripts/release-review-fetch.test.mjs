import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const NOW = Date.parse('2026-10-26T12:00:00Z')
const repository = 'mercurai/orca'
const workflowPath = '.github/workflows/fork-accept-release-review.yml'
const actor = { login: 'synthetic-owner', id: 7 }
const candidate = {
  commit: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  controllerSha: 'c'.repeat(40),
  manifestSha: 'd'.repeat(40),
  policySha: 'e'.repeat(64),
  version: '1.4.241-mercurai.9',
  series: [`patch/example:${'f'.repeat(40)}`],
  upstream: {
    repository: 'stablyai/orca',
    mainSha: '1'.repeat(40),
    stableTag: 'v1.4.241',
    stableCommit: '2'.repeat(40)
  }
}
const endpoints = [
  `repos/${repository}/actions/workflows/fork-accept-release-review.yml`,
  `repos/${repository}/actions/runs/101`,
  `repos/${repository}/actions/runs/101/artifacts?per_page=100`,
  `repos/${repository}/actions/artifacts/303/zip`
]
const posix = (path) => path.replaceAll('\\', '/')

// Only GitHub's read boundary is synthetic; Bash, ZIP tools and both validators are real.
function syntheticGithub() {
  const fs = require('node:fs')
  const args = process.argv.slice(2)
  const statePath = process.env.REVIEW_FETCH_FIXTURE_STATE
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  state.calls.push(args)
  fs.writeFileSync(statePath, JSON.stringify(state))
  const endpoint = args.find((arg) => arg.startsWith('repos/'))
  const fail = (message) => {
    process.stderr.write(message)
    process.exit(1)
  }
  if (args[0] !== 'api' || args.includes('-X') || args.includes('--method')) {
    fail('unexpected synthetic GitHub mutation or command')
  }
  if (endpoint === state.failEndpoint) {
    fail('HTTP 403: synthetic review evidence refusal')
  }
  if (endpoint === state.zipEndpoint) {
    process.stdout.write(fs.readFileSync(state.archivePath))
    return
  }
  if (!Object.hasOwn(state.responses, endpoint)) {
    fail(`unexpected GitHub endpoint: ${endpoint}`)
  }
  const response = state.responses[endpoint]
  if (Array.isArray(response) && (!args.includes('--paginate') || !args.includes('--slurp'))) {
    fail('artifact inventory requires every slurped page')
  }
  process.stdout.write(JSON.stringify(response))
}

function fixture(t, { extraEntry = false, oversized = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'orca-review-fetch-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const policy = { review: { workflowPath, controllerRef: 'refs/heads/mercurai', owners: [actor] } }
  const expected = { repository, candidate: structuredClone(candidate) }
  const run = {
    id: 101,
    workflow_id: 91,
    repository: { full_name: repository },
    path: workflowPath,
    event: 'workflow_dispatch',
    head_branch: 'mercurai',
    head_sha: candidate.controllerSha,
    run_attempt: 2,
    status: 'completed',
    conclusion: 'success',
    actor,
    triggering_actor: actor
  }
  const record = {
    schemaVersion: 1,
    scope: 'candidate-and-controller',
    verdict: 'approved',
    ownerAccepted: true,
    openBlockers: [],
    candidate: structuredClone(candidate),
    reviewer: {
      identity: 'synthetic-independent-reviewer',
      independent: true,
      evidenceSummary: 'Reviewed the full candidate and controller without blockers.',
      evidenceSha256: '3'.repeat(64)
    },
    authentication: {
      repository,
      workflowId: 91,
      workflowPath,
      controllerRef: policy.review.controllerRef,
      controllerSha: candidate.controllerSha,
      runId: 101,
      attempt: 2,
      actor,
      triggeringActor: actor
    }
  }
  const archivePath = join(root, 'review.zip')
  const entries = {
    'release-review.json': JSON.stringify(record) + (oversized ? ' '.repeat(1048576) : '')
  }
  if (extraEntry) {
    entries['unexpected.txt'] = 'must not be accepted'
  }
  const entriesPath = join(root, 'entries.json')
  writeFileSync(entriesPath, JSON.stringify(entries))
  const zipped = spawnSync(
    process.platform === 'win32' ? 'python' : 'python3',
    [
      '-c',
      'import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[2], "w") as archive:\n for name,content in json.load(open(sys.argv[1], encoding="utf-8")).items():\n  entry=zipfile.ZipInfo(name,(2026,10,26,12,0,0))\n  archive.writestr(entry,content,compress_type=zipfile.ZIP_DEFLATED)',
      entriesPath,
      archivePath
    ],
    { encoding: 'utf8', timeout: 10000, windowsHide: true }
  )
  assert.equal(zipped.error, undefined, zipped.error?.message)
  assert.equal(zipped.status, 0, zipped.stderr)
  const bytes = readFileSync(archivePath)
  const digest = createHash('sha256').update(bytes).digest('hex')
  const artifact = {
    id: 303,
    name: 'release-review-101-2',
    expired: false,
    expires_at: '2026-11-01T00:00:00Z',
    size_in_bytes: bytes.length,
    digest: `sha256:${digest}`,
    workflow_run: { id: 101, head_branch: 'mercurai', head_sha: candidate.controllerSha }
  }
  const state = {
    archivePath,
    zipEndpoint: endpoints[3],
    calls: [],
    responses: {
      [endpoints[0]]: { id: 91, path: workflowPath },
      [endpoints[1]]: run,
      [endpoints[2]]: [
        { total_count: 2, artifacts: [{ ...artifact, id: 302, name: 'release-review-101-1' }] },
        { total_count: 2, artifacts: [artifact] }
      ]
    }
  }
  const gh = join(bin, 'gh')
  writeFileSync(gh, `#!/usr/bin/env node\n(${syntheticGithub.toString()})()\n`)
  chmodSync(gh, 0o755)
  const clock = join(root, 'clock.cjs')
  writeFileSync(clock, `Date.now = () => ${NOW}\n`)
  const destination = join(root, 'evidence')
  const expectedPath = join(root, 'expected.json')
  const policyPath = join(root, 'policy.json')
  const statePath = join(root, 'state.json')
  const invoke = () => {
    for (const [path, value] of [
      [expectedPath, expected],
      [policyPath, policy],
      [statePath, state]
    ]) {
      writeFileSync(path, JSON.stringify(value))
    }
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(GH_|GITHUB_|NODE_OPTIONS$|BASH_ENV$|ENV$)/i.test(key)
      )
    )
    const result = spawnSync(
      'bash',
      [
        posix(join(import.meta.dirname, 'fetch-release-review.sh')),
        posix(expectedPath),
        posix(policyPath),
        '101',
        posix(destination)
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 20000,
        windowsHide: true,
        env: {
          ...inherited,
          PATH: `${posix(bin)}:${process.env.PATH}`,
          GITHUB_REPOSITORY: repository,
          GH_CONFIG_DIR: posix(join(root, 'gh-config')),
          REVIEW_FETCH_FIXTURE_STATE: posix(statePath),
          NODE_OPTIONS: `--require=${JSON.stringify(posix(clock))}`
        }
      }
    )
    assert.equal(result.error, undefined, result.error?.message)
    return { ...result, calls: JSON.parse(readFileSync(statePath, 'utf8')).calls }
  }
  const read = (name) => JSON.parse(readFileSync(join(destination, name), 'utf8'))
  return { invoke, read, destination, state, policy, expected, run, record, artifact, digest }
}

function refused(fx, result) {
  assert.notEqual(
    result.status,
    0,
    `fetch must refuse; stdout=${result.stdout}; stderr=${result.stderr}`
  )
  assert.equal(existsSync(join(fx.destination, 'review-context.json')), false)
}

test('downloads the exact latest-attempt artifact across all pages and binds its archive hash', (t) => {
  const fx = fixture(t)
  const result = fx.invoke()
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, reasons: [] })
  assert.deepEqual(
    result.calls.map((args) => args.find((arg) => arg.startsWith('repos/'))),
    endpoints
  )
  assert.deepEqual(fx.read('release-review.json'), fx.record)
  assert.deepEqual(fx.read('review-context.json'), {
    run: fx.run,
    artifact: fx.artifact,
    archiveSha256: fx.digest,
    expected: {
      ...fx.expected,
      workflowId: 91,
      runId: 101,
      attempt: 2,
      controllerRef: 'refs/heads/mercurai'
    }
  })
  assert.equal(Object.hasOwn(fx.read('review-context.json'), 'record'), false)
})

test('refuses an artifact from the prior attempt after the live run has advanced', (t) => {
  const fx = fixture(t)
  fx.run.run_attempt = 3
  const result = fx.invoke()
  refused(fx, result)
  assert.match(result.stderr, /artifact is missing or ambiguous/)
  assert.equal(result.calls.length, 3, 'a stale artifact must not be downloaded')
})

test('refuses live run identity that disagrees with workflow metadata', (t) => {
  const fx = fixture(t)
  fx.run.workflow_id = 92
  const result = fx.invoke()
  refused(fx, result)
  assert.match(result.stdout, /live run does not match/)
})

test('refuses prior-attempt acceptance inside an artifact named for the latest attempt', (t) => {
  const fx = fixture(t)
  fx.run.run_attempt = 3
  fx.artifact.name = 'release-review-101-3'
  const result = fx.invoke()
  refused(fx, result)
  assert.match(result.stdout, /provenance does not match/)
})

test('refuses correctly named artifact metadata bound to another run', (t) => {
  const fx = fixture(t)
  fx.artifact.workflow_run.id = 102
  const result = fx.invoke()
  refused(fx, result)
  assert.match(result.stderr, /not from the expected controller run/)
  assert.equal(result.calls.length, 3, 'foreign archive bytes must not be downloaded')
})

for (const [index, endpoint] of endpoints.entries()) {
  test(`fails closed on API 403 at evidence stage ${index + 1}`, (t) => {
    const fx = fixture(t)
    fx.state.failEndpoint = endpoint
    const result = fx.invoke()
    refused(fx, result)
    assert.match(result.stderr, /HTTP 403/)
    assert.equal(result.calls.length, index + 1, 'no later GitHub operation follows the refusal')
  })
}

test('clears previous accepted context when a reused destination encounters an API refusal', (t) => {
  const fx = fixture(t)
  const accepted = fx.invoke()
  assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`)
  assert.equal(fx.read('review-context.json').archiveSha256, fx.digest)
  fx.state.failEndpoint = endpoints[0]
  const rejected = fx.invoke()
  assert.match(rejected.stderr, /HTTP 403/)
  refused(fx, rejected)
})

test('refuses downloaded ZIP bytes whose hash differs from the artifact API digest', (t) => {
  const fx = fixture(t)
  fx.artifact.digest = `sha256:${'0'.repeat(64)}`
  const result = fx.invoke()
  refused(fx, result)
  assert.match(result.stdout, /does not match its GitHub digest/)
  assert.equal(existsSync(join(fx.destination, 'release-review.json')), false)
})

test('refuses an archive containing an additional entry', (t) => {
  const fx = fixture(t, { extraEntry: true })
  const result = fx.invoke()
  refused(fx, result)
  assert.match(result.stdout, /must contain only release-review.json/)
})

test('refuses oversized decompressed JSON even when the compressed archive is small', (t) => {
  const fx = fixture(t, { oversized: true })
  assert.ok(fx.artifact.size_in_bytes < 1048576)
  refused(fx, fx.invoke())
})

test('refuses policy owners without their immutable GitHub account IDs', (t) => {
  const fx = fixture(t)
  fx.policy.review.owners = [{ login: actor.login }]
  const result = fx.invoke()
  refused(fx, result)
  assert.match(result.stdout, /policy is invalid or missing/)
})
