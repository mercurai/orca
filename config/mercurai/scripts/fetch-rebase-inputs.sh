#!/usr/bin/env bash
# fork-rebase-patches' fetch, shared by its test and push jobs: upstream main, the target tag from
# the fork (fork-sync-upstream mirrors it first) and the patch branches, and the base pinned once.
# Out: output `base`, the commit to rebase onto.
# In: UPSTREAM_REPO, TARGET (empty = upstream/main), TAG_SHA (what fork-sync-upstream saw), GITHUB_OUTPUT.
set -euo pipefail
git config user.name 'mercurai-fork-bot'
git config user.email 'fork-bot@users.noreply.github.com'
git config rerere.enabled true
git remote add upstream "https://github.com/${UPSTREAM_REPO}.git"
git fetch --no-tags upstream main
git fetch origin '+refs/heads/patch/*:refs/remotes/origin/patch/*'
if [ -z "$TARGET" ]; then
  echo "base=$(git rev-parse --verify upstream/main)" >> "$GITHUB_OUTPUT"
  echo "dry run against upstream/main"
  exit 0
fi
# The tag later lands in the manifest and the pushed refs: release and release-candidate names only.
if [[ ! "$TARGET" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]]; then
  echo "::error::tag '$TARGET' is not v<major>.<minor>.<patch> or a -rc.<n> of one"
  exit 1
fi
# The fork's tag, never upstream's: assemble-release reads the fork's tags only, and upstream
# re-cut v1.4.224, so one name can mean two commits. Rebase and assembly must agree on the commit.
git fetch --no-tags origin "+refs/tags/$TARGET:refs/tags/$TARGET" ||
  { echo "::error::the fork has no tag $TARGET; fork-sync-upstream mirrors it first"; exit 1; }
# Pin the target once.
target_sha=$(git rev-parse --verify "refs/tags/$TARGET^{commit}")
if [ -n "$TAG_SHA" ] && [ "$TAG_SHA" != "$target_sha" ]; then
  echo "::error::$TARGET now points at $target_sha, not $TAG_SHA as fork-sync-upstream saw it; a human decides"
  exit 1
fi
echo "base=$target_sha" >> "$GITHUB_OUTPUT"
