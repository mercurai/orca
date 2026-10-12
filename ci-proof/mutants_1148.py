"""Evasion mutants for the #1148 sync guard and the #1152 lint and script fixes: (file, old, new).
Each anchor must occur exactly once; mutate_run.py counts a mutant whose anchor is missing or repeated
as a failure, never a skip."""

import pathlib

SYNC = pathlib.Path(".github/workflows/fork-sync-upstream.yml")
TEST_WF = pathlib.Path(".github/workflows/fork-scripts-test.yml")
S = pathlib.Path("config/mercurai/scripts")
GUARD = S / "merge-guard.sh"
RESULT = S / "merge-result-guard.sh"
FORWARD = S / "merge-forward.sh"
PUSH = S / "sync-push.sh"
PIN = S / "pin-upstream-sha.sh"
CARRY = S / "carry-ci-base.sh"
REBASE = S / "rebase-series.sh"
ASSEMBLE = S / "assemble-release.sh"

SANITISE = " | LC_ALL=C sed 's|[^A-Za-z0-9._/@+ -]|?|g'"
SHA_CHECK = 'if [[ "$ALLOWED_SHA" =~ ^[0-9a-f]{40}$ && "$ALLOWED_SHA" = "$UPSTREAM_SHA" ]]; then'
MERGE_GATE = "        if: ${{ steps.guard.outputs.refused == 'false' }}\n"
OVERRIDE = "${{ github.event_name == 'workflow_dispatch' && inputs.allow_guarded_merge_sha || '' }}"
GUARD_RUN = '        run: |\n          set -euo pipefail\n          git checkout -q "$FORK_BRANCH"\n          rc=0\n'
PUSH_IF = (
    "${{ steps.mode.outputs.push == 'true' && steps.guard.outputs.refused == 'false' }}"
)
GATE = " && steps.guard.outputs.refused == 'false'"

