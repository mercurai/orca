#!/usr/bin/env bash
# Mirror exactly one upstream release tag the owner approved by name and commit (claude-code-config#1148).
# Upstream cuts release tags on release branches, so they are never inside main and fork-sync-upstream does
# not mirror them on its own; the owner reviews the diff in the tag's `fork-sync tag:` issue and dispatches
# allow_tag=<tag>@<40-hex sha>. Nothing else is pushed: it is an independent, explicitly approved push, so a
# refused main range does not block it, and it does not release the main range either.
# Git only: the caller supplies the credentials for the push.
#
# A retry is safe: if the push worked but the rebase hand-off after it failed, the same allow_tag finds the
# tag on origin at the approved commit, pushes nothing, and emits the outputs again so the hand-off can run.
# A tag on origin at any other commit is never touched.
#
# The automatic mirror may push the approved tag too, but it hands on only the newest tag, and that dispatch can
# fail: the hand-off is left to it only when it dispatched exactly this tag at this commit.
#
# Env:  ALLOW_TAG (<tag>@<sha>), DISPATCHED_TAG and DISPATCHED_SHA (what the automatic hand-off dispatched this
#       run, set only after it succeeded), FORK_STATE_DIR (/tmp), GITHUB_OUTPUT.
# Out:  <state>/allowed-tag and <state>/allowed-tag-sha (empty when nothing is to be handed on), and the step
#       outputs `tag` and `sha` under the same condition.
# Exit: 0 mirrored, or already on origin at the approved commit (outputs emitted), or already dispatched by the
#       automatic hand-off at the approved commit (no outputs); 2 malformed value; 4 upstream's tag does not
#       peel to the approved commit (moved or wrong sha); 5 origin holds the tag at another commit; 6 origin
#       could not be asked. No push in any failing case.
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
# A release name and a 40-hex sha (matched above), so they cannot carry a workflow command.
hand_on() {
  echo "$tag" > "$state/allowed-tag"
  echo "$sha" > "$state/allowed-tag-sha"
  { echo "tag=$tag"; echo "sha=$sha"; } >> "${GITHUB_OUTPUT:-/dev/null}"
}
peeled=$(git rev-parse --verify -q "refs/upstream-tags/$tag^{commit}" || true)
if [ "$peeled" != "$sha" ]; then
  echo "::error::upstream's $tag is not at the approved commit $sha; nothing was pushed"
  exit 4
fi
if [ "${DISPATCHED_TAG:-}" = "$tag" ] && [ "${DISPATCHED_SHA:-}" = "$sha" ]; then
  echo "$tag at $sha was handed to the rebase by the automatic step this run; nothing more to do"
  exit 0
fi
held=$(git ls-remote origin "refs/tags/$tag" "refs/tags/$tag^{}") || {
  echo "::error::could not ask origin about $tag; nothing was pushed"
  exit 6
}
if [ -n "$held" ]; then
  # An annotated tag lists its commit on the peeled line; a lightweight one on the plain line.
  on_origin=$(awk '$2 ~ /\^\{\}$/ { print $1 }' <<<"$held")
  if [ -z "$on_origin" ]; then on_origin=$(awk 'NR == 1 { print $1 }' <<<"$held"); fi
  if [ "$on_origin" != "$sha" ]; then
    echo "::error::the fork already holds $tag at another commit; a tag is never moved"
    exit 5
  fi
  echo "$tag is already on origin at $sha; nothing is pushed, the hand-off to the rebase can run again"
  hand_on
  exit 0
fi
git push origin "refs/upstream-tags/$tag:refs/tags/$tag"
hand_on
