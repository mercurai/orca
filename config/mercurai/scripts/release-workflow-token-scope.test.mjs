// The owner's installed app updates itself from the channel repo, so the code a release build
// runs must never share a job with the token that publishes it. These pin that boundary in
// fork-release-win-build.yml and the workflow it calls (claude-code-config#1125).
// Run with `node --test "config/mercurai/scripts/*.test.mjs"` from the repo root.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

const workflows = resolve(import.meta.dirname, '..', '..', '..', '.github', 'workflows')
const read = (name) => readFileSync(resolve(workflows, name), 'utf8').replaceAll('\r\n', '\n')
const release = read('fork-release-win-build.yml')
const template = read('fork-orcad-template.yml')

/** Each job's text, keyed by name: a job starts at a two-space key under `jobs:`. */
function jobsOf(workflow) {
  const body = workflow.slice(workflow.indexOf('\njobs:\n') + '\njobs:\n'.length)
  const jobs = new Map()
  let name = null
  for (const line of body.split('\n')) {
    // A trailing comment on the key line must not hide a job inside the one before it.
    const start = /^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/.exec(line)
    if (start) {
      name = start[1]
      jobs.set(name, '')
    } else if (name) {
      jobs.set(name, `${jobs.get(name)}${line}\n`)
    }
  }
  return jobs
}

/** Text with whole-line comments removed, so a comment that names a secret is not a reference. */
const code = (text) =>
  text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')

const releaseJobs = jobsOf(release)

test('the release workflow has exactly the four jobs this test knows', () => {
  assert.deepEqual([...releaseJobs.keys()], ['preflight', 'orcad-template', 'build-win', 'publish'])
})

test('only the publish job references a secret', () => {
  for (const [name, text] of releaseJobs) {
    const references = /\bsecrets\b/.test(code(text))
    assert.equal(references, name === 'publish', `${name} ${references ? 'references' : 'lacks'} a secret`)
  }
  // Nothing outside the jobs either: a workflow-level env reaches every job.
  const outsideJobs = code(release.slice(0, release.indexOf('\njobs:\n')))
  assert.doesNotMatch(outsideJobs, /\bsecrets\b/)
})

