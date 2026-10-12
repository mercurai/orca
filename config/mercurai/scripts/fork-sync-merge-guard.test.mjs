// fork-sync-upstream must not merge an upstream range that touches .github/ (workflows and the actions they run) or
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
  // Exit 4 is also sed's I/O error: the arm re-checks the full sha against the pinned commit.
  assert.match(step(GUARD), /4\)\n\s+if \[\[ "\$ALLOWED_SHA" =~ \^\[0-9a-f\]\{40\}\$ && "\$ALLOWED_SHA" = "\$UPSTREAM_SHA" \]\]; then\n/)
  assert.match(step(GUARD), /echo "refused=false" >> "\$GITHUB_OUTPUT"; echo "allowed=true" >> "\$GITHUB_OUTPUT"\n\s+else\n\s+exit 4/)
  assert.match(step(GUARD), /\*\) exit "\$rc" ;;/)
  // The outputs are written before the script's output is printed.
  assert.ok(step(GUARD).indexOf('echo "allowed=false"') < step(GUARD).indexOf('cat /tmp/guarded'))
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

test('the merge runs in merge-forward.sh, from copies, with its outputs defaulted, before any push', () => {
  const merge = step(MERGE)
  const copy = merge.indexOf('cp config/mercurai/scripts/merge-forward.sh config/mercurai/scripts/merge-result-guard.sh /tmp/')
  const defaults = merge.indexOf('{ echo "conflict=false"; echo "guarded=false"; } >> "$GITHUB_OUTPUT"')
  const run = merge.indexOf('bash /tmp/merge-forward.sh')
  assert.ok(copy !== -1 && copy < defaults && defaults < run && run < merge.indexOf('git push origin'))
  assert.doesNotMatch(merge, /git merge\b/)
  assert.match(merge, /^\s+GUARD_ALLOWED: \$\{\{ steps\.guard\.outputs\.allowed \}\}$/m)
  assert.match(merge, /10\) echo "conflict=true" >> "\$GITHUB_OUTPUT"; return 1 ;;/)
  assert.match(merge, /11\) echo "guarded=true" >> "\$GITHUB_OUTPUT"; return 1 ;;/)
  assert.match(merge, /\*\) exit "\$rc" ;;/)
})

test('merge-forward.sh merges the pinned sha, checks the result unless allowed, and resets a refused one', () => {
  const script = read('config', 'mercurai', 'scripts', 'merge-forward.sh')
  assert.ok(script.includes(`git merge --no-edit "$UPSTREAM_SHA" 2>&1 | tr -d '\\r'`))
  assert.ok(script.includes('if [ "${GUARD_ALLOWED:-false}" = true ]; then exit 0; fi'))
  assert.ok(script.includes('bash "$here/merge-result-guard.sh" "$before"'))
  assert.match(script, /git reset -q --hard "\$before"\nexit 11$/m)
  assert.match(script, /git merge --abort\n {2}exit 10$/m)
  assert.doesNotMatch(script, /\bgit (push|fetch)\b|GH_TOKEN|FORK_BOT_TOKEN/)
})

test('merge-guard.sh refuses by exit 3 from the merge base, pins the sha, prints a sanitised list', () => {
  const script = read('config', 'mercurai', 'scripts', 'merge-guard.sh')
  assert.match(script, /git merge-base "\$fork" "\$upstream"/)
  assert.match(script, /git diff --name-only --no-renames -z "\$base" "\$upstream"/)
  assert.ok(script.includes("grep -E '^(\\.github/|config/mercurai/)'"))
  assert.ok(script.includes('[[ "${ALLOWED_SHA:-}" =~ ^[0-9a-f]{40}$ && "$ALLOWED_SHA" = "$sha" ]]'))
  assert.match(script, /^exit 3$/m)
  assert.match(script, /^ {2}exit 4$/m)
  assert.ok(script.includes("LC_ALL=C sed 's|[^A-Za-z0-9._/@+ -]|?|g'"))
  assert.doesNotMatch(script, /\bgit (push|fetch)\b|GH_TOKEN|FORK_BOT_TOKEN/)
})

test('merge-result-guard.sh diffs the result against the branch as pushed and prints a sanitised list', () => {
  const script = read('config', 'mercurai', 'scripts', 'merge-result-guard.sh')
  assert.match(script, /git diff --name-only --no-renames -z "\$1" HEAD -- \.github config\/mercurai/)
  assert.ok(script.includes("LC_ALL=C sed 's|[^A-Za-z0-9._/@+ -]|?|g'"))
  assert.match(script, /^exit 3$/m)
})
