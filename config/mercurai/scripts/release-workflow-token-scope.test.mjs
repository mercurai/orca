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
    const start = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
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

test('the publish job is gated on the dispatch itself, not on a value a step can write', () => {
  const gate = /^ {4}if: (.+)$/m.exec(releaseJobs.get('publish'))?.[1] ?? ''
  assert.match(gate, /!inputs\.dry_run/)
  assert.match(gate, /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch \|\| 'mercurai'\)/)
  // `env` and step or job outputs can be written by the code being built; the gate must use neither.
  assert.doesNotMatch(gate, /\benv\.|\bneeds\.|\bsteps\.|\bvars\./)
})

test('no publish step carries its own condition that could re-open the gate', () => {
  assert.doesNotMatch(code(releaseJobs.get('publish')), /^ {8}if:/m)
})

test('the publish job runs no repository code', () => {
  const publish = code(releaseJobs.get('publish'))
  assert.doesNotMatch(publish, /actions\/checkout/)
  assert.doesNotMatch(publish, /uses: \.\//)
  assert.doesNotMatch(publish, /\b(pnpm|npm|npx|node)\b/)
})

test('the channel repo is named only where the token is', () => {
  for (const [name, text] of releaseJobs) {
    if (name !== 'publish') {
      assert.doesNotMatch(code(text), /CHANNEL_REPO|GH_TOKEN|gh release|gh api/, `${name} reaches for the channel`)
    }
  }
  assert.doesNotMatch(code(release.slice(0, release.indexOf('\njobs:\n'))), /CHANNEL_REPO|GH_TOKEN/)
})

test('the build job checks out without a token of its own', () => {
  assert.doesNotMatch(code(releaseJobs.get('build-win')), /^\s+token:/m)
  assert.match(releaseJobs.get('build-win'), /persist-credentials: false/)
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
