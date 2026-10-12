#!/usr/bin/env bash
# After a merge, list the guarded paths it changed against the branch as it will be pushed. merge-guard.sh
# judges the range from one merge base; this judges the result, so a base that moved since, or a
# criss-cross history that makes the merge pick another base, cannot change a workflow or fork script
# unseen (claude-code-config#1148). Run it from a copy: the merged tree may hold upstream's version.
#
# Usage: merge-result-guard.sh <ref the branch had before the merge>
# Out:   stdout lists the changed guarded paths, at most 50, odd characters shown as ?.
#        Exit 0: none. Exit 3: some. Other: error.
set -euo pipefail
paths=$(git diff --name-only --no-renames -z "$1" HEAD -- .github/workflows config/mercurai | tr '\0' '\n')
if [ -z "$paths" ]; then exit 0; fi
count=$(printf '%s\n' "$paths" | wc -l)
printf '%s\n' "$paths" | head -50 | LC_ALL=C sed 's|[^A-Za-z0-9._/@+ -]|?|g'
if [ "$count" -gt 50 ]; then echo "... and $((count - 50)) more"; fi
exit 3
