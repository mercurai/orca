#!/usr/bin/env bash
# Assemble the release branch: the upstream TAG plus the active patch series, cherry-picked in
# manifest order. Runs git and yq only, never repository code. fork-assemble-release runs it in
# its test job and again in its push job, which pushes what it assembled itself instead of
# anything a job that ran the code under test reports (claude-code-config#1125, SEC-201).
#
# In: TAG, MANIFEST (in the checked-out workflow branch), MANIFEST_WORK, GITHUB_OUTPUT.
# Out: HEAD on the release branch; /tmp/active; outputs release_branch, release_tag, tree.
set -euo pipefail

git config user.name 'mercurai-fork-bot'
git config user.email 'fork-bot@users.noreply.github.com'
# The fork's tags only: fork-sync-upstream mirrors each release tag once and never moves it, and
# the mercurai.N numbering below must count the fork's releases, not names upstream invents.
git fetch origin '+refs/heads/patch/*:refs/remotes/origin/patch/*' --tags
git rev-parse --verify "refs/tags/$TAG^{commit}" >/dev/null
echo "$TAG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || { echo "::error::$TAG is not a stable upstream tag"; exit 1; }

# The release branch starts from the upstream tag, which has no config/mercurai/, so every later read uses this copy.
cp "$MANIFEST" "$MANIFEST_WORK"
base=$(yq -r '.base' "$MANIFEST_WORK")
[ "$base" = "$TAG" ] || { echo "::error::manifest base is $base, not $TAG; run fork-rebase-patches with tag=$TAG first"; exit 1; }
yq -r '.patches[] | select(.status == "upstream-open" or .status == "ours-only") | .branch' "$MANIFEST_WORK" > /tmp/active
while read -r patch; do
  [ -z "$patch" ] && continue
  pb=$(yq -r ".patches[] | select(.branch == \"$patch\") | .base // \"\"" "$MANIFEST_WORK")
  [ "$pb" = "$TAG" ] || { echo "::error::$patch is recorded on $pb, not $TAG; it was not rebased"; exit 1; }
  git merge-base --is-ancestor "refs/tags/$TAG" "origin/$patch" || { echo "::error::$patch does not contain $TAG; it was not rebased onto it"; exit 1; }
done < /tmp/active
echo "series: $(tr '\n' ' ' < /tmp/active)"

branch=$(yq -r '.release_branch' "$MANIFEST_WORK")
git checkout -q -B "$branch" "refs/tags/$TAG"
while read -r patch; do
  [ -z "$patch" ] && continue
  # Patches are rebased onto the tag, so tag..branch is the patch's commits. A patch stacked on an
  # earlier patch in the series (its branch starts from that patch's branch) carries the earlier
  # commits too; they are already applied here, so cherry-pick drops them as empty instead of failing.
  if [ "$(git rev-list --count "refs/tags/$TAG..origin/$patch")" = 0 ]; then
    echo "::warning::$patch has no commits beyond $TAG (merged upstream?); skipped"
    continue
  fi
  git cherry-pick -x --empty=drop "refs/tags/$TAG..origin/$patch" || { echo "::error::$patch does not apply on $TAG"; git cherry-pick --abort; exit 1; }
done < /tmp/active
version=${TAG#v}
last=$(git tag -l "v${version}-mercurai.*" | sed 's/.*mercurai\.//' | sort -n | tail -1)
n=$(( ${last:-0} + 1 ))
{
  echo "release_branch=$branch"
  echo "release_tag=v${version}-mercurai.${n}"
  echo "tree=$(git rev-parse 'HEAD^{tree}')"
} >> "$GITHUB_OUTPUT"
git log --oneline "refs/tags/$TAG..HEAD"
