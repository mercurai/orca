"""Mutants for the PR 41 tail (claude-code-config#1148): output-content changes that keep the code shape, so a text
pin alone cannot catch them, plus W1 order, W2 lookups, D1, the sed `gp` regression and the carry-ci-base CR strip.
mutate_run.py drops DROP from the earlier batches and adds MUTANTS. Each anchor occurs exactly once."""

import pathlib

SYNC = pathlib.Path(".github/workflows/fork-sync-upstream.yml")
S = pathlib.Path("config/mercurai/scripts")
GUARD = S / "merge-guard.sh"
PUSH = S / "sync-push.sh"
ALLOW = S / "mirror-allowed-tag.sh"
RENDER = S / "render-tag-review.sh"
REPORT = S / "report-sync-issue.sh"
TI = S / "tag-issues.sh"
CARRY = S / "carry-ci-base.sh"

RULE = "Only the owner dispatches this, or someone the owner authorises after a security review of this diff."
GUARD_ARGS = '"$UPSTREAM_SHA" "$FORK_BRANCH" "$(cat "$state/guarded")" "$FORK_BRANCH" "$UPSTREAM_SHA")'
TI_IF = "if: ${{ !cancelled() && steps.fetch.outcome == 'success' && steps.mode.outputs.push == 'true' }}"

# The render wording changed (D2): the old anchor no longer exists; d-render-rule-internal replaces it.
DROP = {"render-names-internal-lane"}

