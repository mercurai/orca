"""Mutants for Codex finding 2fd3023b95eb (claude-code-config#1148): allow_tag leaves the hand-off to the automatic
step only when that step dispatched exactly the approved tag@sha. mutate_run.py drops DROP and adds MUTANTS. Each
anchor occurs exactly once."""

import pathlib

SYNC = pathlib.Path(".github/workflows/fork-sync-upstream.yml")
ALLOW = pathlib.Path("config/mercurai/scripts/mirror-allowed-tag.sh")

COND = (
    'if [ "${DISPATCHED_TAG:-}" = "$tag" ] && [ "${DISPATCHED_SHA:-}" = "$sha" ]; then'
)
RECORD = '          { echo "dispatched_tag=$tag"; echo "dispatched_sha=$tag_sha"; } >> "$GITHUB_OUTPUT"\n'
RUN = '          gh workflow run fork-rebase-patches.yml --ref "$FORK_BRANCH" -f "tag=$tag" -f "tag_sha=$tag_sha"\n'

# The tags-pushed early return it targeted is gone; allowtag-dispatched-* replace it.
DROP = {"allowtag-already-pushed-repushed"}

MUTANTS = {
    # mirror-allowed-tag.sh: when the hand-off is left to the automatic step
    "allowtag-dispatched-ignored": (ALLOW, COND, "if false; then"),
    "allowtag-dispatched-tag-only": (
        ALLOW,
        COND,
        'if [ "${DISPATCHED_TAG:-}" = "$tag" ]; then',
    ),
    "allowtag-dispatched-sha-only": (
        ALLOW,
        COND,
        'if [ "${DISPATCHED_SHA:-}" = "$sha" ]; then',
    ),
    "allowtag-dispatched-either": (
        ALLOW,
        COND,
        'if [ "${DISPATCHED_TAG:-}" = "$tag" ] || [ "${DISPATCHED_SHA:-}" = "$sha" ]; then',
    ),
    "allowtag-any-pushed-tag-suppressed": (
        ALLOW,
        COND,
        'if grep -qxF "$tag" "$state/tags-pushed" 2>/dev/null; then',
    ),
    "allowtag-any-pushed-tag-suppressed-or": (
        ALLOW,
        COND,
        COND.replace(
            "; then", ' || grep -qxF "$tag" "$state/tags-pushed" 2>/dev/null; then'
        ),
    ),
    # the workflow: what the automatic step dispatched, recorded only after it did
    "dispatch-recorded-before-run": (SYNC, RUN + RECORD, RECORD + RUN),
    "dispatch-not-recorded": (SYNC, RECORD, ""),
    "dispatch-records-wrong-sha": (
        SYNC,
        'echo "dispatched_sha=$tag_sha"',
        'echo "dispatched_sha=$(git rev-parse HEAD)"',
    ),
    "dispatch-step-no-id": (
        SYNC,
        "      - name: Hand the newest release tag to fork-rebase-patches\n        id: dispatch\n",
        "      - name: Hand the newest release tag to fork-rebase-patches\n",
    ),
    "allowtag-env-sha-from-tag": (
        SYNC,
        "DISPATCHED_SHA: ${{ steps.dispatch.outputs.dispatched_sha }}",
        "DISPATCHED_SHA: ${{ steps.dispatch.outputs.dispatched_tag }}",
    ),
    "allowtag-env-tag-missing": (
        SYNC,
        "          DISPATCHED_TAG: ${{ steps.dispatch.outputs.dispatched_tag }}\n",
        "",
    ),
}
