"""Mutants for the final batch (claude-code-config#1148): replacements for the ones whose code moved into scripts,
and new ones. mutate_run.py drops DROP from mutants_1148.MUTANTS and adds MUTANTS. Each anchor occurs exactly once.

Output wording mutants keep the code shape and change what a script prints or writes, so a text pin alone cannot catch
them; the harness (test-fork-series-scripts.sh) asserts on the output."""

import pathlib

SYNC = pathlib.Path(".github/workflows/fork-sync-upstream.yml")
S = pathlib.Path("config/mercurai/scripts")
GS = S / "guard-step.sh"
GUARD = S / "merge-guard.sh"
RESULT = S / "merge-result-guard.sh"
FORWARD = S / "merge-forward.sh"
PUSH = S / "sync-push.sh"
ALLOW = S / "mirror-allowed-tag.sh"
SKIPPED = S / "list-skipped-tags.sh"
NEWTAGS = S / "list-new-tags.sh"
RENDER = S / "render-tag-review.sh"
REPORT = S / "report-sync-issue.sh"
TI = S / "tag-issues.sh"
TEST_WF = pathlib.Path(".github/workflows/fork-scripts-test.yml")

SED_FIXED = "sed -n '1,50{s#[^A-Za-z0-9._/@+ -]#?#g;p;}')"
ALLOW_IF = "if: ${{ !cancelled() && steps.fetch.outcome == 'success' && steps.mode.outputs.push == 'true' && env.ALLOW_TAG != '' }}"

DROP = {
    "guard-workflow-drops-main-range",
    "guard-uses-moving-ref",
    "d1-recheck-removed",
    "d1-sha-compare-dropped",
    "d1-hex-check-dropped",
    "guard-step-holds-token",
    "outputs-after-cat",
    "output-defaults-removed",
    "guarded-exit-not-mapped",
    "allowtag-held-check-dropped",
    "tagissue-summary-unsanitised",
    "tagissue-summary-unbounded",
    "tagissue-summary-head-pipe",
    "tagissue-user-failure-silent",
    "tagissue-user-failure-ignored",
    "tagissue-scripts-not-copied",
    "issue-step-no-fail",
    "issue-guard-title-shared",
    "issue-guard-lookup-shared",
    "issue-conflict-lookup-shared",
    "issue-conflict-list-stale-name",
}

