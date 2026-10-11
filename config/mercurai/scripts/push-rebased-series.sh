#!/usr/bin/env bash
# Push a fully rebased patch series in one atomic push: every rebased patch branch, each leased on
# the sha it had before the rebase, plus the manifest commit on the fork branch. Either every ref
# moves or none does, so a failure can never leave the series split across two bases
# (claude-code-config#1103). A moved fork branch (fork-sync-upstream's merge-forward) is retried by
# replaying the manifest commit on top of it; a moved patch branch fails the push for good.
# Usage: push-rebased-series.sh <rebased file: "branch before after" per line> <fork branch> [manifest commit] [remote]
set -euo pipefail
rebased_file=$1 fork_branch=$2 manifest_commit=${3:-} remote=${4:-origin}

for attempt in 1 2 3; do
  args=()
  while read -r branch before after; do
    [ -z "${branch:-}" ] && continue
    args+=("--force-with-lease=refs/heads/$branch:$before" "$after:refs/heads/$branch")
  done < "$rebased_file"
  if [ -n "$manifest_commit" ]; then
    git fetch -q "$remote" "$fork_branch"
    fork_base=$(git rev-parse FETCH_HEAD)
    git checkout -q --detach "$fork_base"
    git cherry-pick "$manifest_commit" >/dev/null
    args+=("--force-with-lease=refs/heads/$fork_branch:$fork_base" "HEAD:refs/heads/$fork_branch")
  fi
  if [ "${#args[@]}" -eq 0 ]; then
    echo "nothing to push"
    exit 0
  fi
  if git push --atomic "$remote" "${args[@]}"; then
    echo "pushed $(( ${#args[@]} / 2 )) ref(s) atomically"
    exit 0
  fi
  echo "::warning::atomic push attempt $attempt rejected; nothing was pushed"
  [ "$attempt" = 3 ] || sleep "${PUSH_RETRY_SLEEP:-15}"
done
echo "::error::the rebased series was not pushed; every patch branch and the manifest are unchanged" >&2
exit 1