MUTANTS = {
    # What counts as guarded
    "guard-regex-workflows-only": (
        GUARD,
        r"'^(\.github/|config/mercurai/)'",
        r"'^(\.github/workflows/|config/mercurai/)'",
    ),
    "guard-regex-drops-config": (
        GUARD,
        r"'^(\.github/|config/mercurai/)'",
        r"'^(\.github/)'",
    ),
    "guard-regex-drops-github": (
        GUARD,
        r"'^(\.github/|config/mercurai/)'",
        r"'^(config/mercurai/)'",
    ),
    "guard-renames-kept": (GUARD, "--name-only --no-renames -z", "--name-only -z"),
    "guard-diff-from-fork-tip": (
        GUARD,
        'git merge-base "$ref" "$upstream"',
        'git rev-parse "$ref"',
    ),
    "guard-ignores-extra-refs": (
        GUARD,
        'for ref in "$fork" "$@"; do',
        'for ref in "$fork"; do',
    ),
    "guard-mergebase-failure-masked": (
        GUARD,
        'base=$(git merge-base "$ref" "$upstream") || exit 1',
        'base=$(git merge-base "$ref" "$upstream")',
    ),
    "guard-workflow-drops-main-range": (
        SYNC,
        'merge-guard.sh HEAD "$UPSTREAM_SHA" origin/main',
        'merge-guard.sh HEAD "$UPSTREAM_SHA"',
    ),
    "result-pathspec-drops-github": (
        RESULT,
        "-- .github config/mercurai",
        "-- config/mercurai",
    ),
    "result-pathspec-workflows-only": (
        RESULT,
        "-- .github config/mercurai",
        "-- .github/workflows config/mercurai",
    ),
    "result-renames-kept": (RESULT, "--name-only --no-renames -z", "--name-only -z"),
    # The owner's override
    "allowed-true-string": (
        GUARD,
        '[[ "${ALLOWED_SHA:-}" =~ ^[0-9a-f]{40}$ && "$ALLOWED_SHA" = "$sha" ]]',
        '[ "${ALLOWED_SHA:-}" = "true" ]',
    ),
    "allowed-short-sha-prefix": (
        GUARD,
        '[[ "${ALLOWED_SHA:-}" =~ ^[0-9a-f]{40}$ && "$ALLOWED_SHA" = "$sha" ]]',
        '[[ "${ALLOWED_SHA:-}" =~ ^[0-9a-f]+$ && "$sha" == "$ALLOWED_SHA"* ]]',
    ),
    "allowed-inverted": (GUARD, '"$ALLOWED_SHA" = "$sha"', '"$ALLOWED_SHA" != "$sha"'),
    "allowed-ignores-sha": (GUARD, ' && "$ALLOWED_SHA" = "$sha"', ""),
    "allowed-any-when-set": (
        GUARD,
        '[[ "${ALLOWED_SHA:-}" =~ ^[0-9a-f]{40}$ && "$ALLOWED_SHA" = "$sha" ]]',
        '[ -n "${ALLOWED_SHA:-}" ]',
    ),
    "d1-recheck-removed": (SYNC, SHA_CHECK, "if true; then"),
    "d1-sha-compare-dropped": (SYNC, ' && "$ALLOWED_SHA" = "$UPSTREAM_SHA" ]]', " ]]"),
    "d1-hex-check-dropped": (SYNC, '[[ "$ALLOWED_SHA" =~ ^[0-9a-f]{40}$ && ', "[[ "),
    "override-on-schedule": (
        SYNC,
        OVERRIDE,
        "${{ inputs.allow_guarded_merge_sha || '' }}",
    ),
    "override-is-the-pinned-sha": (
        SYNC,
        OVERRIDE,
        "${{ steps.fetch.outputs.upstream_sha }}",
    ),
    "override-input-boolean": (
        SYNC,
        "        type: string\n        default: ''\n",
        "        type: boolean\n        default: false\n",
    ),
    # The pin
    "fetch-pin-dropped": (
        SYNC,
        "upstream_sha=$(bash config/mercurai/scripts/pin-upstream-sha.sh upstream/main)",
        "upstream_sha=$(git rev-parse upstream/main)",
    ),
    "pin-ignores-ancestry": (
        PIN,
        ' && git merge-base --is-ancestor "$allowed" "$tip"',
        "",
    ),
    "pin-accepts-short-sha": (PIN, "^[0-9a-f]{40}$", "^[0-9a-f]+$"),
    "pin-always-owner-sha": (
        PIN,
        'if [[ "$allowed" =~ ^[0-9a-f]{40}$ ]] &&',
        "if true &&",
    ),
    # Pushes: gated on the guard, and only refs inside the pin
    "push-gate-default-open": (
        PUSH,
        '"${GUARD_REFUSED:-true}"',
        '"${GUARD_REFUSED:-false}"',
    ),
    "push-gate-removed": (
        PUSH,
        'if [ "${GUARD_REFUSED:-true}" != false ]; then',
        "if false; then",
    ),
    "push-gate-loosened": (
        PUSH,
        'if [ "${GUARD_REFUSED:-true}" != false ]; then',
        'if [ "${GUARD_REFUSED:-true}" = true ]; then',
    ),
    "push-main-from-moving-ref": (
        PUSH,
        'git push origin "$UPSTREAM_SHA:refs/heads/main"',
        "git push origin refs/remotes/upstream/main:refs/heads/main",
    ),
    "push-tag-ancestry-dropped": (
        PUSH,
        'if within "refs/upstream-tags/$tag^{commit}"; then',
        "if true; then",
    ),
    "push-branch-ancestry-dropped": (
        PUSH,
        'if within "$sha"; then refspecs+=',
        "if true; then refspecs+=",
    ),
    "push-within-always-true": (
        PUSH,
        'within() { git merge-base --is-ancestor "$1" "$UPSTREAM_SHA"; }',
        "within() { true; }",
    ),
    "push-tag-forced": (
        PUSH,
        'refspecs+=("refs/upstream-tags/$tag:refs/tags/$tag")',
        'refspecs+=("+refs/upstream-tags/$tag:refs/tags/$tag")',
    ),
    "push-rebase-tag-from-skipped": (
        PUSH,
        '        skipped+=("$tag")\n',
        '        skipped+=("$tag"); echo "$tag" >> "$state/tags-pushed"\n',
    ),
    "workflow-main-gate-removed": (
        SYNC,
        "        # A non-fast-forward push fails here on purpose: `main` must never carry fork commits.\n        if: "
        + PUSH_IF
        + "\n",
        "        # A non-fast-forward push fails here on purpose: `main` must never carry fork commits.\n        if: ${{ steps.mode.outputs.push == 'true' }}\n",
    ),
    "workflow-tags-gate-removed": (
        SYNC,
        "        id: tags\n        # New names only, never forced, and only tags whose commit is in the pinned commit.\n        if: "
        + PUSH_IF
        + "\n",
        "        id: tags\n        # New names only, never forced, and only tags whose commit is in the pinned commit.\n        if: ${{ steps.mode.outputs.push == 'true' }}\n",
    ),
    "workflow-dispatch-gate-removed": (
        SYNC,
        GATE + " && steps.tags.outputs.rebase_tag != '' }}",
        " && steps.tags.outputs.rebase_tag != '' }}",
    ),
    "workflow-branches-gate-removed": (
        SYNC,
        GATE + " && inputs.mirror_branches == true }}",
        " && inputs.mirror_branches == true }}",
    ),
    "workflow-main-pushed-from-moving-ref": (
        SYNC,
        "          bash config/mercurai/scripts/sync-push.sh main\n",
        "          git push origin refs/remotes/upstream/main:refs/heads/main\n",
    ),
    "workflow-push-before-guard": (
        SYNC,
        "      - name: Guard every push and the merge-forward\n",
        "      - name: Early mirror\n        run: git push origin refs/remotes/upstream/main:refs/heads/main\n\n      - name: Guard every push and the merge-forward\n",
    ),
    "workflow-dispatch-from-fetch": (
        SYNC,
        "steps.tags.outputs.rebase_tag != ''",
        "steps.fetch.outputs.rebase_tag != ''",
    ),
    # The merge step and merge-forward.sh
    "forward-allowed-check-inverted": (
        FORWARD,
        'if [ "${GUARD_ALLOWED:-false}" = true ]; then',
        'if [ "${GUARD_ALLOWED:-false}" != true ]; then',
    ),
    "forward-allowed-check-always": (
        FORWARD,
        'if [ "${GUARD_ALLOWED:-false}" = true ]; then',
        "if true; then",
    ),
    "forward-reset-removed": (FORWARD, 'git reset -q --hard "$before"\n', ""),
    "forward-exit-11-becomes-0": (FORWARD, "\nexit 11\n", "\nexit 0\n"),
    "forward-result-guard-error-ignored": (
        FORWARD,
        'if [ "$rc" -ne 3 ]; then exit "$rc"; fi',
        'if [ "$rc" -ne 3 ]; then exit 0; fi',
    ),
    "forward-result-guard-skipped": (
        FORWARD,
        'bash "$here/merge-result-guard.sh" "$before" > "$state/guarded" || rc=$?',
        "rc=0",
    ),
    "forward-conflict-not-aborted": (FORWARD, "  git merge --abort\n", ""),
    "forward-conflict-file-clashes": (
        FORWARD,
        '"$state/sync-conflicts"',
        '"$state/conflicts"',
    ),
    "forward-merges-moving-ref": (
        FORWARD,
        'git merge --no-edit "$UPSTREAM_SHA"',
        "git merge --no-edit upstream/main",
    ),
    "forward-before-is-the-wrong-ref": (
        FORWARD,
        "before=$(git rev-parse HEAD)",
        "before=$(git rev-parse HEAD~1)",
    ),
    "forward-cr-not-stripped": (
        FORWARD,
        """git merge --no-edit "$UPSTREAM_SHA" 2>&1 | tr -d '\\r'""",
        'git merge --no-edit "$UPSTREAM_SHA"',
    ),
    "merge-runs-from-merged-tree": (
        SYNC,
        "bash /tmp/merge-forward.sh || rc=$?",
        "bash config/mercurai/scripts/merge-forward.sh || rc=$?",
    ),
    "tmp-copy-removed": (
        SYNC,
        "          cp config/mercurai/scripts/merge-forward.sh config/mercurai/scripts/merge-result-guard.sh /tmp/\n",
        "",
    ),
    "tmp-copy-forward-only": (
        SYNC,
        "config/mercurai/scripts/merge-forward.sh config/mercurai/scripts/merge-result-guard.sh /tmp/",
        "config/mercurai/scripts/merge-forward.sh /tmp/",
    ),
    "merge-gate-removed": (SYNC, MERGE_GATE, ""),
    "merge-gate-loosened": (
        SYNC,
        MERGE_GATE,
        "        if: ${{ steps.guard.outputs.refused != 'true' }}\n",
    ),
    "push-before-merge-forward": (
        SYNC,
        "            try_merge || exit 0\n",
        '            git push origin "$FORK_BRANCH" || true\n            try_merge || exit 0\n',
    ),
    "output-defaults-removed": (
        SYNC,
        '          { echo "conflict=false"; echo "guarded=false"; } >> "$GITHUB_OUTPUT"\n',
        "",
    ),
    "guarded-exit-not-mapped": (
        SYNC,
        '              11) echo "guarded=true" >> "$GITHUB_OUTPUT"; return 1 ;;\n',
        "",
    ),
    # The guard step
    "guard-step-renamed-away": (
        SYNC,
        "      - name: Guard every push and the merge-forward\n",
        "      - name: Guard\n",
    ),
    "guard-after-merge": (
        SYNC,
        "      - name: Guard every push and the merge-forward\n",
        "      - name: Merge main forward into the fork branch\n        run: echo early\n\n      - name: Guard every push and the merge-forward\n",
    ),
    "guard-uses-moving-ref": (
        SYNC,
        'merge-guard.sh HEAD "$UPSTREAM_SHA" origin/main',
        "merge-guard.sh HEAD upstream/main origin/main",
    ),
    "guard-step-holds-token": (
        SYNC,
        GUARD_RUN,
        "          GH_TOKEN: ${{ secrets.FORK_BOT_TOKEN }}\n" + GUARD_RUN,
    ),
    "outputs-after-cat": (
        SYNC,
        '          echo "allowed=false" >> "$GITHUB_OUTPUT"\n',
        '          cat /tmp/guarded\n          echo "allowed=false" >> "$GITHUB_OUTPUT"\n',
    ),
    # Issues
    "issue-step-skips-guarded-result": (
        SYNC,
        " || steps.merge.outputs.guarded == 'true' }}",
        " }}",
    ),
    "issue-step-no-fail": (
        SYNC,
        '            gh issue create --label "$SYNC_ISSUE_LABEL" --title "$title" --body "$body"\n          fi\n          exit 1\n\n      - name: Report a merge conflict',
        '            gh issue create --label "$SYNC_ISSUE_LABEL" --title "$title" --body "$body"\n          fi\n\n      - name: Report a merge conflict',
    ),
    "issue-guard-title-shared": (
        SYNC,
        'title="fork-sync guard: upstream main',
        'title="fork-sync: upstream main',
    ),
    "issue-guard-lookup-shared": (
        SYNC,
        'startswith("fork-sync guard:")',
        'startswith("fork-sync")',
    ),
    "issue-conflict-lookup-shared": (
        SYNC,
        'startswith("fork-sync: ")',
        'startswith("fork-sync")',
    ),
    "issue-conflict-list-stale-name": (
        SYNC,
        "$(cat /tmp/sync-conflicts)",
        "$(cat /tmp/conflicts)",
    ),
    # Sanitised path lists
    "sanitiser-removed-guard": (
        GUARD,
        'head -50 <<<"$paths"' + SANITISE,
        'head -50 <<<"$paths"',
    ),
    "sanitiser-removed-result": (
        RESULT,
        'head -50 <<<"$paths"' + SANITISE,
        'head -50 <<<"$paths"',
    ),
    "sanitiser-removed-conflicts": (
        FORWARD,
        SANITISE + ' > "$state/sync-conflicts"',
        ' > "$state/sync-conflicts"',
    ),
    "list-unbounded-guard": (GUARD, 'head -50 <<<"$paths"', 'cat <<<"$paths"'),
    "list-printf-head-pipe": (
        GUARD,
        'head -50 <<<"$paths"',
        "printf '%s\\n' \"$paths\" | head -50",
    ),
    # #1152: lint step and script fixes
    "oxlint-step-removed": (
        TEST_WF,
        "      - name: Lint config/mercurai\n",
        "      - name: Lint something else\n",
    ),
    "oxlint-unpinned": (TEST_WF, "oxlint@1.86.0", "oxlint@latest"),
    "oxlint-version-drifts-from-lock": (TEST_WF, "oxlint@1.86.0", "oxlint@1.85.0"),
    "oxlint-wrong-path": (
        TEST_WF,
        '"$GITHUB_WORKSPACE/config/mercurai"\n',
        '"$GITHUB_WORKSPACE/config/mercurai/scripts/nothing.mjs"\n',
    ),
    "oxlint-config-not-the-repos": (
        TEST_WF,
        '-c "$GITHUB_WORKSPACE/.oxlintrc.json" ',
        "",
    ),
    "npx-in-checkout": (TEST_WF, "        working-directory: ${{ runner.temp }}\n", ""),
    "npx-registry-override-removed": (
        TEST_WF,
        "          NPM_CONFIG_REGISTRY: https://registry.npmjs.org/\n",
        "",
    ),
    "npx-registry-elsewhere": (
        TEST_WF,
        "NPM_CONFIG_REGISTRY: https://registry.npmjs.org/",
        "NPM_CONFIG_REGISTRY: https://registry.example.invalid/",
    ),
    "npx-user-config-kept": (
        TEST_WF,
        "          NPM_CONFIG_USERCONFIG: /dev/null\n",
        "",
    ),
    "npx-second-step-in-checkout": (
        TEST_WF,
        "      - name: Series scripts (push and ci-base)\n",
        "      - name: Extra tool\n        run: npx --yes cowsay@1.6.0 hi\n\n      - name: Series scripts (push and ci-base)\n",
    ),
    "lint-job-caches": (
        TEST_WF,
        "          node-version: 24\n",
        "          node-version: 24\n          cache: npm\n",
    ),
    "carry-cr-strip-removed": (
        CARRY,
        """if ! git cherry-pick -x "$commit" 2>&1 >/dev/null | tr -d '\\r' >&2; then""",
        'if ! git cherry-pick -x "$commit" >/dev/null; then',
    ),
    "state-dir-default-off-tmp-rebase": (
        REBASE,
        "state=${FORK_STATE_DIR:-/tmp}",
        "state=${FORK_STATE_DIR:-/var/tmp/fork-state}",
    ),
    "state-dir-default-off-tmp-assemble": (
        ASSEMBLE,
        "state=${FORK_STATE_DIR:-/tmp}",
        "state=${FORK_STATE_DIR:-/var/tmp/fork-state}",
    ),
    "state-dir-ignored-rebase": (REBASE, "state=${FORK_STATE_DIR:-/tmp}", "state=/tmp"),
    "assemble-tag-format-check-removed": (
        ASSEMBLE,
        'echo "$TAG" | grep -Eq \'^v[0-9]+\\.[0-9]+\\.[0-9]+$\' || { echo "::error::$TAG is not a stable upstream tag"; exit 1; }\n',
        "",
    ),
}
