#!/usr/bin/env bash
# Print the body of a tag's `fork-sync tag:` issue (claude-code-config#1148): what the tag changes under
# .github/ and config/mercurai/ against the trusted tree, and the exact input that mirrors it. Git only.
# Upstream picks the path names, so every list is printed with odd characters as ?, at most 50 lines, and
# cannot break out of the fence.
#
# Usage: render-tag-review.sh <tag> <tag commit sha> <trusted commit> <fork branch>
set -euo pipefail
tag=$1 sha=$2 trusted=$3 branch=$4
clean() { LC_ALL=C sed 's#[^A-Za-z0-9._/@+ |=>{}()-]#?#g'; }
names=$(git diff --name-only --no-renames -z "$trusted" "$sha" -- .github config/mercurai | tr '\0' '\n')
count=$(printf '%s' "$names" | grep -c . || true)
full_stat=$(git diff --stat=200 --no-renames "$trusted" "$sha" -- .github config/mercurai)
stat=$(head -50 <<<"$full_stat" | clean)
list=$(head -50 <<<"$names" | clean)
printf 'Release tag `%s` (commit `%s`) was not mirrored: its commit is not inside the pinned upstream commit, or its `.github/` or `config/mercurai/` tree differs from the trusted one (`%s`). Upstream cuts release tags on release branches, so a new release normally lands here.\n\n' \
  "$tag" "$sha" "$trusted"
printf 'Changes under `.github/` and `config/mercurai/` against the trusted tree (`git diff --stat`, first 50 lines, odd characters shown as ?):\n\n```\n%s\n```\n\n' "$stat"
printf 'Paths (first 50 of %s):\n\n```\n%s\n```\n\n' "$count" "$list"
printf 'Pushing this tag runs its push workflows with the repository secrets. Review the diff, then mirror exactly this tag, from `%s`:\n\n```\ngh workflow run fork-sync-upstream.yml --ref %s -f allow_tag=%s@%s\n```\n\n' \
  "$branch" "$branch" "$tag" "$sha"
printf 'Dispatch it only yourself, or from a lane the owner'"'"'s orchestrator orders after a security review of this diff. It mirrors that tag at that commit and nothing else, then hands it to fork-rebase-patches; a moved tag or a different sha pushes nothing and fails the run.\n'
