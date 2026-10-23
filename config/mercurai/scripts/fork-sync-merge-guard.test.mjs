// fork-sync-upstream must push nothing, and merge nothing, from an upstream range that touches .github/
// (workflows and the actions they run) or config/mercurai without the owner: a pushed workflow file is active
// at once and runs with the fork's secrets (claude-code-config#1148).
//
// These tests pin STRUCTURE only: step order, `if:` gates, env wiring, which steps hold a token, what runs from
// a copy, and what a script is not allowed to do (push, hold a token). Anything the sync PRODUCES (issue titles
// and bodies, summary lists, ::error:: and ::warning:: lines, step outputs, pushed refs) is asserted on what the
// script printed or wrote, in the harness: `bash config/mercurai/scripts/test-fork-series-scripts.sh`.
// Run with `node --test "config/mercurai/scripts/*.test.mjs"` from the repo root.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..', '..', '..')
const read = (...parts) => readFileSync(resolve(root, ...parts), 'utf8').replaceAll('\r\n', '\n')
const code = read('.github', 'workflows', 'fork-sync-upstream.yml')
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')
const names = []
const steps = code.slice(code.indexOf('\njobs:\n')).split(/^ {6}- /m).slice(1)
for (const text of steps) {
  names.push(/^name: (.+)$/m.exec(text)?.[1])
}
const step = (name) => steps[names.indexOf(name)]
const FETCH = 'Fetch upstream main and tags'
const GUARD = 'Guard every push and the merge-forward'
const MAIN = 'Mirror main (fast-forward only)'
const TAGS = 'Mirror new tags'
const DISPATCH = 'Hand the newest release tag to fork-rebase-patches'
const BRANCHES = 'Mirror upstream branches under upstream/*'
const MERGE = 'Merge main forward into the fork branch'
const ISSUE = 'Report a guarded upstream range as an issue'
const CONFLICT = 'Report a merge conflict as an issue'
const ALLOWED_TAG = 'Mirror the owner-allowed tag'
const ALLOWED_DISPATCH = 'Hand the owner-allowed tag to fork-rebase-patches'
const SKIPPED_ISSUES = 'Open review issues for skipped release tags'
const SHA_ENV = /^\s+UPSTREAM_SHA: \$\{\{ steps\.fetch\.outputs\.upstream_sha \}\}$/m
const GATE = /steps\.guard\.outputs\.refused == 'false'/
const LAST_STEPS_GATE = "!cancelled() && steps.fetch.outcome == 'success' && steps.mode.outputs.push == 'true'"

test('the pin is made once, in the fetch step, and the guard runs before every push', () => {
  assert.match(step(FETCH), /upstream_sha=\$\(bash config\/mercurai\/scripts\/pin-upstream-sha\.sh upstream\/main\)/)
  assert.match(step(FETCH), /echo "upstream_sha=\$upstream_sha" >> "\$GITHUB_OUTPUT"/)
  const order = [FETCH, GUARD, MAIN, TAGS, DISPATCH, BRANCHES, MERGE, ISSUE, CONFLICT, ALLOWED_TAG, ALLOWED_DISPATCH, SKIPPED_ISSUES].map(
    (name) => names.indexOf(name)
  )
  assert.ok(!order.includes(-1))
  assert.deepEqual(order, [...order].sort((a, b) => a - b))
  assert.equal(names.at(-1), SKIPPED_ISSUES)
  assert.match(step(GUARD), /^\s+run: bash config\/mercurai\/scripts\/guard-step\.sh$/m)
  assert.doesNotMatch(step(GUARD), /\bsecrets\b|GH_TOKEN|GIT_CONFIG_|\bgit push\b|^\s+gh /m)
  for (const name of [GUARD, MAIN, TAGS, BRANCHES, MERGE, ISSUE, CONFLICT, SKIPPED_ISSUES]) {
    assert.match(step(name), SHA_ENV, name)
  }
  for (const name of [GUARD, MAIN, TAGS, BRANCHES, MERGE]) {
    assert.doesNotMatch(step(name), /upstream\/main/, name)
  }
  assert.doesNotMatch(code, /refs\/remotes\/upstream\/main:refs\/heads\/main/)
})

test('every step that pushes or dispatches comes after the guard and is gated on its outcome', () => {
  const guard = names.indexOf(GUARD)
  const pushes = steps.filter((text) => /sync-push\.sh|\bgit push\b|gh workflow run/.test(text))
  assert.deepEqual(
    pushes.map((text) => /^name: (.+)$/m.exec(text)[1]),
    [MAIN, TAGS, DISPATCH, BRANCHES, MERGE, ALLOWED_DISPATCH]
  )
  for (const text of pushes) {
    const name = /^name: (.+)$/m.exec(text)[1]
    assert.ok(names.indexOf(name) > guard, name)
    // The owner-allowed pair is its own approval, not part of the main range (see the allow_tag test).
    if (name === ALLOWED_DISPATCH) {
      continue
    }
    assert.match(/^\s+if: (.*)$/m.exec(text)?.[1] ?? '', GATE, name)
    if (/sync-push\.sh/.test(text)) {
      assert.match(text, /^\s+GUARD_REFUSED: \$\{\{ steps\.guard\.outputs\.refused \}\}$/m, name)
    }
  }
  assert.match(step(MAIN), /bash config\/mercurai\/scripts\/sync-push\.sh main$/m)
  assert.match(step(TAGS), /bash config\/mercurai\/scripts\/sync-push\.sh tags$/m)
  assert.match(step(BRANCHES), /bash config\/mercurai\/scripts\/sync-push\.sh branches$/m)
})