test('no YAML anchor or alias can carry a value from one job into another', () => {
  assert.doesNotMatch(code(release), /(^|[\s:[,-])[&*][A-Za-z0-9_-]+\b/m)
})

test('the workflow starts only by hand: another trigger leaves inputs.dry_run empty', () => {
  const on = release.slice(release.indexOf('\non:\n'), release.indexOf('\npermissions:\n'))
  assert.deepEqual(on.match(/^ {2}[A-Za-z_]+:/gm), ['  workflow_dispatch:'])
})

test('the template workflow can only be called, never started on its own', () => {
  // A dispatch from the default branch would run a branch's code in the release cache scope.
  const on = template.slice(template.indexOf('\non:\n'), template.indexOf('\npermissions:\n'))
  assert.deepEqual(on.match(/^ {2}[A-Za-z_]+:/gm), ['  workflow_call:'])
})

test('no job hands every secret on, and the called workflow is given none', () => {
  assert.doesNotMatch(code(release), /secrets:\s*inherit/)
  assert.doesNotMatch(releaseJobs.get('orcad-template'), /^\s+secrets:/m)
  assert.doesNotMatch(code(template), /\bsecrets\b/)
})

test('the workflow grants its token read access only', () => {
  for (const [name, workflow] of [
    ['release', release],
    ['template', template]
  ]) {
    assert.match(workflow, /^permissions:\n {2}contents: read\n(?! )/m, `${name} top-level permissions`)
    assert.doesNotMatch(code(workflow), /^[ \t]+permissions:/m, `${name} has a job-level permissions block`)
    assert.doesNotMatch(code(workflow), /:\s*write\b/, `${name} grants write`)
  }
})

test('the publish job is gated on the dispatch itself, exactly', () => {
  // Exact: `always() ||`, `|| true` or a value a build step can write (env, needs, steps, vars)
  // would each open it. The ref clause keeps a ref build, always a dry run, out of it.
  const gates = releaseJobs.get('publish').match(/^ {4}if: .*$/gm)
  assert.deepEqual(gates, [
    "    if: ${{ github.repository == 'mercurai/orca' && !inputs.dry_run && inputs.ref == '' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch || 'mercurai') }}"
  ])
})

test('no publish step carries its own condition or may fail quietly', () => {
  const publish = code(releaseJobs.get('publish'))
  // Either position: `- if:` as a step's first key, or `if:` under it.
  assert.doesNotMatch(publish, /^ {6,}(- )?if:/m)
  assert.doesNotMatch(publish, /continue-on-error/)
})

test('the publish job runs no repository code: its steps are exactly these', () => {
  const publish = code(releaseJobs.get('publish'))
  const steps = [...publish.matchAll(/^ {6}- (name|uses): (.+)$/gm)].map((match) => match[2])
  assert.deepEqual(steps, [
    'Require the bot token',
    'Vet the tag',
    'Download the release files',
    'Check the release files',
    'Make sure the channel repo has a commit',
    'Publish the release',
    'Verify the update manifest is public'
  ])
  // The one action it uses, and no other: no checkout, no local or third-party action.
  assert.deepEqual(publish.match(/^\s+(- )?uses: .+$/gm), ['        uses: actions/download-artifact@v8'])
  // No interpreter or fetch that could run code other than these steps' own shell.
  assert.doesNotMatch(
    publish,
    /\b(pnpm|npm|npx|node|python3?|git\s+clone|gh\s+repo\s+clone|curl|wget|source|eval|exec|chmod)\b/
  )
  assert.doesNotMatch(publish, /\b(bash|sh)\s+\S+\.sh\b|\.\/dist\//)
})

test('preflight keeps both of its rules', () => {
  const preflight = releaseJobs.get('preflight')
  assert.ok(preflight.includes(String.raw`if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-mercurai\.[0-9]+$ ]]; then`))
  assert.match(preflight, /if \[ "\$publish" = "true" \] && \[ -n "\$REF_INPUT" \]; then\n[^\n]*\n\s+exit 1\n/)
  // A run from the default branch writes the caches a release restores: it builds tags only.
  assert.match(
    preflight,
    /if \[ -n "\$REF_INPUT" \] && \[ "\$DISPATCH_REF" = "refs\/heads\/\$DEFAULT_BRANCH" \]; then\n[^\n]*\n\s+exit 1\n/
  )
  assert.doesNotMatch(code(preflight), /continue-on-error|actions\/checkout|uses: \.\//)
})

test('the channel repo is named only where the token is', () => {
  for (const [name, text] of releaseJobs) {
    if (name !== 'publish') {
      assert.doesNotMatch(code(text), /CHANNEL_REPO|GH_TOKEN|gh release|gh api/, `${name} reaches for the channel`)
    }
  }
  assert.doesNotMatch(code(release.slice(0, release.indexOf('\njobs:\n'))), /CHANNEL_REPO|GH_TOKEN/)
})

test('the build job checks out without a token of its own, every time', () => {
  const build = code(releaseJobs.get('build-win'))
  assert.doesNotMatch(build, /^\s+token:/m)
  const checkouts = build.split(/^ {6}- /m).filter((step) => /uses: actions\/checkout@/.test(step))
  assert.ok(checkouts.length >= 1)
  for (const step of checkouts) {
    assert.match(step, /persist-credentials: false/)
  }
})

test('a dry run keeps no update manifest and marks the installer', () => {
  const build = releaseJobs.get('build-win')
  const strip = build.slice(build.indexOf('- name: Strip the update files from a dry run'))
  assert.match(strip, /if: needs\.preflight\.outputs\.publish != 'true'/)
  assert.match(strip, /rm -f dist\/latest\.yml dist\/orca-windows-setup\.exe\.blockmap/)
  assert.match(strip, /orca-windows-setup-DRY-RUN-\$\{TAG\}\.exe/)
  assert.match(strip, /name: orca-windows-\$\{\{ inputs\.tag \}\}-DRY-RUN\n\s+path: dry-run\//)
  // The release artifact, the only one with latest.yml, is uploaded for a publishing run alone.
  const releaseUpload = build.slice(
    build.indexOf('- name: Keep the release files as a run artifact'),
    build.indexOf('- name: Strip the update files from a dry run')
  )
  assert.match(releaseUpload, /if: needs\.preflight\.outputs\.publish == 'true'/)
  assert.match(releaseUpload, /dist\/latest\.yml/)
})
