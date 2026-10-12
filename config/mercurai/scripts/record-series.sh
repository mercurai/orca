#!/usr/bin/env bash
# Record a rebased series in the working copy of the manifest: the new base on every rebased patch
# and on the manifest, and merged-upstream on the patches the base already carries. fork-rebase-patches
# runs it in its push job before committing the manifest, and in a dry run to print the change.
# Values reach yq as strings through strenv, never as expression text.
# In: MANIFEST_WORK, TARGET, FORK_STATE_DIR (default /tmp) with its rebased and merged files.
set -euo pipefail
state=${FORK_STATE_DIR:-/tmp}

while read -r branch _before _after; do
  if grep -qxF "$branch" "$state/merged"; then
    BRANCH=$branch yq -i '(.patches[] | select(.branch == strenv(BRANCH)) | .status) = "merged-upstream"' "$MANIFEST_WORK"
  else
    BRANCH=$branch yq -i '(.patches[] | select(.branch == strenv(BRANCH)) | .base) = strenv(TARGET)' "$MANIFEST_WORK"
  fi
done < "$state/rebased"
yq -i '.base = strenv(TARGET)' "$MANIFEST_WORK"
