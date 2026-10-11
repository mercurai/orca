#!/usr/bin/env bash
# Publish ci-base/<new tag> as the new tag plus the fork-CI commits ci-base/<old tag> carries beyond
# its own tag. Recreating it from the bare tag dropped those commits (claude-code-config#1107).
# An existing ci-base/<new tag> only gains the commits it lacks, as a fast-forward.
# Usage: carry-ci-base.sh <old tag> <new tag> <new tag commit> [remote]
set -euo pipefail
old_tag=$1 new_tag=$2 new_sha=$3 remote=${4:-origin}
old_ci="refs/remotes/$remote/ci-base/$old_tag"
new_ci="refs/remotes/$remote/ci-base/$new_tag"
git fetch -q "$remote" "+refs/heads/ci-base/*:refs/remotes/$remote/ci-base/*"

if git rev-parse -q --verify "$new_ci" >/dev/null; then
  start=$(git rev-parse "$new_ci")
  if ! git merge-base --is-ancestor "$new_sha" "$start"; then
    echo "::error::ci-base/$new_tag does not stand on $new_tag ($new_sha); fix it by hand" >&2
    exit 1
  fi
else
  start=$new_sha
fi

# '+' lines are fork-CI commits of the old base that the new one does not carry yet (matched by patch id).
missing=()
if git rev-parse -q --verify "$old_ci" >/dev/null; then
  mapfile -t missing < <(git cherry "$start" "$old_ci" "refs/tags/$old_tag^{commit}" | sed -n 's/^+ //p')
fi

git checkout -q --detach "$start"
for commit in "${missing[@]}"; do
  if ! git cherry-pick -x "$commit" >/dev/null; then
    git cherry-pick --abort || true
    echo "::error::fork-CI commit $commit from ci-base/$old_tag does not apply to ci-base/$new_tag; carry it by hand" >&2
    exit 1
  fi
done

head=$(git rev-parse HEAD)
if [ "$head" = "$start" ] && git rev-parse -q --verify "$new_ci" >/dev/null; then
  echo "ci-base/$new_tag already carries every fork-CI commit of ci-base/$old_tag"
  exit 0
fi
# A plain push: fast-forward only, so a ci-base someone moved meanwhile is rejected, never overwritten.
git push "$remote" "$head:refs/heads/ci-base/$new_tag"
echo "ci-base/$new_tag -> $head (${#missing[@]} fork-CI commit(s) carried from ci-base/$old_tag)"
