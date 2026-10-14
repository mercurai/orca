#!/usr/bin/env bash
# The guard step of fork-sync-upstream (claude-code-config#1148): run merge-guard.sh on the pinned commit, over the
# union of the main mirror's range (origin/main..) and the merge-forward's, and turn its exit code into the step
# outputs `refused` and `allowed`. Git only, no token, and before anything is pushed.
#
# Env: UPSTREAM_SHA, ALLOWED_SHA (the owner's input, may be empty), FORK_BRANCH, GITHUB_OUTPUT, FORK_STATE_DIR (/tmp).
# Out: outputs `allowed` (always) and `refused`; the guarded paths in <state>/guarded and on stdout.
# Exit: 0 with `refused` set; 1 or other (the guard itself failed, or exit 4 with no matching owner sha): no
#       `refused` output, so nothing downstream runs.
set -euo pipefail
state=${FORK_STATE_DIR:-/tmp}
here=$(cd "$(dirname "$0")" && pwd)
out=${GITHUB_OUTPUT:-/dev/null}
git checkout -q "$FORK_BRANCH"
rc=0
bash "$here/merge-guard.sh" HEAD "$UPSTREAM_SHA" origin/main > "$state/guarded" || rc=$?
# Outputs first: nothing the script prints (upstream picks path names) can then set them.
echo "allowed=false" >> "$out"
case "$rc" in
  # A clean range with the owner's exact sha also releases the result guard (claude-code-config#1172).
  0)
    echo "refused=false" >> "$out"
    if [[ "${ALLOWED_SHA:-}" =~ ^[0-9a-f]{40}$ && "$ALLOWED_SHA" = "$UPSTREAM_SHA" ]]; then echo "allowed=true" >> "$out"; fi ;;
  3) echo "refused=true" >> "$out" ;;
  # 4 is also what sed exits with on an I/O error: only a full sha equal to the pinned commit counts.
  4)
    if [[ "${ALLOWED_SHA:-}" =~ ^[0-9a-f]{40}$ && "$ALLOWED_SHA" = "$UPSTREAM_SHA" ]]; then
      echo "refused=false" >> "$out"; echo "allowed=true" >> "$out"
    else
      exit 4
    fi ;;
  *) exit "$rc" ;;
esac
cat "$state/guarded"
