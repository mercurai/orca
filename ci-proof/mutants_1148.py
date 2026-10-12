"""Evasion mutants for the #1148 merge-forward guard and the #1152 lint and script fixes: (file, old, new).
Each anchor must occur exactly once; mutate_run.py counts a mutant whose anchor is missing or repeated
as a failure, never a skip."""

import pathlib

SYNC = pathlib.Path(".github/workflows/fork-sync-upstream.yml")
TEST_WF = pathlib.Path(".github/workflows/fork-scripts-test.yml")
S = pathlib.Path("config/mercurai/scripts")
GUARD = S / "merge-guard.sh"
RESULT = S / "merge-result-guard.sh"
FORWARD = S / "merge-forward.sh"
CARRY = S / "carry-ci-base.sh"
REBASE = S / "rebase-series.sh"
ASSEMBLE = S / "assemble-release.sh"

SANITISE = " | LC_ALL=C sed 's|[^A-Za-z0-9._/@+ -]|?|g'"
SHA_CHECK = 'if [[ "$ALLOWED_SHA" =~ ^[0-9a-f]{40}$ && "$ALLOWED_SHA" = "$UPSTREAM_SHA" ]]; then'
MERGE_GATE = "        if: ${{ steps.guard.outputs.refused == 'false' }}\n"
OVERRIDE = "${{ github.event_name == 'workflow_dispatch' && inputs.allow_guarded_merge_sha || '' }}"

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
        'git merge-base "$fork" "$upstream"',
        'git rev-parse "$fork"',
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
    "forward-exit-11-becomes-0": (
        FORWARD,
        'git reset -q --hard "$before"\nexit 11\n',
        'git reset -q --hard "$before"\nexit 0\n',
    ),
    "forward-result-guard-skipped": (
        FORWARD,
        'bash "$here/merge-result-guard.sh" "$before" > "$state/guarded" || rc=$?',
        "rc=0",
    ),
    "forward-conflict-not-aborted": (FORWARD, "  git merge --abort\n", ""),
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
        SANITISE + ' > "$state/conflicts"',
        ' > "$state/conflicts"',
    ),
    "list-unbounded-guard": (GUARD, 'head -50 <<<"$paths"', 'cat <<<"$paths"'),
    "list-printf-head-pipe": (
        GUARD,
        'head -50 <<<"$paths"',
        "printf '%s\\n' \"$paths\" | head -50",
    ),
    # Workflow wiring
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
    "guard-step-renamed-away": (
        SYNC,
        "      - name: Guard the merge-forward\n",
        "      - name: Guard\n",
    ),
    "guard-after-merge": (
        SYNC,
        "      - name: Guard the merge-forward\n",
        "      - name: Merge main forward into the fork branch\n        run: echo early\n\n      - name: Guard the merge-forward\n",
    ),
    "guard-uses-moving-ref": (
        SYNC,
        'merge-guard.sh HEAD "$UPSTREAM_SHA"',
        "merge-guard.sh HEAD upstream/main",
    ),
    "guard-step-holds-token": (
        SYNC,
        "          # The one commit this run guards, merges and names in the issue.\n          UPSTREAM_SHA: ${{ steps.fetch.outputs.upstream_sha }}\n",
        "          UPSTREAM_SHA: ${{ steps.fetch.outputs.upstream_sha }}\n          GH_TOKEN: ${{ secrets.FORK_BOT_TOKEN }}\n",
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
    "outputs-after-cat": (
        SYNC,
        '          echo "allowed=false" >> "$GITHUB_OUTPUT"\n',
        '          cat /tmp/guarded\n          echo "allowed=false" >> "$GITHUB_OUTPUT"\n',
    ),
    # #1152
    "oxlint-step-removed": (
        TEST_WF,
        "      - name: Lint config/mercurai\n        run: npx --yes oxlint@1.86.0 --format github config/mercurai\n\n",
        "",
    ),
    "oxlint-unpinned": (TEST_WF, "oxlint@1.86.0", "oxlint@latest"),
    "oxlint-version-drifts-from-lock": (TEST_WF, "oxlint@1.86.0", "oxlint@1.85.0"),
    "oxlint-wrong-path": (
        TEST_WF,
        "--format github config/mercurai\n",
        "--format github config/mercurai/scripts/nothing.mjs\n",
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
