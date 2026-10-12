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

candidates=()
if git rev-parse -q --verify "$old_ci" >/dev/null; then
  # An old tag upstream re-cut after ci-base/<old> was made would widen the range to upstream commits.
  if ! git merge-base --is-ancestor "refs/tags/$old_tag^{commit}" "$old_ci"; then
    echo "::error::ci-base/$old_tag does not stand on $old_tag (re-cut?); carry its fork-CI commits by hand" >&2
    exit 1
  fi
  mapfile -t candidates < <(git rev-list --reverse --no-merges "refs/tags/$old_tag^{commit}..$old_ci")
else
  echo "::warning::no ci-base/$old_tag to carry fork-CI commits from; ci-base/$new_tag is the bare tag" >&2
fi

git checkout -q --detach "$start"
carried=0
for commit in "${candidates[@]}"; do
  # Already carried: the -x trailer names it, or an equal patch is there. The trailer survives upstream
  # changing the lines around the carried change, which alters the patch id.
  if git log --format=%B "$new_sha..HEAD" | grep -qF "cherry picked from commit $commit"; then continue; fi
  if [ -z "$(git cherry HEAD "$commit" "$commit^" | sed -n 's/^+ //p')" ]; then continue; fi
  # A CR in a commit subject in git's output must not reach the job log (workflow-command injection).
  if ! git cherry-pick -x "$commit" 2>&1 >/dev/null | tr -d '\r' >&2; then
    conflicts=$(git diff --name-only --diff-filter=U | tr '\n' ' ')
    git cherry-pick --abort 2>/dev/null || true
    echo "::error::fork-CI commit $commit from ci-base/$old_tag does not apply to ci-base/$new_tag (conflicts: ${conflicts:-none, empty pick}); carry it by hand" >&2
    exit 1
  fi
  carried=$((carried + 1))
done

head=$(git rev-parse HEAD)
if [ "$head" = "$start" ] && git rev-parse -q --verify "$new_ci" >/dev/null; then
  echo "ci-base/$new_tag already carries every fork-CI commit of ci-base/$old_tag"
  exit 0
fi
# A plain push: fast-forward only, so a ci-base someone moved meanwhile is rejected, never overwritten.
git push "$remote" "$head:refs/heads/ci-base/$new_tag"
echo "ci-base/$new_tag -> $head ($carried fork-CI commit(s) carried from ci-base/$old_tag)"
