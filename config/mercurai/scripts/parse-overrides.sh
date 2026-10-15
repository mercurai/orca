#!/usr/bin/env bash
# Sourced by rebase-series.sh and assemble-release.sh: the pre-ported patch heads a dispatch names
# (claude-code-config#1123). Git and bash only, and nothing from OVERRIDES reaches a yq expression
# or a command line unvalidated.
#
# In: OVERRIDES ("patch/<name>=<40-hex sha>" pairs separated by commas, spaces or newlines),
# <state>/active, with state the caller's (FORK_STATE_DIR, /tmp by default).
# Out: HEADS, an associative array branch -> sha. Every key must be an active patch of the manifest.
# Fails (exit 1) on a malformed pair, a duplicate or a branch the manifest does not list as active.
state=${state:-${FORK_STATE_DIR:-/tmp}}
declare -A HEADS=()
read -ra _override_pairs <<<"$(printf '%s' "${OVERRIDES:-}" | tr ',\n' '  ')"
_n=0
for _pair in "${_override_pairs[@]}"; do
  _n=$((_n + 1))
  if [[ ! "$_pair" =~ ^(patch/[A-Za-z0-9._/-]+)=([0-9a-f]{40})$ ]]; then
    # The raw input is never echoed: a carriage return in it would reach the runner as a workflow command.
    echo "::error::override #$_n is not patch/<name>=<40-hex sha>"
    exit 1
  fi
  _branch=${BASH_REMATCH[1]} _sha=${BASH_REMATCH[2]}
  if ! grep -qxF "$_branch" "$state/active"; then
    echo "::error::override for $_branch, which is not an active patch in the manifest"
    exit 1
  fi
  if [ -n "${HEADS[$_branch]:-}" ]; then
    echo "::error::override for $_branch given twice"
    exit 1
  fi
  HEADS[$_branch]=$_sha
done

# use_head <branch> <base ref>: check the named head is a ported patch and show what it adds. It must
# be reachable from an origin patch/* or ci-only/* branch (fetched explicitly, never refs/pull/*),
# contain the base and add commits beyond it (a head equal to the base would retire the patch as
# merged). Fails closed otherwise.
#
# Unless DRY_RUN is exactly "true" (a dry run pushes nothing, so any reachable head may be previewed),
# the head must also be bound to a review, because a real run promotes it to patch/* with the bot token:
#  1. the manifest on the workflow branch pins it (`ported_head: <sha>` on the patch's entry), so
#     changing what a real run takes needs a reviewed manifest PR, not a dispatch;
#  2. its .github and config/mercurai trees equal the existing patch's change carried onto the base,
#     applied strictly (no whitespace tolerance), so the port adds or alters nothing protected.
use_head() {
  local sha=${HEADS[$1]}
  if ! git cat-file -e "$sha^{commit}" 2>/dev/null ||
     [ -z "$(git for-each-ref --contains "$sha" --count=1 refs/remotes/origin/patch refs/remotes/origin/ci-only)" ]; then
    echo "::error::$1: head $sha is not on an origin patch/* or ci-only/* branch"; exit 1
  fi
  git merge-base --is-ancestor "$2" "$sha" || { echo "::error::$1: override head $sha does not contain $2"; exit 1; }
  [ "$(git rev-list --count "$2..$sha")" != 0 ] || { echo "::error::$1: override head $sha has no commits beyond $2"; exit 1; }
  if [ "${DRY_RUN:-}" != true ]; then
    require_pinned_head "$1" "$sha"
    require_carried_protected_paths "$1" "$sha" "$2"
  fi
  # Commit subjects are the dispatcher's text: a carriage return in one would reach the runner as a workflow command.
  git log --oneline "$2..$sha" | tr -d '\r'
  git diff --stat "$2...$sha" | tr -d '\r'
}

# require_pinned_head <branch> <sha>: the manifest names exactly this sha as the patch's ported_head.
require_pinned_head() {
  local pin
  pin=$(BRANCH=$1 yq -r '.patches[] | select(.branch == strenv(BRANCH)) | .ported_head // ""' "$MANIFEST_WORK")
  [ "$pin" = "$2" ] || {
    echo "::error::$1: the manifest does not pin ported_head $2 for this patch; a real run takes a reviewed head only (dry_run=true previews an unpinned one)"
    exit 1
  }
}

# require_carried_protected_paths <branch> <sha> <base ref>: the head's .github and config/mercurai
# are the tree the existing origin patch's protected-path diff gives on the base, object for object.
require_carried_protected_paths() {
  local old index diff derived path want got differs=''
  old=$(BRANCH=$1 yq -r '.patches[] | select(.branch == strenv(BRANCH)) | .base // ""' "$MANIFEST_WORK")
  old=${old:-$(yq -r '.base' "$MANIFEST_WORK")}
  index="$state/protected-index" diff="$state/protected.diff"
  rm -f "$index"
  GIT_INDEX_FILE=$index git read-tree "$3^{tree}"
  git diff --binary "$old" "origin/$1" -- .github config/mercurai > "$diff" ||
    { echo "::error::$1: could not read the existing patch's protected-path change"; exit 1; }
  # An empty diff (a patch that changes only application code) leaves the base as it is; git apply rejects empty input.
  if [ -s "$diff" ] && ! GIT_INDEX_FILE=$index git apply --cached "$diff"; then
    echo "::error::$1: the existing patch's .github and config/mercurai change does not apply as is on $3; move patch/${1#patch/} through a reviewed PR"
    exit 1
  fi
  derived=$(GIT_INDEX_FILE=$index git write-tree)
  for path in .github config/mercurai; do
    want=$(git rev-parse -q --verify "$2:$path" 2>/dev/null || true)
    got=$(git rev-parse -q --verify "$derived:$path" 2>/dev/null || true)
    [ "$want" = "$got" ] || differs="$differs $path"
  done
  [ -z "$differs" ] || {
    echo "::error::$1: head $2 changes .github or config/mercurai beyond the existing patch's change; move patch/${1#patch/} through a reviewed PR. Paths that differ:"
    # shellcheck disable=SC2086
    git diff --name-only "$derived" "$2" -- $differs | head -20 | LC_ALL=C tr -c '[:print:]\n' '?' | sed 's/^/  /'
    exit 1
  }
}
