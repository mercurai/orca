#!/usr/bin/env bash
# Sourced by rebase-series.sh and assemble-release.sh: the pre-ported patch heads a dispatch names
# (claude-code-config#1123). Git and bash only, and nothing from OVERRIDES reaches a yq expression
# or a command line unvalidated.
#
# In: OVERRIDES ("patch/<name>=<40-hex sha>" pairs separated by commas, spaces or newlines), /tmp/active.
# Out: HEADS, an associative array branch -> sha. Every key must be an active patch of the manifest.
# Fails (exit 1) on a malformed pair, a duplicate or a branch the manifest does not list as active.
declare -A HEADS=()
read -ra _override_pairs <<<"$(printf '%s' "${OVERRIDES:-}" | tr ',\n' '  ')"
for _pair in "${_override_pairs[@]}"; do
  if [[ ! "$_pair" =~ ^(patch/[A-Za-z0-9._/-]+)=([0-9a-f]{40})$ ]]; then
    echo "::error::override '$_pair' is not patch/<name>=<40-hex sha>"
    exit 1
  fi
  _branch=${BASH_REMATCH[1]} _sha=${BASH_REMATCH[2]}
  if ! grep -qxF "$_branch" /tmp/active; then
    echo "::error::override for $_branch, which is not an active patch in the manifest"
    exit 1
  fi
  if [ -n "${HEADS[$_branch]:-}" ]; then
    echo "::error::override for $_branch given twice"
    exit 1
  fi
  HEADS[$_branch]=$_sha
done

# use_head <branch> <base ref>: make the named head local (it may sit on a branch that is not
# patch/*, such as ci-only/*) and check it contains the base. Fails closed otherwise.
use_head() {
  local sha=${HEADS[$1]}
  if ! git cat-file -e "$sha^{commit}" 2>/dev/null; then
    git fetch -q origin "$sha" || { echo "::error::$1: head $sha is not fetchable from origin"; exit 1; }
  fi
  git merge-base --is-ancestor "$2" "$sha" || { echo "::error::$1: override head $sha does not contain $2"; exit 1; }
}
