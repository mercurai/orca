#!/usr/bin/env bash
# Assemble the release branch: the upstream TAG plus the active patch series, cherry-picked in
# manifest order. Runs git and yq only, never repository code. fork-assemble-release runs it in
# its test job and again in its push job, which pushes what it assembled itself instead of
# anything a job that ran the code under test reports (claude-code-config#1125, SEC-201).
#
# In: TAG, MANIFEST (in the checked-out workflow branch), MANIFEST_WORK, GITHUB_OUTPUT.
# Out: HEAD on the release branch; <state>/active; outputs release_branch, release_tag, tree.
# <state> is FORK_STATE_DIR, /tmp by default.
set -euo pipefail
state=${FORK_STATE_DIR:-/tmp}

git config user.name 'mercurai-fork-bot'
git config user.email 'fork-bot@users.noreply.github.com'
# The fork's tags only: fork-sync-upstream mirrors each release tag once and never moves it, and
# the mercurai.N numbering below must count the fork's releases, not names upstream invents.
git fetch origin '+refs/heads/patch/*:refs/remotes/origin/patch/*' --tags
echo "$TAG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || { echo "::error::$TAG is not a stable upstream tag"; exit 1; }
git rev-parse --verify "refs/tags/$TAG^{commit}" >/dev/null ||
  { echo "::error::the fork has no tag $TAG; fork-sync-upstream mirrors it first"; exit 1; }

# The release branch starts from the upstream tag, which has no config/mercurai/, so every later read uses this copy.
cp "$MANIFEST" "$MANIFEST_WORK"
base=$(yq -r '.base' "$MANIFEST_WORK")
[ "$base" = "$TAG" ] || { echo "::error::manifest base is $base, not $TAG; run fork-rebase-patches with tag=$TAG first"; exit 1; }
yq -r '.patches[] | select(.status == "upstream-open" or .status == "ours-only") | .branch' "$MANIFEST_WORK" > "$state/active"
branch=$(yq -r '.release_branch' "$MANIFEST_WORK")
# The push job force-pushes these names: a manifest that names `mercurai` or a traversal is refused.
[[ "$branch" =~ ^release/[A-Za-z0-9._-]+$ && "$branch" != *..* ]] || { echo "::error::release_branch '$branch' is not release/<name>; nothing was assembled"; exit 1; }
while read -r patch; do
  [ -z "$patch" ] && continue
  [[ "$patch" =~ ^patch/[A-Za-z0-9._-]+$ && "$patch" != *..* ]] || { echo "::error::patch branch '$patch' is not patch/<name>; nothing was assembled"; exit 1; }
  pb=$(yq -r ".patches[] | select(.branch == \"$patch\") | .base // \"\"" "$MANIFEST_WORK")
  [ "$pb" = "$TAG" ] || { echo "::error::$patch is recorded on $pb, not $TAG; it was not rebased"; exit 1; }
  git merge-base --is-ancestor "refs/tags/$TAG" "origin/$patch" || { echo "::error::$patch does not contain $TAG; it was not rebased onto it"; exit 1; }
done < "$state/active"
echo "series: $(tr '\n' ' ' < "$state/active")"

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
  # A CR in a commit subject must not reach the job log, where it could inject workflow commands.
  git cherry-pick -x --empty=drop "refs/tags/$TAG..origin/$patch" 2>&1 | tr -d '\r' || { echo "::error::$patch does not apply on $TAG"; git cherry-pick --abort; exit 1; }
done < "$state/active"
version=${TAG#v}
last=$(git tag -l "v${version}-mercurai.*" | sed 's/.*mercurai\.//' | sort -n | tail -1)
n=$(( ${last:-0} + 1 ))
{
  echo "release_branch=$branch"
  echo "release_tag=v${version}-mercurai.${n}"
  echo "tree=$(git rev-parse 'HEAD^{tree}')"
} >> "$GITHUB_OUTPUT"
git log --oneline "refs/tags/$TAG..HEAD" | tr -d '\r'