test('only a tag mirrored this run is handed to the rebase', () => {
  assert.match(step(DISPATCH), /steps\.tags\.outputs\.rebase_tag != ''/)
  assert.doesNotMatch(code, /steps\.fetch\.outputs\.rebase_tag/)
})

test('the merge step runs only when the guard did not refuse; the issue steps fire on the outputs and fail the run', () => {
  assert.match(step(MERGE), /^\s+if: \$\{\{ steps\.guard\.outputs\.refused == 'false' \}\}$/m)
  assert.match(
    step(ISSUE),
    /^\s+if: \$\{\{ steps\.guard\.outputs\.refused == 'true' \|\| steps\.merge\.outputs\.guarded == 'true' \}\}$/m
  )
  assert.match(step(CONFLICT), /^\s+if: \$\{\{ steps\.merge\.outputs\.conflict == 'true' \}\}$/m)
  // The stage picks the text (a refusal pushed nothing; a reset merge came after the mirrors); the scripts run from /tmp.
  assert.match(step(ISSUE), /^\s+STAGE: \$\{\{ steps\.guard\.outputs\.refused == 'true' && 'guard' \|\| 'merge' \}\}$/m)
  assert.match(step(ISSUE), /^\s+run: bash \/tmp\/report-sync-issue\.sh "\$STAGE"$/m)
  assert.match(step(CONFLICT), /^\s+run: bash \/tmp\/report-sync-issue\.sh conflict$/m)
  for (const name of [ISSUE, CONFLICT]) {
    assert.match(step(name), /^\s+PUSH: \$\{\{ steps\.mode\.outputs\.push \}\}$/m, name)
  }
})

test('only an explicit dispatch can allow a guarded range, and only for a pinned sha', () => {
  assert.match(
    code,
    /^ {2}ALLOWED_SHA: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.allow_guarded_merge_sha \|\| '' \}\}$/m
  )
  assert.ok(code.indexOf('  ALLOWED_SHA:') < code.indexOf('\njobs:\n'))
  assert.match(code, /^ {6}allow_guarded_merge_sha:\n(?: {8}.+\n)*? {8}type: string\n(?: {8}.+\n)*? {8}default: ''\n/m)
  const uses = code.split('\n').filter((line) => line.includes('inputs.allow_guarded_merge_sha'))
  assert.equal(uses.length, 1, uses.join('\n'))
  assert.doesNotMatch(code, /allow_guarded_merge\b(?!_sha)/)
})

test('the merge runs from copies, before it is pushed, with one push per attempt', () => {
  const merge = step(MERGE)
  const copy = merge.indexOf('cp config/mercurai/scripts/merge-forward.sh config/mercurai/scripts/merge-result-guard.sh /tmp/')
  const run = merge.indexOf('bash /tmp/merge-forward.sh')
  assert.ok(copy !== -1 && copy < run && run < merge.indexOf('git push origin'))
  // The only push follows a successful try_merge in the same loop turn.
  assert.equal(merge.split('git push').length - 1, 1)
  assert.ok(merge.includes('try_merge || exit 0\n            if git push origin "$FORK_BRANCH"; then break; fi\n'))
  assert.doesNotMatch(merge, /git merge\b/)
  assert.match(merge, /^\s+GUARD_ALLOWED: \$\{\{ steps\.guard\.outputs\.allowed \}\}$/m)
  assert.match(merge, /10 \| 11\) return 1 ;;/)
  assert.match(merge, /\*\) exit "\$rc" ;;/)
  assert.match(read('config', 'mercurai', 'scripts', 'merge-forward.sh'), /merge-result-guard\.sh" "\$before" "\$UPSTREAM_SHA"/)
})

test('privileged sync runs only from the protected default branch', () => {
  assert.match(code, /^  mirror:\n    if: \$\{\{ github\.ref_name == github\.event\.repository\.default_branch \}\}$/m)
  assert.match(code, /^    environment:\n      name: mercurai-sync$/m)
})

test('the scripts the steps run after the merge are copied in the fetch step, before it could change them', () => {
  const copies =
    'cp config/mercurai/scripts/tag-issues.sh config/mercurai/scripts/list-skipped-tags.sh config/mercurai/scripts/render-tag-review.sh \\\n' +
    '            config/mercurai/scripts/report-sync-issue.sh config/mercurai/scripts/mirror-allowed-tag.sh /tmp/'
  assert.ok(step(FETCH).includes(copies))
  assert.match(step(SKIPPED_ISSUES), /^\s+run: bash \/tmp\/tag-issues\.sh$/m)
  assert.match(step(ALLOWED_TAG), /^\s+bash \/tmp\/mirror-allowed-tag\.sh$/m)
})

