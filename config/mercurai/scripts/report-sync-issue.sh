#!/usr/bin/env bash
# Open or update the sync issue for a guard refusal or a merge conflict, then fail the run (claude-code-config#1148).
# Two kinds, each with a title prefix of its own and found by it exactly, so a refusal is never filed as a comment on
# a conflict issue or the other way round. Lookups page through every open `fork-sync` issue (the tag issues have
# a label of their own). The guard stage says nothing was pushed; the merge stage says main, tags and branches were
# already mirrored, because the guard had passed on the range and only the merge result changed guarded paths.
#
# Usage: report-sync-issue.sh guard|merge|conflict
# Env:   UPSTREAM_SHA, FORK_BRANCH, GH_REPO, PUSH (true to file; anything else prints the text only),
#        FORK_STATE_DIR (/tmp), GH (the gh command, for tests). Reads <state>/guarded or <state>/sync-conflicts.
# Exit:  1 always when the stage is valid (the run fails after filing); 2 for an unknown stage.
set -euo pipefail
state=${FORK_STATE_DIR:-/tmp}
gh=${GH:-gh}
label=fork-sync
: "${UPSTREAM_SHA:?}" "${FORK_BRANCH:?}" "${GH_REPO:?}"
stage=${1:-}
case "$stage" in
  guard)
    prefix="fork-sync guard:"
    title="fork-sync guard: upstream main $UPSTREAM_SHA changes guarded paths; nothing was pushed or merged into ${FORK_BRANCH}"
    body=$(printf 'Mirroring or merging upstream/main (%s) into `%s` would change files under `.github/` or `config/mercurai/`, which run with the fork token once pushed. Nothing was pushed or merged: no main, no tags, no branches, no merge-forward.\n\nGuarded paths (first 50, odd characters shown as ?):\n\n```\n%s\n```\n\nReview the range, then either merge it through a reviewed PR, or dispatch fork-sync-upstream from `%s` with allow_guarded_merge_sha=%s (it mirrors and merges exactly that commit).\n' \
      "$UPSTREAM_SHA" "$FORK_BRANCH" "$(cat "$state/guarded")" "$FORK_BRANCH" "$UPSTREAM_SHA")
    ;;
  merge)
    prefix="fork-sync guard:"
    title="fork-sync guard: upstream main $UPSTREAM_SHA: the merge into ${FORK_BRANCH} changed guarded paths and was reset"
    body=$(printf 'The guard passed on the range to upstream/main (%s), so main, tags and branches were already mirrored from it. Merging it into `%s` would have changed files under `.github/` or `config/mercurai/` (a merge base that moved, or a criss-cross history), which run with the fork token once pushed. That merge was reset: nothing was pushed to `%s`.\n\nGuarded paths the merge would have changed (first 50, odd characters shown as ?):\n\n```\n%s\n```\n\nReview them, then either merge through a reviewed PR, or dispatch fork-sync-upstream from `%s` with allow_guarded_merge_sha=%s (it merges exactly that commit; main, tags and branches are already there).\n' \
      "$UPSTREAM_SHA" "$FORK_BRANCH" "$FORK_BRANCH" "$(cat "$state/guarded")" "$FORK_BRANCH" "$UPSTREAM_SHA")
    ;;
  conflict)
    prefix="fork-sync: "
    title="fork-sync: ${FORK_BRANCH} does not merge with upstream main $UPSTREAM_SHA"
    body=$(printf 'Merging upstream/main (%s) into `%s` conflicts in:\n\n```\n%s\n```\n\nResolve on a branch from `%s`, open a PR, and the next hourly run continues.\n' \
      "$UPSTREAM_SHA" "$FORK_BRANCH" "$(cat "$state/sync-conflicts")" "$FORK_BRANCH")
    ;;
  *)
    echo "usage: report-sync-issue.sh guard|merge|conflict" >&2
    exit 2
    ;;
esac
if [ "${PUSH:-}" != true ]; then
  echo "$title"
  echo "$body"
  exit 1
fi
# Every open issue of this label, never just the first page; the title prefix is matched exactly.
open_issues=$("$gh" api --paginate "repos/$GH_REPO/issues?state=open&labels=$label&per_page=100" --jq '.[] | {number, title}')
existing=$(jq -r -s --arg p "$prefix" '[.[] | select(.title | startswith($p))][0].number // empty' <<<"$open_issues")
if [ -n "$existing" ]; then
  "$gh" issue comment "$existing" --body "$body"
else
  "$gh" label create "$label" --color d93f0b --description 'fork sync needs a human' 2>/dev/null || true
  "$gh" issue create --label "$label" --title "$title" --body "$body"
fi
exit 1
