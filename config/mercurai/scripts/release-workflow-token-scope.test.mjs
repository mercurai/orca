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

// Raw text, not code(): GitHub expands `${{ }}` on any line of a block scalar, `#` or not.
const SECRET_EXPRESSION = /\$\{\{[^}]*\bsecrets\b/

test('only the publish job references a secret', () => {
  for (const [name, text] of releaseJobs) {
    const references = /\bsecrets\b/.test(code(text)) || SECRET_EXPRESSION.test(text)
    assert.equal(references, name === 'publish', `${name} ${references ? 'references' : 'lacks'} a secret`)
  }
  // Nothing outside the jobs either: a workflow-level env reaches every job.
  const outsideJobs = release.slice(0, release.indexOf('\njobs:\n'))
  assert.doesNotMatch(code(outsideJobs), /\bsecrets\b/)
  assert.doesNotMatch(outsideJobs, SECRET_EXPRESSION)
})

test('every job is a plain block key: none hides inside another', () => {
  // A quoted key or a flow mapping would be read as part of the job above it.
  const body = release.slice(release.indexOf('\njobs:\n') + '\njobs:\n'.length)
  const topLevel = body.split('\n').filter((line) => /^ {2}\S/.test(line) && !/^ {2}#/.test(line))
  assert.deepEqual(topLevel, ['  preflight:', '  orcad-template:', '  build-win:', '  publish:'])
  // No flow-style mapping or sequence anywhere under jobs: (`${{` is an expression, not a mapping).
  for (const line of code(body).split('\n')) {
    // `needs: [a, b]` names jobs and is the one flow sequence allowed.
    const stripped = line.replaceAll(/\$\{\{.*?\}\}/g, '').replace(/^\s+needs: \[[\w, -]+\]$/, '')
    assert.doesNotMatch(stripped, /:\s*[{[]|^\s*-\s*[{[]/, `flow style in: ${line.trim()}`)
  }
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
  assert.deepEqual(publish.match(/^\s+(- )?uses: .+$/gm), [
    '        uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2'
  ])
  // No interpreter or fetch that could run code other than these steps' own shell.
  assert.doesNotMatch(
    publish,
    /\b(pnpm|npm|npx|node|python3?|git\s+clone|gh\s+repo\s+clone|curl|wget|source|eval|exec|chmod)\b/
  )
  assert.doesNotMatch(publish, /\b(bash|sh)\s+\S+\.sh\b|\.\/dist\//)
  assert.doesNotMatch(publish, /\|\s*(bash|sh|pwsh|powershell)\b|\b(bash|sh|pwsh)\s+-c\b|^\s*\.\s+\S/m)
  // The default shell or bash only: another interpreter could run a script the job fetched.
  assert.doesNotMatch(publish, /^\s+shell:(?!\s*bash\s*$)/m)
  assert.doesNotMatch(publish, /base64\s+(-d|--decode)/)
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

// Inherited upstream workflows and any job's runner token can write the default branch's cache
// scope, so nothing a release builds may come out of a cache, dry run or not (SEC-102). The repo's
// own install actions cache by default and come from the ref being built, so they are out too.
test('no release job restores or saves a cache', () => {
  for (const [name, workflow] of [
    ['release', release],
    ['template', template]
  ]) {
    const body = code(workflow)
    assert.doesNotMatch(body, /actions\/cache\b/, `${name} uses actions/cache`)
    assert.doesNotMatch(body, /uses:\s*\.\/\.github\/actions\//, `${name} uses a repo install action`)
    // setup-node's `cache:` and setup-* cache inputs of any spelling (cache-dependency-path too).
    assert.doesNotMatch(body, /^\s+cache[\w-]*:/m, `${name} passes a cache input`)
    const setupNode = body.split(/^ {6}- /m).filter((step) => /uses: actions\/setup-node@/.test(step))
    assert.ok(setupNode.length >= 1, `${name} sets up Node`)
    for (const step of setupNode) {
      // From v5 setup-node caches the packageManager's store on its own unless told not to.
      assert.match(step, /package-manager-cache: false/, `${name} setup-node may cache`)
    }
  }
  const build = code(releaseJobs.get('build-win'))
  const reset = build.slice(build.indexOf('- name: Start from empty build caches'))
  assert.ok(build.indexOf('- name: Start from empty build caches') < build.indexOf('- name: Install dependencies'))
  assert.match(reset, /ELECTRON_CACHE=\$RUNNER_TEMP\/electron-cache/)
  assert.match(reset, /ELECTRON_BUILDER_CACHE=\$RUNNER_TEMP\/electron-builder-cache/)
})

// A tag can be moved between jobs; every job builds the one commit preflight resolved (SEC-103).
test('every job builds the commit preflight resolved', () => {
  assert.match(releaseJobs.get('preflight'), /^ {6}build_sha: \$\{\{ steps\.vet\.outputs\.build_sha \}\}$/m)
  assert.match(releaseJobs.get('orcad-template'), /^ {6}ref: \$\{\{ needs\.preflight\.outputs\.build_sha \}\}$/m)
  const build = code(releaseJobs.get('build-win'))
  const checkouts = build.split(/^ {6}- /m).filter((step) => /uses: actions\/checkout@/.test(step))
  const ofTheBuild = checkouts.filter((step) => !/path: \.fork/.test(step))
  assert.equal(ofTheBuild.length, 1)
  assert.match(ofTheBuild[0], /ref: \$\{\{ needs\.preflight\.outputs\.build_sha \}\}/)
  assert.match(build, /if \[ "\$head_sha" != "\$BUILD_SHA" \]; then\n[^\n]*\n\s+exit 1\n/)
  // The template workflow refuses anything but a full sha.
  assert.ok(template.includes(String.raw`if [[ ! "$TEMPLATE_REF" =~ ^[0-9a-f]{40}$ ]]; then`))
})

// What these jobs build is what gets published: an action tag that moves would change it (SEC-203).
test('every action the release runs is pinned by commit', () => {
  for (const [name, workflow] of [
    ['release', release],
    ['template', template]
  ]) {
    for (const [, action] of code(workflow).matchAll(/^\s+(?:- )?uses: (\S+)/gm)) {
      if (action === './.github/workflows/fork-orcad-template.yml') continue
      assert.match(action, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${name} uses ${action}`)
    }
  }
})

// A dry-run ref names a branch of this repo, never a pull-request head or a fork-network sha (SEC-202).
test('preflight builds a branch or the tag, nothing else', () => {
  const preflight = releaseJobs.get('preflight')
  assert.ok(
    preflight.includes(
      String.raw`if [[ ! "$branch" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]] || [[ "$branch" == refs/* ]]; then`
    )
  )
  assert.match(preflight, /^\s+want=refs\/heads\/\$branch$/m)
  assert.match(preflight, /^\s+want=refs\/tags\/\$TAG$/m)
  assert.doesNotMatch(preflight, /build_sha=\$build_ref|build_sha=\$REF_INPUT/)
})

// Every build, dry or real, proves the manifest and that the installed app starts, before anything
// is uploaded or stripped: a release that does not launch must never publish.
test('every build checks the manifest and smokes the installer before upload', () => {
  const build = releaseJobs.get('build-win')
  const at = (name) => build.indexOf(`- name: ${name}`)
  const manifest = at('Check the update manifest field by field')
  const smoke = at('Smoke the installer (install, launch for 30 s, uninstall)')
  assert.ok(manifest > at('Check the build outputs') && smoke > manifest)
  for (const later of ['Keep the release files as a run artifact', 'Strip the update files from a dry run']) {
    assert.ok(at(later) > smoke, `${later} runs before the smoke`)
  }
  const stepAt = (start) => build.slice(start, build.indexOf('\n      - ', start + 1))
  for (const step of [stepAt(manifest), stepAt(smoke)]) {
    assert.doesNotMatch(step, /^\s+(if|continue-on-error):/m)
  }
  // The publish job's fields, checked without yq (absent on Windows runners): every line of the
  // manifest against the installer, size included, and nothing more.
  const manifestStep = stepAt(manifest)
  for (const line of [
    '"version: $VERSION"',
    '"  - url: orca-windows-setup.exe"',
    '"    sha512: $actual"',
    '"    size: $size"',
    '"path: orca-windows-setup.exe"',
    '"sha512: $actual"',
    '[ "${#found[@]}" -eq 8 ] || ok=false',
    `for i in "\${!expected[@]}"; do [ "\${found[$i]-}" = "\${expected[$i]}" ] || ok=false; done`,
    `[[ "\${found[7]-}" =~ ^releaseDate:\\ \\'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z\\'$ ]] || ok=false`,
    `sed 's/\\r$//' dist/latest.yml | LC_ALL=C grep -q $'\\r' && ok=false`,
    `tr -d '\\000' < dist/latest.yml | cmp -s - dist/latest.yml || ok=false`
  ]) {
    assert.ok(manifestStep.includes(line), line)
  }
  assert.match(manifestStep, /if \[ "\$ok" != true \]; then\n(?:.*\n){3}\s+exit 1\n\s+fi\n/)
  assert.doesNotMatch(code(manifestStep), /\byq\b/)
  const fields = `yq -r '[(.files | length), .files[0].url, .path, .files[0].sha512, .sha512, .version] | join(" ")' dist/latest.yml`
  assert.ok(releaseJobs.get('publish').includes(fields))
  const smokeStep = stepAt(smoke)
  assert.match(smokeStep, /-ArgumentList '\/S', "\/D=\$installDir" -PassThru\n(?:[^\n]*\n){2}\s+if \(-not \$setup\.WaitForExit\(300000\)\)/)
  assert.match(smokeStep, /Start-Sleep -Seconds 30/)
  assert.match(smokeStep, /\$ErrorActionPreference = 'Stop'/)
  // Alive means the app's main process, not a helper, daemon or crash handler from the same dir.
  assert.match(smokeStep, /\$_\.ExecutablePath\.StartsWith\(\$dir, \[StringComparison\]::OrdinalIgnoreCase\)/)
  assert.match(smokeStep, /\n\s+\$running = Get-OrcaUnder \$installDir\n/)
  // The exit code stays readable, and the relocated daemon stays under the run's dir.
  assert.match(smokeStep, /-PassThru\n[^\n]*\n\s+\$null = \$setup\.Handle\n/)
  assert.match(smokeStep, /\$env:LOCALAPPDATA = Join-Path \$root/)
  assert.ok(smokeStep.includes(String.raw`$_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch '\.[cm]?js\b'`))
  assert.match(smokeStep, /if \(\$main\.Count -eq 0\) \{/)
  assert.match(smokeStep, /if \(\$dumps\.Count -gt 0\) \{ throw/)
  assert.match(smokeStep, /if \(\$appCrashes\.Count -gt 0\) \{ throw/)
  assert.match(smokeStep, /if \(\$werFaults\.Count -gt 0\) \{ throw/)
  // Stopped by the PIDs it started, whatever happened; a stray survivor or a left install fails.
  assert.match(smokeStep, /\} finally \{\n[^\n]*\n[^\n]*\n\s+foreach \(\$process in \(Get-OrcaUnder \$root\)\) \{ taskkill \/PID \$process\.ProcessId \/T \/F/)
  assert.match(smokeStep, /if \(\$survivors\.Count -gt 0\) \{ throw/)
  assert.match(smokeStep, /if \(Test-Path \$exe\) \{ throw "the uninstaller left/)
  assert.match(smokeStep, /\n\s+exit 0\n/)
  assert.doesNotMatch(smokeStep, /Stop-Process|taskkill \/IM|Get-Process/)
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
