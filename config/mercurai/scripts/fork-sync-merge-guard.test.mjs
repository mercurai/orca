// fork-sync-upstream must not merge an upstream range that touches .github/workflows or
// config/mercurai without the owner: such files run with the fork's secrets once the fork pushes
// them (claude-code-config#1148). The guard decides in merge-guard.sh, git only and no token; the
// workflow runs it before the merge on one pinned upstream commit, the merge step cannot run when it
// refuses, and the merge result is checked again before any push.
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
const GUARD = 'Guard the merge-forward'
const ISSUE = 'Report a guarded upstream range as an issue'
const MERGE = 'Merge main forward into the fork branch'
const SHA_ENV = /^\s+UPSTREAM_SHA: \$\{\{ steps\.fetch\.outputs\.upstream_sha \}\}$/m

test('the guard runs before the merge, with no token, on the one commit the run pinned', () => {
  assert.ok(names.includes(GUARD) && names.indexOf(GUARD) < names.indexOf(MERGE))
  assert.ok(names.indexOf(MERGE) < names.indexOf(ISSUE))
  assert.match(step(GUARD), /bash config\/mercurai\/scripts\/merge-guard\.sh HEAD "\$UPSTREAM_SHA"/)
  assert.doesNotMatch(step(GUARD), /\bsecrets\b|GH_TOKEN|GIT_CONFIG_|\bgit push\b|^\s+gh /m)
  for (const name of [GUARD, MERGE, ISSUE]) {
    assert.match(step(name), SHA_ENV, name)
  }
  for (const name of [GUARD, MERGE]) {
    assert.doesNotMatch(step(name), /upstream\/main/, name)
  }
  assert.match(step(MERGE), /git merge --no-edit "\$UPSTREAM_SHA"/)
})

test('the merge step runs only when the guard did not refuse, and a refusal fails the run after filing', () => {
  assert.match(step(MERGE), /^\s+if: \$\{\{ steps\.guard\.outputs\.refused == 'false' \}\}$/m)
  assert.match(
    step(ISSUE),
    /^\s+if: \$\{\{ steps\.guard\.outputs\.refused == 'true' \|\| steps\.merge\.outputs\.guarded == 'true' \}\}$/m
  )
  assert.ok(step(ISSUE).trimEnd().endsWith('exit 1'))
  assert.match(step(ISSUE), /allow_guarded_merge_sha=%s/)
  assert.match(step(GUARD), /3\) echo "refused=true" >> "\$GITHUB_OUTPUT" ;;/)
  assert.match(step(GUARD), /4\) echo "refused=false" >> "\$GITHUB_OUTPUT"; echo "allowed=true" >> "\$GITHUB_OUTPUT" ;;/)
  assert.match(step(GUARD), /\*\) exit "\$rc" ;;/)
})

test('only an explicit dispatch can allow a guarded merge, and only for a pinned sha', () => {
  assert.match(
    step(GUARD),
    /^\s+ALLOWED_SHA: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.allow_guarded_merge_sha \|\| '' \}\}$/m
  )
  assert.match(code, /^ {6}allow_guarded_merge_sha:\n(?: {8}.+\n)*? {8}type: string\n(?: {8}.+\n)*? {8}default: ''\n/m)
  const uses = code.split('\n').filter((line) => line.includes('inputs.allow_guarded_merge_sha'))
  assert.equal(uses.length, 1, uses.join('\n'))
  assert.doesNotMatch(code, /allow_guarded_merge\b(?!_sha)/)
})

test('the merge result is checked, from a copy, before any push', () => {
  const merge = step(MERGE)
  const copy = merge.indexOf('cp config/mercurai/scripts/merge-result-guard.sh /tmp/merge-result-guard.sh')
  assert.ok(copy !== -1 && copy < merge.indexOf('git merge --no-edit'))
  assert.match(merge, /git merge --no-edit "\$UPSTREAM_SHA" 2>&1 \| tr -d '\\r'/)
  assert.match(merge, /^\s+GUARD_ALLOWED: \$\{\{ steps\.guard\.outputs\.allowed \}\}$/m)
  const check = merge.indexOf('bash /tmp/merge-result-guard.sh "origin/$FORK_BRANCH"')
  assert.ok(check !== -1 && check < merge.indexOf('git push origin'))
  assert.match(merge, /git reset -q --hard "origin\/\$FORK_BRANCH"\n\s+echo "guarded=true" >> "\$GITHUB_OUTPUT"/)
})

test('merge-guard.sh refuses by exit 3 from the merge base, pins the sha, prints a sanitised list', () => {
  const script = read('config', 'mercurai', 'scripts', 'merge-guard.sh')
  assert.match(script, /git merge-base "\$fork" "\$upstream"/)
  assert.match(script, /git diff --name-only --no-renames -z "\$base" "\$upstream"/)
  assert.ok(script.includes("grep -E '^(\\.github/workflows/|config/mercurai/)'"))
  assert.ok(script.includes('[[ "${ALLOWED_SHA:-}" =~ ^[0-9a-f]{40}$ && "$ALLOWED_SHA" = "$sha" ]]'))
  assert.match(script, /^exit 3$/m)
  assert.match(script, /^ {2}exit 4$/m)
  assert.ok(script.includes("LC_ALL=C sed 's|[^A-Za-z0-9._/@+ -]|?|g'"))
  assert.doesNotMatch(script, /\bgit (push|fetch)\b|GH_TOKEN|FORK_BOT_TOKEN/)
})

test('merge-result-guard.sh diffs the result against the branch as pushed and prints a sanitised list', () => {
  const script = read('config', 'mercurai', 'scripts', 'merge-result-guard.sh')
  assert.match(script, /git diff --name-only --no-renames -z "\$1" HEAD -- \.github\/workflows config\/mercurai/)
  assert.ok(script.includes("LC_ALL=C sed 's|[^A-Za-z0-9._/@+ -]|?|g'"))
  assert.match(script, /^exit 3$/m)
})
