// fork-sync-upstream must push nothing, and merge nothing, from an upstream range that touches .github/
// (workflows and the actions they run) or config/mercurai without the owner: a pushed workflow file is active
// at once and runs with the fork's secrets (claude-code-config#1148). The guard decides in merge-guard.sh, git
// only and no token, before any push, on one pinned upstream commit; every push goes through sync-push.sh and
// is gated on the guard; the merge result is checked again before it is pushed.
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
const ALLOWED_TAG = 'Mirror the owner-allowed tag'
const ALLOWED_DISPATCH = 'Hand the owner-allowed tag to fork-rebase-patches'
const SKIPPED_ISSUES = 'Open review issues for skipped release tags'
const BRANCHES = 'Mirror upstream branches under upstream/*'
const MERGE = 'Merge main forward into the fork branch'
const ISSUE = 'Report a guarded upstream range as an issue'
const CONFLICT = 'Report a merge conflict as an issue'
const SHA_ENV = /^\s+UPSTREAM_SHA: \$\{\{ steps\.fetch\.outputs\.upstream_sha \}\}$/m
const GATE = /steps\.guard\.outputs\.refused == 'false'/

test('the pin is made once, in the fetch step, and the guard runs before every push', () => {
  assert.match(step(FETCH), /upstream_sha=\$\(bash config\/mercurai\/scripts\/pin-upstream-sha\.sh upstream\/main\)/)
  assert.match(step(FETCH), /echo "upstream_sha=\$upstream_sha" >> "\$GITHUB_OUTPUT"/)
  const order = [FETCH, GUARD, MAIN, TAGS, DISPATCH, BRANCHES, MERGE, ISSUE, CONFLICT].map((name) => names.indexOf(name))
  assert.deepEqual(order, [...order].sort((a, b) => a - b))
  assert.ok(!order.includes(-1))
  assert.match(step(GUARD), /bash config\/mercurai\/scripts\/merge-guard\.sh HEAD "\$UPSTREAM_SHA" origin\/main > \/tmp\/guarded/)
  assert.doesNotMatch(step(GUARD), /\bsecrets\b|GH_TOKEN|GIT_CONFIG_|\bgit push\b|^\s+gh /m)
  for (const name of [GUARD, MAIN, TAGS, BRANCHES, MERGE, ISSUE]) {
    assert.match(step(name), SHA_ENV, name)
  }
  for (const name of [GUARD, MAIN, TAGS, BRANCHES, MERGE]) {
    assert.doesNotMatch(step(name), /upstream\/main/, name)
  }
})

