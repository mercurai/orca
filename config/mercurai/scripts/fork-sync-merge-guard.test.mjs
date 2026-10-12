// fork-sync-upstream must not merge an upstream range that touches .github/workflows or
// config/mercurai without the owner: such files run with the fork's secrets once the fork pushes
// them (claude-code-config#1148). The guard decides in merge-guard.sh, git only and no token; the
// workflow runs it before the merge, and the merge step cannot run when it refuses.
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

test('the guard runs the script on the fork branch and upstream/main, before the merge, with no token', () => {
  assert.ok(names.indexOf(GUARD) !== -1 && names.indexOf(GUARD) < names.indexOf(ISSUE))
  assert.ok(names.indexOf(ISSUE) < names.indexOf(MERGE))
  assert.match(step(GUARD), /bash config\/mercurai\/scripts\/merge-guard\.sh HEAD upstream\/main/)
  assert.doesNotMatch(step(GUARD), /\bsecrets\b|GH_TOKEN|GIT_CONFIG_|\bgit push\b|^\s+gh /m)
})

test('the merge step runs only when the guard did not refuse, and a refusal fails the run after filing', () => {
  assert.match(step(MERGE), /^\s+if: \$\{\{ steps\.guard\.outputs\.refused == 'false' \}\}$/m)
  assert.match(step(ISSUE), /^\s+if: \$\{\{ steps\.guard\.outputs\.refused == 'true' \}\}$/m)
  assert.ok(step(ISSUE).trimEnd().endsWith('exit 1'))
  assert.match(step(GUARD), /3\) echo "refused=true" >> "\$GITHUB_OUTPUT" ;;/)
  assert.match(step(GUARD), /\*\) exit "\$rc" ;;/)
})

test('only an explicit dispatch can allow a guarded merge, and the input defaults to off', () => {
  assert.match(
    step(GUARD),
    /^\s+ALLOW_GUARDED_MERGE: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.allow_guarded_merge == true && 'true' \|\| 'false' \}\}$/m
  )
  assert.match(code, /^ {6}allow_guarded_merge:\n(?: {8}.+\n)*? {8}default: false\n/m)
  const uses = code.split('\n').filter((line) => line.includes('inputs.allow_guarded_merge'))
  assert.equal(uses.length, 1, uses.join('\n'))
})

test('the script refuses by exit 3 on the guarded paths, from the merge base, with renames split', () => {
  const script = read('config', 'mercurai', 'scripts', 'merge-guard.sh')
  assert.match(script, /git merge-base "\$fork" "\$upstream"/)
  assert.match(script, /git diff --name-only --no-renames -z "\$base" "\$upstream"/)
  assert.ok(script.includes("grep -E '^(\\.github/workflows/|config/mercurai/)'"))
  assert.match(script, /^exit 3$/m)
  assert.doesNotMatch(script, /\bgit (push|fetch)\b|GH_TOKEN|FORK_BOT_TOKEN/)
})
