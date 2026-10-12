#!/usr/bin/env bash
# fork-rebase-patches' fetch, shared by its test and push jobs: upstream main, its tags and the
# patch branches, and the base pinned once. Out: output `base`, the commit to rebase onto.
# In: UPSTREAM_REPO, TARGET (empty = upstream/main), TAG_SHA (what fork-sync-upstream saw), GITHUB_OUTPUT.
set -euo pipefail
git config user.name 'mercurai-fork-bot'
git config user.email 'fork-bot@users.noreply.github.com'
git config rerere.enabled true
git remote add upstream "https://github.com/${UPSTREAM_REPO}.git"
git fetch --no-tags upstream main
git fetch upstream --tags --force
git fetch origin '+refs/heads/patch/*:refs/remotes/origin/patch/*'
if [ -z "$TARGET" ]; then
  echo "base=$(git rev-parse --verify upstream/main)" >> "$GITHUB_OUTPUT"
  echo "dry run against upstream/main"
  exit 0
fi
# Pin the target once: upstream re-cut v1.4.224, so one tag name can mean two commits in a day.
target_sha=$(git rev-parse --verify "refs/tags/$TARGET^{commit}")
if [ -n "$TAG_SHA" ] && [ "$TAG_SHA" != "$target_sha" ]; then
  echo "::error::$TARGET now points at $target_sha, not $TAG_SHA as fork-sync-upstream saw it; a human decides"
  exit 1
fi
echo "base=$target_sha" >> "$GITHUB_OUTPUT"
