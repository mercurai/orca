#!/usr/bin/env bash
# Which upstream release tags are new to the fork, and which did upstream move (claude-code-config#1148).
# Release names only (`vX.Y.Z`, `vX.Y.Z-rc.N`): never the fork's own tags (`...-mercurai.N`), and never a name that
# shadows a branch. New: upstream has the name and origin does not. Moved: both have it, pointing apart; those are
# warned about and never mirrored. Reads the refs/upstream-tags namespace and asks origin for its tags.
#
# Env: FORK_STATE_DIR (/tmp). Writes <state>/origin-tags, <state>/upstream-tags ("sha name"), <state>/tags-new
#      (one name per line) and <state>/tags-moved.
set -euo pipefail
state=${FORK_STATE_DIR:-/tmp}
# join needs both lists sorted the way it compares.
export LC_ALL=C
git ls-remote --tags origin | { grep -v '\^{}$' || true; } | sed 's#\trefs/tags/# #' | sort -k2 > "$state/origin-tags"
git for-each-ref --format='%(objectname) %(refname:strip=2)' refs/upstream-tags \
  | (grep -E ' v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$' || true) | sort -k2 > "$state/upstream-tags"
join -1 2 -2 2 -v 1 "$state/upstream-tags" "$state/origin-tags" | awk '{print $1}' > "$state/tags-new"
join -1 2 -2 2 "$state/upstream-tags" "$state/origin-tags" | awk '$2 != $3 {print $1}' > "$state/tags-moved"
if [ -s "$state/tags-moved" ]; then
  echo "::warning::upstream moved tags the fork already holds; they are not mirrored: $(tr '\n' ' ' < "$state/tags-moved")"
fi
echo "new tags: $(tr '\n' ' ' < "$state/tags-new")"