test('the owner-allowed tag comes last, ungated by the main-range guard, and fails nothing before it', () => {
  const tag = step(ALLOWED_TAG)
  assert.match(
    code,
    /^ {2}ALLOW_TAG: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.allow_tag \|\| '' \}\}$/m
  )
  assert.ok(code.indexOf('  ALLOW_TAG:') < code.indexOf('\njobs:\n'))
  assert.match(code, /^ {6}allow_tag:\n(?: {8}.+\n)*? {8}type: string\n(?: {8}.+\n)*? {8}default: ''\n/m)
  assert.equal(code.split('\n').filter((line) => line.includes('inputs.allow_tag')).length, 1)
  assert.ok(tag.includes(`if: \${{ ${LAST_STEPS_GATE} && env.ALLOW_TAG != '' }}`))
  assert.ok(step(ALLOWED_DISPATCH).includes(`if: \${{ ${LAST_STEPS_GATE} && steps.allowtag.outputs.tag != '' }}`))
  assert.doesNotMatch(tag, /steps\.guard/)
  // After every push, the merge and the issues, so a failure here cannot skip them; before the tag issues.
  assert.ok(names.indexOf(ALLOWED_TAG) > names.indexOf(CONFLICT))
  assert.ok(names.indexOf(ALLOWED_DISPATCH) === names.indexOf(ALLOWED_TAG) + 1)
  assert.match(step(ALLOWED_DISPATCH), /-f "tag=\$tag" -f "tag_sha=\$sha"/)
})

test('the owner-allowed tag sees what the automatic hand-off dispatched, recorded only after it dispatched', () => {
  const dispatch = step(DISPATCH)
  assert.match(dispatch, /^\s+id: dispatch$/m)
  const run = dispatch.indexOf('gh workflow run fork-rebase-patches.yml')
  const record = dispatch.indexOf('{ echo "dispatched_tag=$tag"; echo "dispatched_sha=$tag_sha"; } >> "$GITHUB_OUTPUT"')
  assert.ok(run !== -1 && record > run)
  assert.match(dispatch, /^\s+set -euo pipefail$/m)
  assert.match(step(ALLOWED_TAG), /^\s+DISPATCHED_TAG: \$\{\{ steps\.dispatch\.outputs\.dispatched_tag \}\}$/m)
  assert.match(step(ALLOWED_TAG), /^\s+DISPATCHED_SHA: \$\{\{ steps\.dispatch\.outputs\.dispatched_sha \}\}$/m)
})

test('the tag issues are the last step, run after a failure, and see the main mirror and the guard', () => {
  const issues = step(SKIPPED_ISSUES)
  assert.match(
    issues,
    /^\s+if: \$\{\{ !cancelled\(\) && steps\.fetch\.outcome == 'success' && steps\.mode\.outputs\.push == 'true' \}\}$/m
  )
  assert.match(issues, /^\s+GUARD_REFUSED: \$\{\{ steps\.guard\.outputs\.refused \}\}$/m)
  assert.match(issues, /^\s+MAIN_MIRRORED: \$\{\{ steps\.mainmirror\.outcome \}\}$/m)
  assert.match(issues, /^\s+FORK_MAIN: \$\{\{ steps\.fetch\.outputs\.fork_main \}\}$/m)
  assert.match(step(MAIN), /^\s+id: mainmirror$/m)
})

test('the scripts that only decide or print never push, fetch or hold a token', () => {
  for (const name of [
    'merge-guard.sh',
    'merge-result-guard.sh',
    'merge-forward.sh',
    'guard-step.sh',
    'pin-upstream-sha.sh',
    'list-new-tags.sh',
    'list-skipped-tags.sh',
    'render-tag-review.sh',
    'report-sync-issue.sh',
    'tag-issues.sh'
  ]) {
    const script = read('config', 'mercurai', 'scripts', name)
    assert.doesNotMatch(script, /\bgit (push|fetch)\b|GH_TOKEN|secrets\.[A-Z]/, name)
  }
})

test('no sync issue lookup is limited to a first page', () => {
  assert.doesNotMatch(code, /gh issue list|--search|--limit/)
  for (const name of ['report-sync-issue.sh', 'tag-issues.sh']) {
    const script = read('config', 'mercurai', 'scripts', name)
    assert.doesNotMatch(script, /gh issue list|--search|--limit/, name)
    assert.ok(script.includes('--paginate'), name)
  }
})

test('the pushing scripts push only what they are for, never forced, and hold no token', () => {
  const push = read('config', 'mercurai', 'scripts', 'sync-push.sh')
  assert.equal(push.split('git push').length - 1, 3)
  assert.doesNotMatch(push, /--force|--tags|--mirror|GH_TOKEN|refs\/remotes\/upstream\/main/)
  const allowed = read('config', 'mercurai', 'scripts', 'mirror-allowed-tag.sh')
  assert.equal(allowed.split('git push').length - 1, 1)
  assert.doesNotMatch(allowed, /--force|--tags|--mirror|GH_TOKEN|git push .*\+/)
})