MUTANTS = {
    # D2: public texts name no internal session, model or role; the rule sentence is exact.
    "d-render-rule-internal": (
        RENDER,
        RULE,
        "Only the owner dispatches this, or a lane the orchestrator orders after an Opus security read of this diff.",
    ),
    "d-render-rule-reworded": (
        RENDER,
        RULE,
        "Only the owner dispatches this, or someone the owner trusts.",
    ),
    "d-syncissue-guard-names-internal": (
        REPORT,
        "Review the range, then either merge it through a reviewed PR",
        "Review the range in a lane, then either merge it through a reviewed PR",
    ),
    "d-syncissue-merge-names-internal": (
        REPORT,
        "Review them, then either merge through a reviewed PR",
        "Review them with Opus, then either merge through a reviewed PR",
    ),
    "d-tagissue-summary-names-internal": (
        TI,
        "the rest follow on later runs",
        "the rest follow when the orchestrator runs again",
    ),
    # render-tag-review.sh output content
    "d-render-paths-count-bounded": (
        RENDER,
        "count=$(printf '%s' \"$names\" | grep -c . || true)",
        "count=$(printf '%s' \"$names\" | head -50 | grep -c . || true)",
    ),
    "d-render-list-unbounded": (
        RENDER,
        'list=$(head -50 <<<"$names" | clean)',
        'list=$(clean <<<"$names")',
    ),
    "d-render-stat-unbounded": (
        RENDER,
        'stat=$(head -50 <<<"$full_stat" | clean)',
        'stat=$(clean <<<"$full_stat")',
    ),
    # tag-issues.sh summary content
    "d-tagissue-summary-tag-without-sha": (
        TI,
        'if [ "$new" -ge "$MAX_NEW" ]; then overflow+=("$tag $sha"); continue; fi',
        'if [ "$new" -ge "$MAX_NEW" ]; then overflow+=("$tag"); continue; fi',
    ),
    "d-tagissue-summary-count-wrong": (
        TI,
        '"${#overflow[@]}" "$MAX_NEW" "$MAX_UPDATES" "$list")',
        '"$new" "$MAX_NEW" "$MAX_UPDATES" "$list")',
    ),
    "d-tagissue-summary-wording": (
        TI,
        "release tags need owner review but did not get an issue",
        "release tags were skipped and did not get an issue",
    ),
    "d-tagissue-summary-sed-gp": (
        TI,
        "sed -n '1,50{s#[^A-Za-z0-9._/@+ -]#?#g;p;}')",
        "sed -n '1,50{s#[^A-Za-z0-9._/@+ -]#?#gp;}')",
    ),
    # report-sync-issue.sh output content
    "d-syncissue-guard-short-sha-input": (
        REPORT,
        GUARD_ARGS,
        '"$UPSTREAM_SHA" "$FORK_BRANCH" "$(cat "$state/guarded")" "$FORK_BRANCH" "${UPSTREAM_SHA:0:12}")',
    ),
    "d-syncissue-guard-list-dropped": (
        REPORT,
        GUARD_ARGS,
        '"$UPSTREAM_SHA" "$FORK_BRANCH" "" "$FORK_BRANCH" "$UPSTREAM_SHA")',
    ),
    # merge-guard.sh, sync-push.sh, mirror-allowed-tag.sh output content
    "d-guard-more-count-off-by-one": (
        GUARD,
        'echo "... and $((count - 50)) more"',
        'echo "... and $((count - 49)) more"',
    ),
    "d-guard-list-unsanitised": (
        GUARD,
        "head -50 <<<\"$paths\" | LC_ALL=C sed 's|[^A-Za-z0-9._/@+ -]|?|g'",
        'head -50 <<<"$paths"',
    ),
    "d-push-skipped-tags-wording": (
        PUSH,
        'msg="tags not mirrored (not inside',
        'msg="tags skipped (not inside',
    ),
    "d-push-skipped-branches-wording": (
        PUSH,
        'msg="branches not mirrored (not inside',
        'msg="branches skipped (not inside',
    ),
    "d-allowtag-held-error-wording": (
        ALLOW,
        "the fork already holds $tag at another commit; a tag is never moved",
        "the fork already has $tag; a tag is never moved",
    ),
    "d-allowtag-unreachable-error-wording": (
        ALLOW,
        "could not ask origin about $tag; nothing was pushed",
        "origin did not answer; nothing was pushed",
    ),
    # W1: the owner-allowed steps after the merge and the issues; the tag issues run after a failure.
    "d-allowtag-gate-success-only": (
        SYNC,
        "if: ${{ !cancelled() && steps.fetch.outcome == 'success' && steps.mode.outputs.push == 'true' && env.ALLOW_TAG != '' }}",
        "if: ${{ steps.fetch.outcome == 'success' && steps.mode.outputs.push == 'true' && env.ALLOW_TAG != '' }}",
    ),
    "d-tagissue-gate-success-only": (
        SYNC,
        TI_IF,
        "if: ${{ steps.fetch.outcome == 'success' && steps.mode.outputs.push == 'true' }}",
    ),
    "d-allowtag-dispatch-before-merge": (
        SYNC,
        "      - name: Mirror upstream branches under upstream/*\n",
        "      - name: Hand the owner-allowed tag to fork-rebase-patches\n        run: echo early\n\n"
        "      - name: Mirror upstream branches under upstream/*\n",
    ),
    # W2: every lookup pages through all issues; the tag issues keep their own label.
    "d-tagissue-lookup-not-paged": (
        TI,
        'issues=$("$gh" api --paginate "repos/$GH_REPO/issues?state=all',
        'issues=$("$gh" api "repos/$GH_REPO/issues?state=all',
    ),
    "d-tagissue-comments-not-paged": (
        TI,
        '"$gh" api --paginate "repos/$GH_REPO/issues/$number/comments',
        '"$gh" api "repos/$GH_REPO/issues/$number/comments',
    ),
    "d-syncissue-lookup-open-only-label-tag": (
        REPORT,
        "issues?state=open&labels=$label&per_page=100",
        "issues?state=open&labels=fork-sync-tag&per_page=100",
    ),
    # D1: a failed diff early in the union must not read as "nothing changed".
    "d-guard-diff-failure-continue": (
        GUARD,
        "tr '\\0' '\\n' || exit 1",
        "tr '\\0' '\\n' || continue",
    ),
    "d-guard-diff-failure-true": (
        GUARD,
        "tr '\\0' '\\n' || exit 1",
        "tr '\\0' '\\n' || true",
    ),
    # carry-ci-base.sh: git's cherry-pick output reaches the log only with the CR stripped.
    "d-carry-cr-passed-through": (
        CARRY,
        "2>&1 >/dev/null | tr -d '\\r' >&2; then",
        "2>&1 >/dev/null | cat >&2; then",
    ),
}
