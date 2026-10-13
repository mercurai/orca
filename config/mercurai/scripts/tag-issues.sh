#!/usr/bin/env bash
# Open or update the `fork-sync tag: <tag> needs owner review` issue of each new release tag the sync skipped
# (claude-code-config#1148). Upstream decides how many such tags there are and what their names are, so:
#   - at most MAX_NEW new issues and MAX_UPDATES updates per run; the rest is listed in one
#     `fork-sync tag: summary` issue (bounded, sanitised) and picked up by later runs;
#   - the lookup pages through every issue, open or closed (an issue the owner closed stays closed unless the
#     tag's commit changed, and then it is reopened and commented on);
#   - a tag counts as already reported only when the BOT's own issue body or comment names its commit, never a
#     third party's.
# Runs after the merge-forward, from a copy made before it, and must not be able to skip anything: the workflow
# runs it last.
#
# Env: UPSTREAM_SHA, FORK_MAIN (origin/main as the run found it), GUARD_REFUSED, MAIN_MIRRORED (the main mirror
#      step's outcome), FORK_BRANCH, SYNC_ISSUE_LABEL, GH_REPO, FORK_STATE_DIR (/tmp), GH (the gh command, for
#      tests). Reads <state>/tags-new.
set -euo pipefail
state=${FORK_STATE_DIR:-/tmp}
here=$(cd "$(dirname "$0")" && pwd)
gh=${GH:-gh}
: "${UPSTREAM_SHA:?}" "${FORK_MAIN:?}" "${FORK_BRANCH:?}" "${SYNC_ISSUE_LABEL:?}" "${GH_REPO:?}"
MAX_NEW=5
MAX_UPDATES=20
SUMMARY_TITLE="fork-sync tag: summary"

bash "$here/list-skipped-tags.sh"
if [ ! -s "$state/tags-skipped" ]; then exit 0; fi
# The trusted tree: the pin once it is guarded AND the main mirror pushed it, otherwise origin/main as the run found it.
if [ "${GUARD_REFUSED:-true}" = false ] && [ "${MAIN_MIRRORED:-}" = success ]; then trusted=$UPSTREAM_SHA; else trusted=$FORK_MAIN; fi
# The bot's own login, to tell its words from anyone else's. A GitHub App installation token has no user: say so
# once, plainly, and stop before anything is written.
me=$("$gh" api user --jq .login) || {
  echo "::error::tag review issues need a user token; 'gh api user' failed, so FORK_BOT_TOKEN looks like an App installation token"
  exit 1
}
issues=$("$gh" api --paginate "repos/$GH_REPO/issues?state=all&labels=$SYNC_ISSUE_LABEL&per_page=100" \
  --jq '.[] | {number, title, state, login: .user.login, body: (.body // "")}')
# Only the bot's own issues: a third party's issue with the same title is not ours to reuse, edit or reopen.
find_issue() { jq -c -s --arg t "$1" --arg me "$me" '[.[] | select(.title == $t and .login == $me)][0] // empty' <<<"$issues"; }
ensure_label() { "$gh" label create "$SYNC_ISSUE_LABEL" --color d93f0b --description 'fork sync needs a human' 2>/dev/null || true; }
# True when the bot itself wrote this issue's body, or one of its comments, with the exact input that mirrors the tag.
own_mention() {
  local existing=$1 number=$2 mention=$3
  if jq -e --arg me "$me" --arg a "$mention" '.login == $me and (.body | contains($a))' <<<"$existing" > /dev/null; then return 0; fi
  "$gh" api --paginate "repos/$GH_REPO/issues/$number/comments?per_page=100" --jq '.[] | {login: .user.login, body: (.body // "")}' \
    | jq -e -s --arg me "$me" --arg a "$mention" 'any(.[]; .login == $me and (.body | contains($a)))' > /dev/null
}

new=0 updates=0 overflow=() labelled=false
while read -r tag <&3; do
  if [ -z "$tag" ]; then continue; fi
  sha=$(git rev-parse --verify "refs/upstream-tags/$tag^{commit}")
  title="fork-sync tag: $tag needs owner review"
  existing=$(find_issue "$title")
  if [ -z "$existing" ]; then
    if [ "$new" -ge "$MAX_NEW" ]; then overflow+=("$tag $sha"); continue; fi
    if [ "$labelled" = false ]; then ensure_label; labelled=true; fi
    body=$(bash "$here/render-tag-review.sh" "$tag" "$sha" "$trusted" "$FORK_BRANCH")
    "$gh" issue create --label "$SYNC_ISSUE_LABEL" --title "$title" --body "$body"
    new=$((new + 1))
    continue
  fi
  number=$(jq -r .number <<<"$existing")
  mention="allow_tag=$tag@$sha"
  if own_mention "$existing" "$number" "$mention"; then continue; fi
  if [ "$updates" -ge "$MAX_UPDATES" ]; then overflow+=("$tag $sha"); continue; fi
  body=$(bash "$here/render-tag-review.sh" "$tag" "$sha" "$trusted" "$FORK_BRANCH")
  if [ "$(jq -r .state <<<"$existing")" = closed ]; then "$gh" issue reopen "$number"; fi
  "$gh" issue comment "$number" --body "$body"
  updates=$((updates + 1))
done 3< "$state/tags-skipped"

if [ "${#overflow[@]}" -gt 0 ]; then
  # sed prints the first 50 lines but reads all of its input: a head here would exit on SIGPIPE once the list
  # outgrows the pipe buffer, and pipefail would fail the step.
  list=$(printf '%s\n' "${overflow[@]}" | sort | LC_ALL=C sed -n '1,50{s#[^A-Za-z0-9._/@+ -]#?#gp;}')
  body=$(printf '%s release tags need owner review but did not get an issue of their own this run (at most %s new issues and %s updates per run; the rest follow on later runs). First 50, tag and commit:\n\n```\n%s\n```\n' \
    "${#overflow[@]}" "$MAX_NEW" "$MAX_UPDATES" "$list")
  existing=$(find_issue "$SUMMARY_TITLE")
  if [ -z "$existing" ]; then
    ensure_label
    "$gh" issue create --label "$SYNC_ISSUE_LABEL" --title "$SUMMARY_TITLE" --body "$body"
  elif [ "$(jq -r '.body' <<<"$existing")" != "$body" ]; then
    number=$(jq -r .number <<<"$existing")
    if [ "$(jq -r .state <<<"$existing")" = closed ]; then "$gh" issue reopen "$number"; fi
    "$gh" issue edit "$number" --body "$body"
  fi
fi
