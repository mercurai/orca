#!/usr/bin/env bash
# Assemble the release branch: the upstream TAG plus the active patch series, cherry-picked in
# manifest order. Runs git and yq only, never repository code. fork-assemble-release runs it in
# its test job and again in its push job, which pushes what it assembled itself instead of
# anything a job that ran the code under test reports (claude-code-config#1125, SEC-201).
#
# Main mode: a non-empty UPSTREAM_MAIN_SHA names a frozen commit of official stablyai/orca main.
# The release branch then starts from that commit, the manifest base and every active patch base
# must equal it, and every active patch carries a `commit:` pin equal to its fetched branch head.
# TAG stays the version floor and the release name; it need not be an ancestor of main.
#
# In: TAG, optional UPSTREAM_MAIN_SHA, MANIFEST (in the checked-out workflow revision),
#     MANIFEST_WORK, GITHUB_OUTPUT.
# Out: HEAD on the release branch; <state>/active; outputs release_branch, release_tag, tree and,
#      in main mode, upstream_main_sha and series (`patch/<name>:<sha>,...` in manifest order).
# <state> is FORK_STATE_DIR, /tmp by default.
set -euo pipefail
state=${FORK_STATE_DIR:-/tmp}
main_sha=${UPSTREAM_MAIN_SHA:-}
official_main_ref=refs/upstream-main/main
# Spelled out, not a range: a range can match capitals in some locales.
full_sha='^[0123456789abcdef]{40}$'
series=

fail() { echo "::error::$1"; exit 1; }

# Main mode: the frozen commit is a full sha that official main contains. Refused before anything is checked out.
prove_official_main() {
  [[ "$main_sha" =~ $full_sha ]] || fail "UPSTREAM_MAIN_SHA is not a lowercase 40-character commit sha; nothing was assembled"
  git fetch -q --no-tags "https://github.com/stablyai/orca.git" "+refs/heads/main:$official_main_ref" ||
    fail "could not fetch stablyai/orca main to check UPSTREAM_MAIN_SHA; nothing was assembled"
  { git cat-file -e "$main_sha^{commit}" 2>/dev/null && git merge-base --is-ancestor "$main_sha" "$official_main_ref"; } ||
    fail "UPSTREAM_MAIN_SHA is not a commit of stablyai/orca main; nothing was assembled"
}

# Main mode: one active patch is recorded on the frozen commit, pinned, unmoved and built on it.
vet_main_patch() {  # vet_main_patch <patch/name>
  local patch=$1 recorded pin head
  recorded=$(P=$patch yq -r '.patches[] | select(.branch == strenv(P)) | .base // ""' "$MANIFEST_WORK")
  [ "$recorded" = "$main_sha" ] || fail "$patch is not recorded on UPSTREAM_MAIN_SHA; it was not rebased"
  pin=$(P=$patch yq -r '.patches[] | select(.branch == strenv(P)) | .commit // ""' "$MANIFEST_WORK")
  [[ "$pin" =~ $full_sha ]] || fail "$patch has no lowercase 40-character commit pin in the manifest; nothing was assembled"
  head=$(git rev-parse --verify -q "refs/remotes/origin/$patch^{commit}") || fail "the fork has no branch $patch; nothing was assembled"
  [ "$head" = "$pin" ] || fail "$patch is at $head, not its pinned $pin; the branch moved after it was pinned"
  git merge-base --is-ancestor "$main_sha" "$pin" || fail "$patch does not contain UPSTREAM_MAIN_SHA; it was not rebased onto it"
  series+="${series:+,}$patch:$pin"
}

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
if [ -n "$main_sha" ]; then
  prove_official_main
  [ "$base" = "$main_sha" ] || fail "manifest base is not UPSTREAM_MAIN_SHA; run fork-rebase-patches onto it first"
  start=$main_sha
else
  [ "$base" = "$TAG" ] || { echo "::error::manifest base is $base, not $TAG; run fork-rebase-patches with tag=$TAG first"; exit 1; }
  start=refs/tags/$TAG
fi
yq -r '.patches[] | select(.status == "upstream-open" or .status == "ours-only") | .branch' "$MANIFEST_WORK" > "$state/active"
branch=$(yq -r '.release_branch' "$MANIFEST_WORK")
# The push job force-pushes these names: a manifest that names `mercurai` or a traversal is refused.
[[ "$branch" =~ ^release/[A-Za-z0-9._-]+$ && "$branch" != *..* ]] || { echo "::error::release_branch '$branch' is not release/<name>; nothing was assembled"; exit 1; }
while read -r patch; do
  [ -z "$patch" ] && continue
  [[ "$patch" =~ ^patch/[A-Za-z0-9._-]+$ && "$patch" != *..* ]] || { echo "::error::patch branch '$patch' is not patch/<name>; nothing was assembled"; exit 1; }
  if [ -n "$main_sha" ]; then
    vet_main_patch "$patch"
    continue
  fi
  pb=$(yq -r ".patches[] | select(.branch == \"$patch\") | .base // \"\"" "$MANIFEST_WORK")
  [ "$pb" = "$TAG" ] || { echo "::error::$patch is recorded on $pb, not $TAG; it was not rebased"; exit 1; }
  git merge-base --is-ancestor "refs/tags/$TAG" "origin/$patch" || { echo "::error::$patch does not contain $TAG; it was not rebased onto it"; exit 1; }
done < "$state/active"
echo "series: $(tr '\n' ' ' < "$state/active")"
if [ -n "$main_sha" ]; then
  echo "upstream main: $main_sha"
  echo "pinned: $series"
fi

git checkout -q -B "$branch" "$start"
while read -r patch; do
  [ -z "$patch" ] && continue
  # Patches are rebased onto the base, so base..branch is the patch's commits. A patch stacked on an
  # earlier patch in the series (its branch starts from that patch's branch) carries the earlier
  # commits too; they are already applied here, so cherry-pick drops them as empty instead of failing.
  if [ "$(git rev-list --count "$start..origin/$patch")" = 0 ]; then
    echo "::warning::$patch has no commits beyond ${start#refs/tags/} (merged upstream?); skipped"
    continue
  fi
  # A CR in a commit subject must not reach the job log, where it could inject workflow commands.
  git cherry-pick -x --empty=drop "$start..origin/$patch" 2>&1 | tr -d '\r' || { echo "::error::$patch does not apply on ${start#refs/tags/}"; git cherry-pick --abort; exit 1; }
done < "$state/active"
version=${TAG#v}
last=$(git tag -l "v${version}-mercurai.*" | sed 's/.*mercurai\.//' | sort -n | tail -1)
n=$(( ${last:-0} + 1 ))
{
  echo "release_branch=$branch"
  echo "release_tag=v${version}-mercurai.${n}"
  echo "tree=$(git rev-parse 'HEAD^{tree}')"
  if [ -n "$main_sha" ]; then
    echo "upstream_main_sha=$main_sha"
    echo "series=$series"
  fi
} >> "$GITHUB_OUTPUT"
git log --oneline "$start..HEAD" | tr -d '\r'
