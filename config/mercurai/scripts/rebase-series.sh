#!/usr/bin/env bash
# Rebase every active patch branch onto BASE in local refs. Runs git and yq only, never
# repository code. fork-rebase-patches runs it in its test job and again in its push job,
# which pushes what it rebased itself instead of anything a job that ran the code under test
# reports (claude-code-config#1125, SEC-201).
#
# In: BASE, MANIFEST_WORK, FORK_STATE_DIR (default /tmp), and <state>/active,
# OVERRIDES (optional, see parse-overrides.sh).
# Out: local branches, plus these files in FORK_STATE_DIR:
#   rebased      one "branch before after" line per patch, every one leased later
#   merged       patches the base already carries
#   conflicted   one "branch old-base" line per patch that does not rebase
#   conflicts/<branch, "/" as "__">   the conflicting files
set -euo pipefail
state=${FORK_STATE_DIR:-/tmp}

: > "$state/rebased"
# The push job force-pushes these names: a manifest that names `mercurai` or a traversal is refused.
while read -r branch; do
  [ -z "$branch" ] && continue
  [[ "$branch" =~ ^patch/[A-Za-z0-9._-]+$ && "$branch" != *..* ]] || { echo "::error::patch branch '$branch' is not patch/<name>; nothing was rebased"; exit 1; }
done < "$state/active"
: > "$state/merged"
: > "$state/conflicted"
rm -rf "$state/conflicts"
mkdir -p "$state/conflicts"
. "$(dirname "${BASH_SOURCE[0]}")/parse-overrides.sh"
while read -r branch; do
  [ -z "$branch" ] && continue
  old=$(yq -r ".patches[] | select(.branch == \"$branch\") | .base // \"\"" "$MANIFEST_WORK")
  old=${old:-$(yq -r '.base' "$MANIFEST_WORK")}
  git checkout -q -B "$branch" "origin/$branch"
  before=$(git rev-parse HEAD)
  # A hand-ported head named in OVERRIDES replaces the rebase; the branch is leased on its old sha like any other.
  if [ -n "${HEADS[$branch]:-}" ]; then
    use_head "$branch" "$BASE"
    git checkout -q -B "$branch" "${HEADS[$branch]}"
    echo "$branch: using the ported head ${HEADS[$branch]}"
  # A rerun after a partial failure, or a lane that already moved the branch: the branch sits on
  # the base already, and replaying it from the old base would re-apply upstream's own history.
  elif git merge-base --is-ancestor "$BASE" HEAD; then
    echo "$branch already contains $BASE; no rebase needed"
  # A CR in a commit subject in git's output must not reach the job log (workflow-command injection).
  elif ! git rebase --onto "$BASE" "$old" </dev/null 2>&1 | tr -d '\r'; then
    git diff --name-only --diff-filter=U | head -50 > "$state/conflicts/${branch//\//__}"
    git rebase --abort
    echo "$branch $old" >> "$state/conflicted"
    continue
  fi
  # Nothing left after the rebase means the base already carries the patch.
  if [ "$(git rev-list --count "$BASE..HEAD")" = 0 ]; then
    echo "$branch" >> "$state/merged"
    # Leased unchanged: new work pushed to it meanwhile rejects the series push instead of being retired.
    echo "$branch $before $before" >> "$state/rebased"
    echo "$branch: no commits beyond $BASE -> merged-upstream"
    continue
  fi
  echo "$branch $before $(git rev-parse HEAD)" >> "$state/rebased"
done < "$state/active"
