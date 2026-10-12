#!/usr/bin/env bash
# The only place fork-sync-upstream pushes upstream's refs (claude-code-config#1148). A pushed workflow file
# is active at once and runs with the repository secrets, so nothing is pushed unless the merge guard passed
# for the one pinned commit, and every ref pushed stands on that commit: main at exactly UPSTREAM_SHA, a tag or
# branch only when its commit is an ancestor of it. Anything else is skipped with a warning. Git only: the
# caller supplies the credentials for the push.
#
# Usage: sync-push.sh main|tags|branches
# Env:   UPSTREAM_SHA (the pinned commit), GUARD_REFUSED (must be exactly "false"; unset counts as refused),
#        FORK_STATE_DIR (/tmp). tags reads <state>/tags-new (one new release tag name per line) and writes
#        <state>/tags-pushed and <state>/rebase-tag (the newest pushed stable tag, else release candidate).
#        branches reads refs/remotes/upstream/*.
# Exit:  3 when the guard refused; no push is made.
set -euo pipefail
state=${FORK_STATE_DIR:-/tmp}
if [ "${GUARD_REFUSED:-true}" != false ]; then
  echo "::error::the merge guard refused this range or did not run; nothing is pushed"
  exit 3
fi
: "${UPSTREAM_SHA:?}"
within() { git merge-base --is-ancestor "$1" "$UPSTREAM_SHA"; }
summary() { if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "$1" >> "$GITHUB_STEP_SUMMARY"; fi; }
display() { printf '%s' "$*" | LC_ALL=C sed 's|[^A-Za-z0-9._/@+ -]|?|g'; }

case "${1:-}" in
  main)
    # A non-fast-forward push fails here on purpose: `main` must never carry fork commits.
    git push origin "$UPSTREAM_SHA:refs/heads/main"
    ;;
  tags)
    : > "$state/tags-pushed"
    : > "$state/rebase-tag"
    refspecs=() skipped=()
    while read -r tag; do
      if [ -z "$tag" ]; then continue; fi
      if within "refs/upstream-tags/$tag^{commit}"; then
        refspecs+=("refs/upstream-tags/$tag:refs/tags/$tag")
        echo "$tag" >> "$state/tags-pushed"
      else
        skipped+=("$tag")
      fi
    done < "$state/tags-new"
    if [ "${#skipped[@]}" -gt 0 ]; then
      msg="tags not mirrored, their commit is not in $UPSTREAM_SHA: $(display "${skipped[*]}")"
      echo "::warning::$msg"; summary "$msg"
    fi
    # New names only, never forced: an existing tag is not rewritten, whatever upstream did.
    if [ "${#refspecs[@]}" -gt 0 ]; then git push origin "${refspecs[@]}"; fi
    # Stable tags win over release candidates; one dispatch per run, the newest tag of the better kind.
    stable=$( (grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' "$state/tags-pushed" || true) | sort -V | tail -1)
    rc=$( (grep -E '^v[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$' "$state/tags-pushed" || true) | sort -V | tail -1)
    echo "${stable:-$rc}" > "$state/rebase-tag"
    ;;
  branches)
    refspecs=() skipped=()
    while read -r sha name; do
      if [ -z "$name" ] || [ "$name" = HEAD ]; then continue; fi
      if within "$sha"; then refspecs+=("$sha:refs/heads/upstream/$name"); else skipped+=("$name"); fi
    done < <(git for-each-ref --format='%(objectname) %(refname:strip=3)' refs/remotes/upstream)
    if [ "${#skipped[@]}" -gt 0 ]; then
      msg="branches not mirrored, their tip is not in $UPSTREAM_SHA: $(display "${skipped[*]}")"
      echo "::warning::$msg"; summary "$msg"
    fi
    if [ "${#refspecs[@]}" -gt 0 ]; then git push origin "${refspecs[@]}"; fi
    ;;
  *)
    echo "usage: sync-push.sh main|tags|branches" >&2
    exit 2
    ;;
esac
