// fork-assemble-release and fork-rebase-patches hold FORK_BOT_TOKEN, which can push this repo's
// workflows and publish to the channel the owner's app updates from. These pin that the token
// never shares a job with the code under test or with a cache (claude-code-config#1125, SEC-201).
// Run with `node --test "config/mercurai/scripts/*.test.mjs"` from the repo root.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

const workflows = resolve(import.meta.dirname, '..', '..', '..', '.github', 'workflows')
const read = (name) => readFileSync(resolve(workflows, name), 'utf8').replaceAll('\r\n', '\n')
const code = (text) =>
  text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')

/** Each job's text, keyed by name: a job starts at a two-space key under `jobs:`. */
function jobsOf(workflow) {
  const body = workflow.slice(workflow.indexOf('\njobs:\n') + '\njobs:\n'.length)
  const jobs = new Map()
  let name = null
  for (const line of body.split('\n')) {
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

const SECRET = /\bsecrets\b|\$\{\{[^}]*\bsecrets\b/
const DEFAULT_REF = "github.ref == format('refs/heads/{0}', github.event.repository.default_branch || 'mercurai')"
const WORKFLOWS = [
  ['fork-assemble-release.yml', `\${{ ${DEFAULT_REF} && !inputs.dry_run }}`],
  ['fork-rebase-patches.yml', `\${{ !cancelled() && inputs.tag != '' && !inputs.dry_run && ${DEFAULT_REF} }}`]
]

for (const [file, pushGate] of WORKFLOWS) {
  const workflow = read(file)
  const jobs = jobsOf(workflow)

  test(`${file}: a token-free test job and a push job, nothing else`, () => {
    const body = workflow.slice(workflow.indexOf('\njobs:\n') + '\njobs:\n'.length)
    const topLevel = body.split('\n').filter((line) => /^ {2}\S/.test(line) && !/^ {2}#/.test(line))
    assert.deepEqual(topLevel, ['  test:', '  push:'])
    assert.doesNotMatch(code(jobs.get('test')), SECRET)
    assert.doesNotMatch(code(workflow.slice(0, workflow.indexOf('\njobs:\n'))), SECRET)
    assert.doesNotMatch(code(workflow), /secrets:\s*inherit/)
  })

  test(`${file}: the default token reads only`, () => {
    assert.match(workflow, /^permissions:\n {2}contents: read\n(?! )/m)
    assert.doesNotMatch(code(workflow), /^[ \t]+permissions:/m)
    assert.doesNotMatch(code(workflow), /:\s*write\b/)
  })

  test(`${file}: the push job opens on the dispatch alone`, () => {
    const gates = jobs.get('push').match(/^ {4}if: .*$/gm)
    assert.deepEqual(gates, [`    if: ${pushGate}`])
  })

  test(`${file}: the push job runs no repository code and no third-party action`, () => {
    const push = code(jobs.get('push'))
    assert.doesNotMatch(push, /\b(pnpm|npm|npx|node|vitest|python3?|curl|wget|eval|source)\b/)
    assert.doesNotMatch(push, /\|\s*(bash|sh)\b|\b(bash|sh)\s+-c\b|^\s*\.\s+\S/m)
    // Only the fork's own scripts, copied from the workflow's checkout before anything moved it.
    for (const [, script] of push.matchAll(/\bbash\s+(\S+)/g)) {
      assert.match(script, /^(config\/mercurai\/scripts|\/tmp\/fork-scripts|\/tmp)\/[\w-]+\.sh$/, script)
    }
    assert.doesNotMatch(push, /^\s+shell:/m)
    const uses = [...push.matchAll(/^\s+(?:- )?uses: (.+)$/gm)].map((match) => match[1])
    assert.deepEqual(uses, ['actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0'])
  })

  test(`${file}: the token reaches only the steps that write, never git's config`, () => {
    for (const [name, text] of jobs) {
      for (const step of code(text).split(/^ {6}- /m)) {
        assert.doesNotMatch(step, /^\s+token:/m, `${name} checks out with a token`)
        if (/uses: actions\/checkout@/.test(step)) {
          assert.match(step, /persist-credentials: false/, `${name} persists checkout credentials`)
        }
        if (SECRET.test(step)) {
          assert.equal(name, 'push')
          // A named step, and the secret only as GH_TOKEN or the presence check.
          assert.match(step, /^name: /)
          const refs = step.match(/^\s+[A-Z_]+: \$\{\{ secrets\.[^\n]*$/gm)
          for (const ref of refs) {
            assert.match(ref.trim(), /^(GH_TOKEN: \$\{\{ secrets\.FORK_BOT_TOKEN \}\}|HAS_TOKEN: \$\{\{ secrets\.FORK_BOT_TOKEN != '' \}\})$/)
          }
        }
      }
    }
    assert.doesNotMatch(code(workflow), /git config[^\n]*extraheader|git remote set-url[^\n]*@/)
  })

  test(`${file}: nothing restores or saves a cache, and every action is pinned`, () => {
    const body = code(workflow)
    assert.doesNotMatch(body, /actions\/cache\b|uses:\s*\.\//)
    assert.doesNotMatch(body, /^\s+cache[\w-]*:/m)
    for (const step of body.split(/^ {6}- /m).filter((s) => /uses: actions\/setup-node@/.test(s))) {
      assert.match(step, /package-manager-cache: false/)
    }
    for (const [, action] of body.matchAll(/^\s+(?:- )?uses: (\S+)/gm)) {
      assert.match(action, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, action)
    }
  })
}

test('the push jobs push only what they derived and matched against what was tested', () => {
  const assemble = jobsOf(read('fork-assemble-release.yml')).get('push')
  assert.match(assemble, /bash \/tmp\/fork-scripts\/assemble-release\.sh\n/)
  assert.match(assemble, /if \[ "\$tree" != "\$TESTED_TREE" \] \|\| \[ "\$branch" != "\$TESTED_BRANCH" \]; then\n[^\n]*\n\s+exit 1\n/)
  const rebase = jobsOf(read('fork-rebase-patches.yml')).get('push')
  assert.match(rebase, /bash \/tmp\/fork-scripts\/rebase-series\.sh\n/)
  assert.match(rebase, /if ! grep -qxF "\$branch \$tree \$before" <<<"\$TESTED_TREES"; then\n[^\n]*\n\s+failed=1\n/)
  assert.match(rebase, /if \[ "\$TEST_RESULT" != success \] \|\| \[ "\$TEST_FAILED" != 0 \] \|\| \[ -s \/tmp\/conflicted \]; then failed=1; fi/)
  assert.match(rebase, /if: \$\{\{ steps\.patches\.outputs\.count != '0' && steps\.rebase\.outputs\.failed == '0' \}\}\n/)
  // A merged-upstream verdict is compared too: dropping a patch needs the tested run's agreement.
  assert.match(rebase, /grep -qxF "\$branch" \/tmp\/merged \|\| tree=\$\(git rev-parse "\$after\^\{tree\}"\)/)
  const test_ = jobsOf(read('fork-rebase-patches.yml')).get('test')
  assert.match(test_, /echo "\$branch merged \$before" >> \/tmp\/trees/)
  // The lease is tied to what was tested: the branch's pre-rebase sha is part of the compared line (claude-code-config#1123).
  assert.match(test_, /echo "\$branch \$\(git rev-parse 'HEAD\^\{tree\}'\) \$before" >> \/tmp\/trees/)
  assert.match(rebase, /while read -r branch before after; do\n/)
})

test('every script that feeds a force push checks the branch prefix first (SEC S7)', () => {
  const dir = (name) => readFileSync(resolve(import.meta.dirname, name), 'utf8')
  const prefix = String.raw`^patch/[A-Za-z0-9._-]+$`
  const variables = { 'rebase-series.sh': 'branch', 'push-rebased-series.sh': 'branch', 'assemble-release.sh': 'patch' }
  for (const [name, variable] of Object.entries(variables)) {
    assert.ok(dir(name).includes(`[[ "$${variable}" =~ ${prefix} && `), name)
  }
  assert.ok(dir('assemble-release.sh').includes(String.raw`^release/[A-Za-z0-9._-]+$`))
})

test('assemble-release strips CR from the git output it prints', () => {
  const assemble = readFileSync(resolve(import.meta.dirname, 'assemble-release.sh'), 'utf8')
  assert.ok(assemble.includes(String.raw`"refs/tags/$TAG..HEAD" | tr -d '\r'`))
  assert.ok(assemble.includes(String.raw`"refs/tags/$TAG..origin/$patch" 2>&1 | tr -d '\r' ||`))
})

test('rebase-series strips CR from the git rebase output it prints', () => {
  const rebase = readFileSync(resolve(import.meta.dirname, 'rebase-series.sh'), 'utf8')
  assert.ok(rebase.includes(String.raw`elif ! git rebase --onto "$BASE" "$old" </dev/null 2>&1 | tr -d '\r'; then`))
})

test('the rebase reads the target tag from the fork, never from upstream', () => {
  const fetch = readFileSync(resolve(import.meta.dirname, 'fetch-rebase-inputs.sh'), 'utf8')
  assert.doesNotMatch(fetch, /fetch[^\n]*upstream[^\n]*--tags/)
  assert.ok(fetch.includes('git fetch --no-tags origin "+refs/tags/$TARGET:refs/tags/$TARGET"'))
})

test('a step holding the token never builds a yq expression from shell values', () => {
  for (const [file] of WORKFLOWS) {
    const push = code(jobsOf(read(file)).get('push'))
    for (const line of push.split('\n').filter((l) => /\byq\b/.test(l))) {
      // The expression is single-quoted; values come in through strenv().
      assert.match(line, /\byq(?:\s+-[a-z]+)*\s+'/, `${file}: ${line.trim()}`)
    }
  }
  // The manifest edits of the token step live in record-series.sh: same rule.
  const record = readFileSync(resolve(import.meta.dirname, 'record-series.sh'), 'utf8')
  const yqLines = record.split('\n').filter((l) => /\byq\b/.test(l) && !/^\s*#/.test(l))
  assert.ok(yqLines.length >= 3)
  for (const line of yqLines) {
    assert.match(line, /\byq(?:\s+-[a-z]+)*\s+'/, line.trim())
  }
  // The tag that reaches the manifest is a release or release-candidate name.
  const fetch = readFileSync(resolve(import.meta.dirname, 'fetch-rebase-inputs.sh'), 'utf8')
  assert.ok(fetch.includes(String.raw`if [[ ! "$TARGET" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]]; then`))
})

// claude-code-config#1123: a dry run from the default branch and hand-ported heads.
test('fork-rebase-patches: dry_run keeps the push job shut and reports from the token-free test job', () => {
  const workflow = read('fork-rebase-patches.yml')
  assert.match(workflow, /^ {6}dry_run:\n(?: {8}.*\n)*? {8}type: boolean\n {8}default: false\n/m)
  const jobs = jobsOf(workflow)
  assert.match(jobs.get('test'), /- name: Report the dry run\n {8}if: \$\{\{ inputs\.dry_run && inputs\.tag != '' && /)
  assert.match(jobs.get('test'), /bash \/tmp\/fork-scripts\/record-series\.sh\n/)
  // The test job's own failure gate treats a dry run as report-only even from the default branch.
  assert.match(jobs.get('test'), /!\(inputs\.tag != '' && !inputs\.dry_run && github\.ref == /)
})

test('overrides reach the scripts as an env value only, and are checked strictly', () => {
  for (const file of ['fork-rebase-patches.yml', 'fork-assemble-release.yml']) {
    const text = code(read(file))
    const uses = text.split('\n').filter((line) => line.includes('inputs.overrides'))
    for (const line of uses) {
      assert.match(line.trim(), /^(OVERRIDES: \$\{\{ inputs\.overrides \}\}|if: \$\{\{ inputs\.overrides != '' && .*\}\})$/, `${file}: ${line.trim()}`)
    }
    assert.ok(uses.some((line) => line.includes('OVERRIDES: ')), file)
  }
  // Release assembly takes overrides on a dry run only: the guard runs before anything is assembled.
  const assemble = jobsOf(read('fork-assemble-release.yml'))
  assert.match(assemble.get('test'), /- name: Overrides are for a dry run only\n {8}if: \$\{\{ inputs\.overrides != '' && github\.ref == [^\n]*&& !inputs\.dry_run \}\}\n/)
  assert.doesNotMatch(code(assemble.get('push')), /OVERRIDES/)
  const parse = readFileSync(resolve(import.meta.dirname, 'parse-overrides.sh'), 'utf8')
  assert.ok(parse.includes(String.raw`^(patch/[A-Za-z0-9._/-]+)=([0-9a-f]{40})$`))
  assert.ok(parse.includes('grep -qxF "$_branch" /tmp/active'))
  assert.ok(parse.includes('is not on an origin patch/* or ci-only/* branch'))
  assert.ok(parse.includes('does not contain $2'))
  assert.ok(parse.includes('has no commits beyond $2'))
  // The raw input is never echoed to the log (a carriage return would reach the runner as a command).
  assert.doesNotMatch(parse, /echo "[^"]*\$_pair/)
  // Nor may a commit subject: every git log/diff line it prints drops carriage returns.
  const printed = parse.split('\n').filter((l) => /^\s*git (log|diff)\b/.test(l))
  assert.equal(printed.length, 2)
  for (const line of printed) {
    assert.match(line, /\| tr -d '\\r'$/, line)
  }
})
