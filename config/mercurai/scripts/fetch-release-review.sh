#!/usr/bin/env bash
# Read-only owner-intake evidence. Run only with the trusted controller, outside publisher-token jobs.
set -euo pipefail

expected=${1:?expected qualification JSON is required}
policy=${2:?trusted release policy is required}
review_run=${3:?owner-intake run id is required}
destination=${4:?evidence destination is required}
scripts=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
[[ "$review_run" =~ ^[1-9][0-9]*$ ]] || { echo '::error::review run id is invalid'; exit 1; }
repository=${GITHUB_REPOSITORY:?GitHub repository is required}
[[ "$repository" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$ ]] || exit 1
[[ "$(jq -r '.repository' "$expected")" = "$repository" ]] || exit 1
workflow=$(jq -r '.review.workflowPath' "$policy")
[[ "$workflow" = '.github/workflows/fork-accept-release-review.yml' ]] || exit 1
mkdir -p -- "$destination"

gh api "repos/$repository/actions/workflows/fork-accept-release-review.yml" > "$destination/workflow.json"
workflow_id=$(jq -er --arg path "$workflow" 'select(.path == $path) | .id' "$destination/workflow.json")
[[ "$workflow_id" =~ ^[1-9][0-9]*$ ]] || exit 1
gh api "repos/$repository/actions/runs/$review_run" > "$destination/run.json"
attempt=$(jq -er '.run_attempt' "$destination/run.json")
[[ "$attempt" =~ ^[1-9][0-9]*$ ]] || exit 1
jq --argjson workflow "$workflow_id" --argjson run "$review_run" --argjson attempt "$attempt" \
  --arg ref "$(jq -r '.review.controllerRef' "$policy")" \
  '. + {workflowId:$workflow,runId:$run,attempt:$attempt,controllerRef:$ref}' \
  "$expected" > "$destination/expected.json"

gh api --paginate --slurp "repos/$repository/actions/runs/$review_run/artifacts?per_page=100" \
  > "$destination/artifacts.json"
node "$scripts/release-review.mjs" select "$destination/artifacts.json" "$destination/expected.json" \
  > "$destination/artifact.json"
artifact_id=$(jq -er '.id' "$destination/artifact.json")
[[ "$artifact_id" =~ ^[1-9][0-9]*$ ]] || exit 1
gh api "repos/$repository/actions/artifacts/$artifact_id/zip" > "$destination/review.zip"
archive_sha=$(sha256sum "$destination/review.zip" | cut -d ' ' -f 1)
[[ "sha256:$archive_sha" = "$(jq -r '.digest' "$destination/artifact.json")" ]] || {
  echo '::error::owner-review archive does not match its GitHub digest'; exit 1;
}
[[ "$(unzip -Z1 "$destination/review.zip")" = 'release-review.json' ]] || {
  echo '::error::owner-review archive must contain only release-review.json'; exit 1;
}
unzip -p "$destination/review.zip" release-review.json | head -c 1048577 > "$destination/release-review.json"
[[ $(wc -c < "$destination/release-review.json") -le 1048576 ]] || {
  echo '::error::owner-review JSON exceeds its size limit'; exit 1;
}
jq -n --slurpfile record "$destination/release-review.json" --slurpfile run "$destination/run.json" \
  --slurpfile artifact "$destination/artifact.json" --slurpfile expected "$destination/expected.json" \
  --arg hash "$archive_sha" \
  '{record:$record[0],run:$run[0],artifact:$artifact[0],expected:$expected[0],archiveSha256:$hash}' \
  > "$destination/bundle.json"
node "$scripts/release-review.mjs" verify "$destination/bundle.json" "$policy"
jq 'del(.record)' "$destination/bundle.json" > "$destination/review-context.json"
