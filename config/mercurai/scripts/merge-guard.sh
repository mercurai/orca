#!/usr/bin/env bash
# Decide whether upstream's range may be merged forward without review. Runs git only and holds no
# token. The range is what the merge would bring in: the diff from the merge base of the fork
# branch and upstream to upstream, so the fork's own files never count. Renames are split into a
# delete and an add (--no-renames) so a file moved into or out of a guarded path shows both names.
# A workflow or fork script upstream edits runs with the fork's secrets once the fork pushes it, so
# such a range waits for the owner (claude-code-config#1148).
#
# Usage: merge-guard.sh <fork ref> <upstream ref>
# Out:   stdout lists the guarded paths, at most 50. Exit 0: merge. Exit 3: refused. Other: error.
# Env:   ALLOW_GUARDED_MERGE=true lists the paths and exits 0 (the owner reviewed the range).
set -euo pipefail
fork=$1 upstream=$2
base=$(git merge-base "$fork" "$upstream")
paths=$(git diff --name-only --no-renames -z "$base" "$upstream" | tr '\0' '\n' | { grep -E '^(\.github/workflows/|config/mercurai/)' || true; } | sort -u)
if [ -z "$paths" ]; then
  echo "no guarded path in $base..$upstream"
  exit 0
fi
count=$(echo "$paths" | wc -l)
echo "$paths" | head -50
if [ "$count" -gt 50 ]; then echo "... and $((count - 50)) more"; fi
if [ "${ALLOW_GUARDED_MERGE:-}" = "true" ]; then
  echo "::warning::$count guarded path(s) in the range; merging because the owner allowed it"
  exit 0
fi
exit 3
