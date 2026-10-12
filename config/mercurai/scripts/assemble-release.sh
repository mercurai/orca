#!/usr/bin/env bash
# Assemble the release branch: the upstream TAG plus the active patch series, cherry-picked in
# manifest order. Runs git and yq only, never repository code. fork-assemble-release runs it in
# its test job and again in its push job, which pushes what it assembled itself instead of
# anything a job that ran the code under test reports (claude-code-config#1125, SEC-201).
#
# In: TAG, UPSTREAM_REPO, MANIFEST (in the checked-out workflow branch), MANIFEST_WORK, GITHUB_OUTPUT,
# OVERRIDES (optional, see parse-overrides.sh; the workflow allows it on a dry run only).
# Out: HEAD on the release branch; /tmp/active; outputs release_branch, release_tag, tree.
set -euo pipefail

git config user.name 'mercurai-fork-bot'
git config user.email 'fork-bot@users.noreply.github.com'
git remote add upstream "https://github.com/${UPSTREAM_REPO}.git"
git fetch upstream --tags --force
git fetch origin '+refs/heads/patch/*:refs/remotes/origin/patch/*' --tags
git rev-parse --verify "refs/tags/$TAG^{commit}" >/dev/null
echo "$TAG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || { echo "::error::$TAG is not a stable upstream tag"; exit 1; }

# The release branch starts from the upstream tag, which has no config/mercurai/, so every later read uses this copy.
cp "$MANIFEST" "$MANIFEST_WORK"
yq -r '.patches[] | select(.status == "upstream-open" or .status == "ours-only") | .branch' "$MANIFEST_WORK" > /tmp/active
. "$(dirname "${BASH_SOURCE[0]}")/parse-overrides.sh"
# With OVERRIDES (a dry run before the series is pushed) the manifest still names the old base, and
# an overridden patch is checked against the tag itself instead of its recorded base.
base=$(yq -r '.base' "$MANIFEST_WORK")
[ "$base" = "$TAG" ] || [ "${#HEADS[@]}" -gt 0 ] || { echo "::error::manifest base is $base, not $TAG; run fork-rebase-patches with tag=$TAG first"; exit 1; }
declare -A head_of=()
while read -r patch; do
  [ -z "$patch" ] && continue
  if [ -n "${HEADS[$patch]:-}" ]; then
    use_head "$patch" "refs/tags/$TAG"
    head_of[$patch]=${HEADS[$patch]}
    continue
  fi
  pb=$(yq -r ".patches[] | select(.branch == \"$patch\") | .base // \"\"" "$MANIFEST_WORK")
  [ "$pb" = "$TAG" ] || { echo "::error::$patch is recorded on $pb, not $TAG; it was not rebased"; exit 1; }
  git merge-base --is-ancestor "refs/tags/$TAG" "origin/$patch" || { echo "::error::$patch does not contain $TAG; it was not rebased onto it"; exit 1; }
  head_of[$patch]=origin/$patch
done < /tmp/active
echo "series: $(tr '\n' ' ' < /tmp/active)"

branch=$(yq -r '.release_branch' "$MANIFEST_WORK")
git checkout -q -B "$branch" "refs/tags/$TAG"
while read -r patch; do
  [ -z "$patch" ] && continue
  # Patches are rebased onto the tag, so tag..branch is the patch's commits. A patch stacked on an
  # earlier patch in the series (its branch starts from that patch's branch) carries the earlier
  # commits too; they are already applied here, so cherry-pick drops them as empty instead of failing.
  if [ "$(git rev-list --count "refs/tags/$TAG..${head_of[$patch]}")" = 0 ]; then
    echo "::warning::$patch has no commits beyond $TAG (merged upstream?); skipped"
    continue
  fi
  git cherry-pick -x --empty=drop "refs/tags/$TAG..${head_of[$patch]}" || { echo "::error::$patch does not apply on $TAG"; git cherry-pick --abort; exit 1; }
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
