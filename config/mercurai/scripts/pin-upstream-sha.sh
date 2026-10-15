#!/usr/bin/env bash
# Print the one upstream commit a fork-sync-upstream run guards, mirrors and merges (claude-code-config#1148).
# That is the tip of <upstream ref>, unless the owner's ALLOWED_SHA is a full sha that is an ancestor of it:
# then the commit the owner reviewed lands even though upstream moved on, and the newer commits wait for
# the next run. Git only, no token.
#
# Usage: pin-upstream-sha.sh <upstream ref>
# Env:   ALLOWED_SHA (set only by an explicit dispatch)
set -euo pipefail
tip=$(git rev-parse "$1^{commit}")
allowed=${ALLOWED_SHA:-}
if [[ "$allowed" =~ ^[0-9a-f]{40}$ ]] && git cat-file -e "$allowed^{commit}" 2>/dev/null && git merge-base --is-ancestor "$allowed" "$tip"; then
  echo "$allowed"
else
  echo "$tip"
fi
