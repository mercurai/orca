#!/usr/bin/env bash
# Merge one pinned upstream commit into the checked-out fork branch, locally, and refuse a result that
# changes a guarded path the owner did not allow (claude-code-config#1148). merge-guard.sh judged the
# range from one merge base; this judges what the merge produced, so a base that moved since, or a
# criss-cross history, cannot change a workflow or fork script unseen. It never pushes: the workflow
# pushes after this succeeds. Run it from a copy, with merge-result-guard.sh beside it: the merged tree
# may hold upstream's version of both.
#
# In:  UPSTREAM_SHA, GUARD_ALLOWED (true when the owner allowed this commit), FORK_STATE_DIR (/tmp).
# Out: exit 0: merged. Exit 10: conflict, merge aborted, files in <state>/sync-conflicts. Exit 11: the
#      result changed guarded paths, branch reset to where it was, paths in <state>/guarded. Other: the result
#      check failed, branch reset, its exit status.
#      Both lists are shown with odd characters as ?.
set -euo pipefail
state=${FORK_STATE_DIR:-/tmp}
here=$(cd "$(dirname "$0")" && pwd)
before=$(git rev-parse HEAD)
# A CR in git's output must not reach the job log (workflow-command injection).
if ! git merge --no-edit "$UPSTREAM_SHA" 2>&1 | tr -d '\r'; then
  files=$(git diff --name-only --diff-filter=U)
  git merge --abort
  head -50 <<<"$files" | LC_ALL=C sed 's|[^A-Za-z0-9._/@+ -]|?|g' > "$state/sync-conflicts"
  exit 10
fi
if [ "${GUARD_ALLOWED:-false}" = true ]; then exit 0; fi
rc=0
bash "$here/merge-result-guard.sh" "$before" > "$state/guarded" || rc=$?
if [ "$rc" -eq 0 ]; then exit 0; fi
# Guarded paths changed, or the check itself failed: either way the merge does not stay.
git reset -q --hard "$before"
if [ "$rc" -ne 3 ]; then exit "$rc"; fi
exit 11