MUTANTS = {
    # guard-step.sh (the guard step's outputs)
    "guardstep-drops-main-range": (
        GS,
        'HEAD "$UPSTREAM_SHA" origin/main',
        'HEAD "$UPSTREAM_SHA"',
    ),
    "guardstep-uses-moving-ref": (
        GS,
        'HEAD "$UPSTREAM_SHA" origin/main',
        "HEAD upstream/main origin/main",
    ),
    "guardstep-refused-mislabelled": (
        GS,
        '3) echo "refused=true" >> "$out" ;;',
        '3) echo "refused=false" >> "$out" ;;',
    ),
    "guardstep-clean-mislabelled": (
        GS,
        '0) echo "refused=false" >> "$out" ;;',
        '0) echo "refused=true" >> "$out" ;;',
    ),
    "guardstep-exit4-recheck-removed": (
        GS,
        'if [[ "${ALLOWED_SHA:-}" =~ ^[0-9a-f]{40}$ && "$ALLOWED_SHA" = "$UPSTREAM_SHA" ]]; then',
        "if true; then",
    ),
    "guardstep-exit4-sha-compare-dropped": (
        GS,
        ' && "$ALLOWED_SHA" = "$UPSTREAM_SHA" ]]',
        " ]]",
    ),
    "guardstep-exit4-hex-check-dropped": (
        GS,
        '[[ "${ALLOWED_SHA:-}" =~ ^[0-9a-f]{40}$ && ',
        "[[ ",
    ),
    "guardstep-failure-swallowed": (
        GS,
        '  *) exit "$rc" ;;',
        '  *) echo "refused=false" >> "$out" ;;',
    ),
    "guardstep-allowed-default-dropped": (GS, 'echo "allowed=false" >> "$out"\n', ""),
    "guard-step-holds-token": (
        SYNC,
        "        run: bash config/mercurai/scripts/guard-step.sh\n",
        "          GH_TOKEN: ${{ secrets.FORK_BOT_TOKEN }}\n        run: bash config/mercurai/scripts/guard-step.sh\n",
    ),
    # merge-forward.sh outputs and the merge step
    "forward-output-defaults-removed": (
        FORWARD,
        '{ echo "conflict=false"; echo "guarded=false"; } >> "$out"\n',
        "",
    ),
    "forward-conflict-output-dropped": (
        FORWARD,
        '  echo "conflict=true" >> "$out"\n',
        "",
    ),
    "forward-guarded-output-dropped": (FORWARD, 'echo "guarded=true" >> "$out"\n', ""),
    "forward-guarded-output-wrong-key": (
        FORWARD,
        'echo "guarded=true" >> "$out"',
        'echo "conflict=true" >> "$out"',
    ),
    "merge-step-11-not-mapped": (SYNC, "10 | 11) return 1 ;;", "10) return 1 ;;"),
    # guard and conflict issues
    "syncissue-guard-text-for-merge-stage": (
        REPORT,
        "so main, tags and branches were already mirrored from it",
        "so nothing was pushed or merged",
    ),
    "syncissue-merge-text-for-guard-stage": (
        REPORT,
        "Nothing was pushed or merged: no main, no tags, no branches, no merge-forward.",
        "Main, tags and branches were already mirrored.",
    ),
    "syncissue-guard-title-shared": (
        REPORT,
        'title="fork-sync guard: upstream main $UPSTREAM_SHA changes guarded paths',
        'title="fork-sync: upstream main $UPSTREAM_SHA changes guarded paths',
    ),
    "syncissue-conflict-prefix-broad": (
        REPORT,
        'prefix="fork-sync: "',
        'prefix="fork-sync"',
    ),
    "syncissue-guard-prefix-broad": (
        REPORT,
        '    prefix="fork-sync guard:"\n    title="fork-sync guard: upstream main $UPSTREAM_SHA changes',
        '    prefix="fork-sync"\n    title="fork-sync guard: upstream main $UPSTREAM_SHA changes',
    ),
    "syncissue-conflict-list-stale-name": (
        REPORT,
        '$(cat "$state/sync-conflicts")',
        '$(cat "$state/conflicts")',
    ),
    "syncissue-lookup-not-paged": (
        REPORT,
        'open_issues=$("$gh" api --paginate ',
        'open_issues=$("$gh" api ',
    ),
    "syncissue-lookup-limited-to-closed": (
        REPORT,
        "issues?state=open&",
        "issues?state=closed&",
    ),
    "syncissue-does-not-fail-the-run": (REPORT, "fi\nexit 1\n", "fi\nexit 0\n"),
    "syncissue-report-only-files": (
        REPORT,
        'if [ "${PUSH:-}" != true ]; then',
        "if false; then",
    ),
    "syncissue-wrong-label": (REPORT, "label=fork-sync\n", "label=fork-sync-tag\n"),
    "syncissue-merge-stage-lists-nothing": (
        REPORT,
        "```\\n%s\\n```\\n\\nReview them, then",
        "```\\n\\n```\\n\\nReview them, then",
    ),
    # merge-guard.sh / merge-result-guard.sh
    "guard-diff-failure-masked": (GUARD, "tr '\\0' '\\n' || exit 1", "tr '\\0' '\\n'"),
    "guard-mergebase-failure-masked": (
        GUARD,
        'base=$(git merge-base "$ref" "$upstream") || exit 1',
        'base=$(git merge-base "$ref" "$upstream") || true',
    ),
    "result-list-unbounded": (
        RESULT,
        'if [ "$count" -gt 50 ]; then echo "... and $((count - 50)) more"; fi\n',
        "",
    ),
    "result-more-count-off-by-one": (
        RESULT,
        'echo "... and $((count - 50)) more"',
        'echo "... and $((count - 49)) more"',
    ),
    # sync-push.sh outputs
    "push-rebase-tag-output-dropped": (
        PUSH,
        '    echo "rebase_tag=${stable:-$rc}" >> "${GITHUB_OUTPUT:-/dev/null}"\n',
        "",
    ),
    "push-rebase-tag-output-wrong-key": (
        PUSH,
        'echo "rebase_tag=${stable:-$rc}"',
        'echo "tag=${stable:-$rc}"',
    ),
    # list-new-tags.sh
    "newtags-includes-fork-names": (
        NEWTAGS,
        " v[0-9]+\\.[0-9]+\\.[0-9]+(-rc\\.[0-9]+)?$'",
        " v[0-9]+\\.[0-9]+\\.[0-9]+.*$'",
    ),
    "newtags-moved-inverted": (
        NEWTAGS,
        "'$2 != $3 {print $1}'",
        "'$2 == $3 {print $1}'",
    ),
    "newtags-origin-without-tags-fails": (
        NEWTAGS,
        "{ grep -v '\\^{}$' || true; }",
        "grep -v '\\^{}$'",
    ),
    "newtags-moved-warning-wording": (
        NEWTAGS,
        "upstream moved tags the fork already holds",
        "upstream changed tags",
    ),
    "tagissue-fetch-outcome-not-required": (
        SYNC,
        "!cancelled() && steps.fetch.outcome == 'success' && steps.mode.outputs.push == 'true' }}",
        "!cancelled() && steps.mode.outputs.push == 'true' }}",
    ),
    # mirror-allowed-tag.sh (the retry, and the outputs)
    "allowtag-held-at-other-commit-accepted": (
        ALLOW,
        'if [ "$on_origin" != "$sha" ]; then',
        "if false; then",
    ),
    "allowtag-held-peel-line-ignored": (
        ALLOW,
        "$2 ~ /\\^\\{\\}$/ { print $1 }",
        "$2 ~ /NOPE$/ { print $1 }",
    ),
    "allowtag-retry-pushes-again": (
        ALLOW,
        '  echo "$tag is already on origin at $sha; nothing is pushed, the hand-off to the rebase can run again"\n  hand_on\n',
        '  git push origin "refs/upstream-tags/*:refs/tags/*"\n  hand_on\n',
    ),
    "allowtag-retry-emits-nothing": (
        ALLOW,
        '  echo "$tag is already on origin at $sha; nothing is pushed, the hand-off to the rebase can run again"\n  hand_on\n',
        '  echo "$tag is already on origin at $sha; nothing is pushed, the hand-off to the rebase can run again"\n',
    ),
    "allowtag-held-error-code-changed": (ALLOW, "    exit 5\n", "    exit 0\n"),
    "allowtag-origin-unreachable-ignored": (
        ALLOW,
        'held=$(git ls-remote origin "refs/tags/$tag" "refs/tags/$tag^{}") || {',
        'held=$(git ls-remote origin "refs/tags/$tag" "refs/tags/$tag^{}" || true) || {',
    ),
    "allowtag-output-keys-swapped": (
        ALLOW,
        '{ echo "tag=$tag"; echo "sha=$sha"; }',
        '{ echo "sha=$tag"; echo "tag=$sha"; }',
    ),
    "allowtag-outputs-not-written": (
        ALLOW,
        ' >> "${GITHUB_OUTPUT:-/dev/null}"',
        " >> /dev/null",
    ),
    "allowtag-no-cancel-gate": (
        SYNC,
        ALLOW_IF,
        ALLOW_IF.replace("!cancelled() && ", ""),
    ),
    "allowtag-runs-from-checkout": (
        SYNC,
        "bash /tmp/mirror-allowed-tag.sh",
        "bash config/mercurai/scripts/mirror-allowed-tag.sh",
    ),
    "allowtag-script-not-copied": (
        SYNC,
        "config/mercurai/scripts/mirror-allowed-tag.sh /tmp/\n",
        "/tmp/\n",
    ),
    "allowtag-steps-before-merge": (
        SYNC,
        "      - name: Merge main forward into the fork branch\n",
        "      - name: Mirror the owner-allowed tag\n        run: echo early\n\n      - name: Merge main forward into the fork branch\n",
    ),
    "allowtag-dispatch-before-the-guard-issue": (
        SYNC,
        "      - name: Report a guarded upstream range as an issue\n",
        "      - name: Hand the owner-allowed tag to fork-rebase-patches\n        run: echo early\n\n      - name: Report a guarded upstream range as an issue\n",
    ),
    # tag-issues.sh: summary list, login, label, non-commit tags
    "tagissue-summary-sed-gp": (
        TI,
        SED_FIXED,
        "sed -n '1,50{s#[^A-Za-z0-9._/@+ -]#?#gp;}')",
    ),
    "tagissue-summary-unsanitised": (TI, SED_FIXED, "sed -n '1,50p')"),
    "tagissue-summary-unbounded": (TI, SED_FIXED, "sed 's#[^A-Za-z0-9._/@+ -]#?#g')"),
    "tagissue-summary-head-pipe": (
        TI,
        "| sort | LC_ALL=C " + SED_FIXED,
        "| sort | head -50 | LC_ALL=C sed 's#[^A-Za-z0-9._/@+ -]#?#g')",
    ),
    "tagissue-summary-off-by-one": (TI, "'1,50{s#", "'1,49{s#"),
    "tagissue-empty-login-accepted": (TI, ' && [ -n "$me" ]', ""),
    "tagissue-user-failure-silent": (
        TI,
        "  echo \"::error::tag review issues need a user token; 'gh api user' failed or named no login, so FORK_BOT_TOKEN looks like an App installation token\"\n",
        "",
    ),
    "tagissue-user-failure-wording": (TI, "need a user token", "need a token"),
    "tagissue-user-failure-ignored": (
        TI,
        'me=$("$gh" api user --jq .login) && [ -n "$me" ] || {',
        'me=$("$gh" api user --jq .login || true) && [ -n "$me" ] || {',
    ),
    "tagissue-label-shared": (TI, "TAG_LABEL=fork-sync-tag\n", "TAG_LABEL=fork-sync\n"),
    "tagissue-noncommit-tag-aborts": (
        TI,
        '|| { echo "::warning::$(display "$tag") does not point at a commit; skipped"; continue; }',
        "",
    ),
    "tagissue-noncommit-warning-wording": (
        TI,
        "does not point at a commit; skipped",
        "is not a commit",
    ),
    "skipped-noncommit-tag-listed": (
        SKIPPED,
        '  if ! git rev-parse --verify -q "refs/upstream-tags/$tag^{commit}" > /dev/null; then\n',
        "  if false; then\n",
    ),
    "skipped-noncommit-warning-wording": (
        SKIPPED,
        "does not point at a commit; skipped",
        "is not a commit",
    ),
    "tagissue-scripts-not-copied": (
        SYNC,
        "cp config/mercurai/scripts/tag-issues.sh ",
        "cp ",
    ),
    "tagissue-report-script-not-copied": (
        SYNC,
        "config/mercurai/scripts/report-sync-issue.sh config/mercurai/scripts/mirror-allowed-tag.sh /tmp/",
        "config/mercurai/scripts/mirror-allowed-tag.sh /tmp/",
    ),
    # render-tag-review.sh wording
    "render-names-internal-lane": (
        RENDER,
        "from a lane the owner'\"'\"'s orchestrator orders after a security review of this diff",
        "from a lane on orca-config-0f'\"'\"'s explicit order after an Opus security read of the diff above",
    ),
    "render-input-without-sha": (RENDER, "-f allow_tag=%s@%s", "-f allow_tag=%s"),
    "render-stat-not-printed": (
        RENDER,
        '\\n\\n```\\n%s\\n```\\n\\n\' "$stat"',
        '\\n\\n```\\n```\\n\\n\' "$stat"',
    ),
    "render-paths-sanitiser-removed": (
        RENDER,
        'list=$(head -50 <<<"$names" | clean)',
        'list=$(head -50 <<<"$names")',
    ),
}