test('every step that pushes or dispatches comes after the guard and is gated on its outcome', () => {
  const guard = names.indexOf(GUARD)
  const pushes = steps.filter((text) => /sync-push\.sh|\bgit push\b|gh workflow run/.test(text))
  assert.deepEqual(pushes.map((text) => /^name: (.+)$/m.exec(text)[1]), [
    MAIN,
    TAGS,
    ALLOWED_DISPATCH,
    DISPATCH,
    BRANCHES,
    MERGE
  ])
  for (const text of pushes) {
    const name = /^name: (.+)$/m.exec(text)[1]
    assert.ok(names.indexOf(name) > guard, name)
    // The owner-allowed tag is its own approval, not part of the main range (see the allow_tag test).
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
  assert.doesNotMatch(code, /refs\/remotes\/upstream\/main:refs\/heads\/main/)
})

test('only a tag mirrored this run is handed to the rebase', () => {
  assert.match(step(TAGS), /echo "rebase_tag=\$\(cat \/tmp\/rebase-tag\)" >> "\$GITHUB_OUTPUT"/)
  assert.match(step(DISPATCH), /steps\.tags\.outputs\.rebase_tag != ''/)
  assert.doesNotMatch(code, /steps\.fetch\.outputs\.rebase_tag/)
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

test('a guard refusal and a merge conflict each have their own issue title and lookup', () => {
  assert.match(step(ISSUE), /title="fork-sync guard: /)
  assert.ok(step(ISSUE).includes(`select(.title | startswith("fork-sync guard:"))`))
  assert.match(step(CONFLICT), /title="fork-sync: /)
  assert.ok(step(CONFLICT).includes(`select(.title | startswith("fork-sync: "))`))
  assert.doesNotMatch(code, /--search/)
  assert.match(step(CONFLICT), /\$\(cat \/tmp\/sync-conflicts\)/)
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

test('the merge runs in merge-forward.sh, from copies, with its outputs defaulted, before it is pushed', () => {
  const merge = step(MERGE)
  const copy = merge.indexOf('cp config/mercurai/scripts/merge-forward.sh config/mercurai/scripts/merge-result-guard.sh /tmp/')
  const defaults = merge.indexOf('{ echo "conflict=false"; echo "guarded=false"; } >> "$GITHUB_OUTPUT"')
  const run = merge.indexOf('bash /tmp/merge-forward.sh')
  assert.ok(copy !== -1 && copy < defaults && defaults < run && run < merge.indexOf('git push origin'))
  // The only push follows a successful try_merge in the same loop turn.
  assert.equal(merge.split('git push').length - 1, 1)
  assert.ok(merge.includes('try_merge || exit 0\n            if git push origin "$FORK_BRANCH"; then break; fi\n'))
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
  // Reset first, whatever the check returned; only then the exit status.
  assert.match(script, /git reset -q --hard "\$before"\nif \[ "\$rc" -ne 3 \]; then exit "\$rc"; fi\nexit 11$/m)
  // Aborted before the list is written; the list has its own file name (rebase-series keeps a conflicts/ directory).
  assert.ok(script.includes(`git merge --abort\n  head -50 <<<"$files" | LC_ALL=C sed 's|[^A-Za-z0-9._/@+ -]|?|g' > "$state/sync-conflicts"\n  exit 10\n`))
  assert.doesNotMatch(script, /\bgit (push|fetch)\b|GH_TOKEN|FORK_BOT_TOKEN/)
})

test('merge-guard.sh refuses by exit 3 on the union of the ranges, pins the sha, prints a sanitised list', () => {
  const script = read('config', 'mercurai', 'scripts', 'merge-guard.sh')
  assert.match(script, /for ref in "\$fork" "\$@"; do/)
  assert.match(script, /base=\$\(git merge-base "\$ref" "\$upstream"\) \|\| exit 1/)
  assert.match(script, /git diff --name-only --no-renames -z "\$base" "\$upstream"/)
  assert.ok(script.includes("grep -E '^(\\.github/|config/mercurai/)'"))
  assert.ok(script.includes('[[ "${ALLOWED_SHA:-}" =~ ^[0-9a-f]{40}$ && "$ALLOWED_SHA" = "$sha" ]]'))
  assert.match(script, /^exit 3$/m)
  assert.match(script, /^ {2}exit 4$/m)
  // A here-string, not printf piped to head: a list over the pipe buffer would exit 141 under pipefail.
  assert.ok(script.includes(`head -50 <<<"$paths" | LC_ALL=C sed 's|[^A-Za-z0-9._/@+ -]|?|g'`))
  assert.doesNotMatch(script, /\bgit (push|fetch)\b|GH_TOKEN|FORK_BOT_TOKEN/)
})

test('merge-result-guard.sh diffs the result against the branch as pushed and prints a sanitised list', () => {
  const script = read('config', 'mercurai', 'scripts', 'merge-result-guard.sh')
  assert.match(script, /git diff --name-only --no-renames -z "\$1" HEAD -- \.github config\/mercurai/)
  assert.ok(script.includes(`head -50 <<<"$paths" | LC_ALL=C sed 's|[^A-Za-z0-9._/@+ -]|?|g'`))
  assert.match(script, /^exit 3$/m)
})

test('sync-push.sh pushes nothing unless the guard said false, and only refs inside the pinned commit', () => {
  const script = read('config', 'mercurai', 'scripts', 'sync-push.sh')
  const gate = script.indexOf('if [ "${GUARD_REFUSED:-true}" != false ]; then')
  assert.ok(gate !== -1 && gate < script.indexOf('git push'))
  assert.match(script, /if \[ "\$\{GUARD_REFUSED:-true\}" != false \]; then\n.*\n {2}exit 3\nfi/)
  assert.ok(script.includes('git push origin "$UPSTREAM_SHA:refs/heads/main"'))
  assert.ok(script.includes('if eligible "refs/upstream-tags/$tag^{commit}"; then'))
  assert.ok(script.includes('if eligible "$sha"; then refspecs+=("$sha:refs/heads/upstream/$name")'))
  // Inside the pin AND the same guarded paths as the pin: the guard only compares the range's endpoints.
  assert.ok(
    script.includes(
      'git merge-base --is-ancestor "$1" "$UPSTREAM_SHA" && git diff --quiet "$UPSTREAM_SHA" "$1" -- .github config/mercurai'
    )
  )
  assert.doesNotMatch(script, /refs\/remotes\/upstream\/main|GH_TOKEN|FORK_BOT_TOKEN|--force|--tags|--mirror/)
})

test('pin-upstream-sha.sh takes the owner sha only when it is a full sha inside the upstream tip', () => {
  const script = read('config', 'mercurai', 'scripts', 'pin-upstream-sha.sh')
  assert.ok(
    script.includes(
      'if [[ "$allowed" =~ ^[0-9a-f]{40}$ ]] && git cat-file -e "$allowed^{commit}" 2>/dev/null && git merge-base --is-ancestor "$allowed" "$tip"; then'
    )
  )
})

test('only an explicit dispatch can approve a release tag, and only that tag is mirrored and handed on', () => {
  assert.match(
    code,
    /^ {2}ALLOW_TAG: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.allow_tag \|\| '' \}\}$/m
  )
  assert.ok(code.indexOf('  ALLOW_TAG:') < code.indexOf('\njobs:\n'))
  assert.match(code, /^ {6}allow_tag:\n(?: {8}.+\n)*? {8}type: string\n(?: {8}.+\n)*? {8}default: ''\n/m)
  const uses = code.split('\n').filter((line) => line.includes('inputs.allow_tag'))
  assert.equal(uses.length, 1, uses.join('\n'))
  const tag = step(ALLOWED_TAG)
  assert.match(tag, /^\s+if: \$\{\{ steps\.mode\.outputs\.push == 'true' && env\.ALLOW_TAG != '' \}\}$/m)
  assert.match(tag, /bash config\/mercurai\/scripts\/mirror-allowed-tag\.sh$/m)
  assert.doesNotMatch(tag, /\bgit push\b|sync-push\.sh/)
  assert.ok(names.indexOf(ALLOWED_TAG) > names.indexOf(GUARD) && names.indexOf(ALLOWED_TAG) < names.indexOf(MERGE))
  assert.match(step(ALLOWED_DISPATCH), /^\s+if: \$\{\{ steps\.mode\.outputs\.push == 'true' && steps\.allowtag\.outputs\.tag != '' \}\}$/m)
  assert.match(step(ALLOWED_DISPATCH), /-f "tag=\$tag" -f "tag_sha=\$sha"/)
  assert.ok(names.indexOf(ALLOWED_TAG) < names.indexOf(ALLOWED_DISPATCH))
})

test('every skipped release tag gets its own issue, matched by exact title, commented on only when its sha changes', () => {
  const issues = step(SKIPPED_ISSUES)
  assert.ok(names.indexOf(SKIPPED_ISSUES) > names.indexOf(ALLOWED_TAG) && names.indexOf(SKIPPED_ISSUES) < names.indexOf(MERGE))
  assert.match(issues, /^\s+if: \$\{\{ steps\.mode\.outputs\.push == 'true' \}\}$/m)
  // The list is computed here, just before it is read.
  assert.ok(issues.indexOf('bash config/mercurai/scripts/list-skipped-tags.sh\n') !== -1)
  assert.ok(issues.indexOf('list-skipped-tags.sh') < issues.indexOf('done 3< /tmp/tags-skipped'))
  assert.ok(issues.includes('title="fork-sync tag: $tag needs owner review"'))
  // Both the lookup and the "seen" check match the title exactly, never by containment.
  assert.equal(issues.split(`select(.title == $t)`).length - 1, 2)
  assert.doesNotMatch(issues, /contains\(\$t\)|startswith|test\(/)
  assert.ok(issues.includes(`([.body] + [.comments[].body]) | any(contains($s))`))
  assert.ok(issues.includes('if [ "$seen" != true ]; then gh issue comment "$number" --body "$body"; fi'))
  assert.ok(issues.includes('if [ "$GUARD_REFUSED" = false ]; then trusted=$UPSTREAM_SHA; else trusted=$FORK_MAIN; fi'))
  assert.match(issues, /render-tag-review\.sh "\$tag" "\$sha" "\$trusted" "\$FORK_BRANCH"/)
})

test('mirror-allowed-tag.sh validates strictly, checks the peel and the fork, and pushes one refspec', () => {
  const script = read('config', 'mercurai', 'scripts', 'mirror-allowed-tag.sh')
  assert.ok(script.includes(String.raw`re='^(v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?)@([0-9a-f]{40})$'`))
  assert.ok(script.includes('peeled=$(git rev-parse --verify -q "refs/upstream-tags/$tag^{commit}" || true)'))
  assert.ok(script.includes('if [ "$peeled" != "$sha" ]; then'))
  assert.ok(script.includes(`awk -v t="$tag" '$2 == t { found = 1 } END { exit !found }' "$state/origin-tags"`))
  assert.equal(script.split('git push').length - 1, 1)
  assert.ok(script.includes('git push origin "refs/upstream-tags/$tag:refs/tags/$tag"'))
  assert.doesNotMatch(script, /--force|--tags|--mirror|GH_TOKEN|FORK_BOT_TOKEN|\$\{ALLOW_TAG:-\}.*push/)
})

test('list-skipped-tags.sh uses the same eligibility test as sync-push.sh', () => {
  const test_ = 'git merge-base --is-ancestor "$1" "$UPSTREAM_SHA" && git diff --quiet "$UPSTREAM_SHA" "$1" -- .github config/mercurai'
  assert.ok(read('config', 'mercurai', 'scripts', 'list-skipped-tags.sh').includes(test_))
  assert.ok(read('config', 'mercurai', 'scripts', 'sync-push.sh').includes(test_))
})

test('render-tag-review.sh prints sanitised, bounded lists and the exact input', () => {
  const script = read('config', 'mercurai', 'scripts', 'render-tag-review.sh')
  assert.ok(script.includes(`clean() { LC_ALL=C sed 's#[^A-Za-z0-9._/@+ |=>{}()-]#?#g'; }`))
  assert.ok(script.includes('list=$(head -50 <<<"$names" | clean)'))
  assert.ok(script.includes('stat=$(head -50 <<<"$full_stat" | clean)'))
  assert.ok(script.includes('-f allow_tag=%s@%s'))
})
