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
use_head() {
  local sha=${HEADS[$1]}
  if ! git cat-file -e "$sha^{commit}" 2>/dev/null ||
     [ -z "$(git for-each-ref --contains "$sha" --count=1 refs/remotes/origin/patch refs/remotes/origin/ci-only)" ]; then
    echo "::error::$1: head $sha is not on an origin patch/* or ci-only/* branch"; exit 1
  fi
  git merge-base --is-ancestor "$2" "$sha" || { echo "::error::$1: override head $sha does not contain $2"; exit 1; }
  [ "$(git rev-list --count "$2..$sha")" != 0 ] || { echo "::error::$1: override head $sha has no commits beyond $2"; exit 1; }
  # Commit subjects are the dispatcher's text: a carriage return in one would reach the runner as a workflow command.
  git log --oneline "$2..$sha" | tr -d '\r'
  git diff --stat "$2...$sha" | tr -d '\r'
}
