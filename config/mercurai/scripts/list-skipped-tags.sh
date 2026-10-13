#!/usr/bin/env bash
# List the new release tags sync-push.sh would skip: not inside the pinned commit, or a guarded tree that differs
# from it (claude-code-config#1148). Read-only, so it runs whatever the guard said: each such tag gets a
# `fork-sync tag:` issue for the owner. The test is the same as sync-push.sh's eligible().
#
# Env: UPSTREAM_SHA, FORK_STATE_DIR (/tmp). Reads <state>/tags-new; writes <state>/tags-skipped. A tag the owner
#      allowed this run (<state>/allowed-tag) is not listed.
set -euo pipefail
state=${FORK_STATE_DIR:-/tmp}
: "${UPSTREAM_SHA:?}"
allowed=$(cat "$state/allowed-tag" 2>/dev/null || true)
eligible() {
  git merge-base --is-ancestor "$1" "$UPSTREAM_SHA" && git diff --quiet "$UPSTREAM_SHA" "$1" -- .github config/mercurai
}
: > "$state/tags-skipped"
while read -r tag; do
  if [ -z "$tag" ] || [ "$tag" = "$allowed" ]; then continue; fi
  # A release-named tag upstream points at a tree or a blob has no commit to review or mirror.
  if ! git rev-parse --verify -q "refs/upstream-tags/$tag^{commit}" > /dev/null; then
    echo "::warning::$(printf '%s' "$tag" | LC_ALL=C sed 's#[^A-Za-z0-9._/@+ -]#?#g') does not point at a commit; skipped"
    continue
  fi
  if ! eligible "refs/upstream-tags/$tag^{commit}"; then echo "$tag" >> "$state/tags-skipped"; fi
done < "$state/tags-new"
