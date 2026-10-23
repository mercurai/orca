#!/usr/bin/env bash
# Decide whether upstream's range may be merged forward without review. Runs git only and holds no
# token. The range is what the merge would bring in: the diff from the merge base of the fork
# branch and upstream to upstream, so the fork's own files never count. Renames are split into a
# delete and an add (--no-renames) so a file moved into or out of a guarded path shows both names.
# A workflow or fork script upstream edits runs with the fork's secrets once the fork pushes it, so
# such a range waits for the owner (claude-code-config#1148). Scripts under
# config/scripts/ are included because privileged workflows execute them with
# the fork token.
#
# Usage: merge-guard.sh <fork ref> <upstream commit> [<extra ref>...]
#        The guarded set is the union of the ranges from the merge base of each ref and the commit: the
#        fork ref is what a merge-forward brings in, an extra ref (origin/main) is what a mirror publishes.
# Out:   stdout lists the guarded paths, at most 50, odd characters shown as ? (upstream picks the
#        names). Exit 0: merge. Exit 3: refused. Exit 4: guarded, but the owner allowed this commit.
# Env:   ALLOWED_SHA, the full sha of the upstream commit the owner reviewed; any other value, a
#        short sha, or a sha that is not <upstream commit> allows nothing.
set -euo pipefail
fork=$1 upstream=$2
shift 2
paths=$(
  for ref in "$fork" "$@"; do
    base=$(git merge-base "$ref" "$upstream") || exit 1
    # errexit is off inside $( ): a diff that fails (an unreadable tree) must not read as "nothing changed".
    git diff --name-only --no-renames -z "$base" "$upstream" | tr '\0' '\n' || exit 1
  done | { grep -E '^(\.github/|config/mercurai/|config/scripts/)' || true; } | sort -u
)
if [ -z "$paths" ]; then
  echo "no guarded path in the range to $upstream"
  exit 0
fi
count=$(printf '%s\n' "$paths" | wc -l)
head -50 <<<"$paths" | LC_ALL=C sed 's|[^A-Za-z0-9._/@+ -]|?|g'
if [ "$count" -gt 50 ]; then echo "... and $((count - 50)) more"; fi
sha=$(git rev-parse "$upstream^{commit}")
if [[ "${ALLOWED_SHA:-}" =~ ^[0-9a-f]{40}$ && "$ALLOWED_SHA" = "$sha" ]]; then
  echo "::warning::$count guarded path(s) in the range; merging because the owner allowed $sha"
  exit 4
fi
exit 3
