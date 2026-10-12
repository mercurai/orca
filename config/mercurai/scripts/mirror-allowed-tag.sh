#!/usr/bin/env bash
# Mirror exactly one upstream release tag the owner approved by name and commit (claude-code-config#1148).
# Upstream cuts release tags on release branches, so they are never inside main and fork-sync-upstream does
# not mirror them on its own; the owner reviews the diff in the tag's `fork-sync tag:` issue and dispatches
# allow_tag=<tag>@<40-hex sha>. Nothing else is pushed: it is an independent, explicitly approved push, so a
# refused main range does not block it, and it does not release the main range either.
# Git only: the caller supplies the credentials for the push.
#
# Env:  ALLOW_TAG (<tag>@<sha>), FORK_STATE_DIR (/tmp). Reads <state>/origin-tags ("sha name" per line, the
#       fork's tags as the run fetched them) and <state>/tags-pushed (tags the automatic mirror pushed this run).
# Out:  <state>/allowed-tag and <state>/allowed-tag-sha (empty when nothing was mirrored).
# Exit: 0 mirrored, or the tag was already mirrored this run; 2 malformed value; 4 upstream's tag does not peel to
#       the approved commit (moved or wrong sha); 5 the fork already holds the tag; 6 the fork's tag list is
#       missing. No push in any failing case.
set -euo pipefail
state=${FORK_STATE_DIR:-/tmp}
: > "$state/allowed-tag"
: > "$state/allowed-tag-sha"
value=${ALLOW_TAG:-}
re='^(v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?)@([0-9a-f]{40})$'
if ! [[ "$value" =~ $re ]]; then
  echo "::error::allow_tag must be <release tag>@<40 lowercase hex sha>"
  exit 2
fi
tag=${BASH_REMATCH[1]} sha=${BASH_REMATCH[3]}
peeled=$(git rev-parse --verify -q "refs/upstream-tags/$tag^{commit}" || true)
if [ "$peeled" != "$sha" ]; then
  echo "::error::upstream's $tag is not at the approved commit $sha; nothing was pushed"
  exit 4
fi
if ! [ -r "$state/origin-tags" ]; then
  echo "::error::the fork's tag list was not fetched; nothing was pushed"
  exit 6
fi
if awk -v t="$tag" '$2 == t { found = 1 } END { exit !found }' "$state/origin-tags"; then
  echo "::error::the fork already holds $tag; a tag is never moved"
  exit 5
fi
if grep -qxF "$tag" "$state/tags-pushed" 2>/dev/null; then
  echo "$tag was already mirrored and handed on this run"
  exit 0
fi
git push origin "refs/upstream-tags/$tag:refs/tags/$tag"
echo "$tag" > "$state/allowed-tag"
echo "$sha" > "$state/allowed-tag-sha"
