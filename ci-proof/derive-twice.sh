#!/usr/bin/env bash
# SEC-201 proof: the push jobs re-derive what the test jobs tested, so two runs of the shared
# scripts on the same inputs must produce the same trees. Runs assemble-release.sh on the
# manifest's base and rebase-series.sh onto v1.4.224, twice each, in fresh clones; fails on
# any difference. Usage (repo root of a checkout carrying the scripts): derive-twice.sh <work dir>
set -euo pipefail
W=$PWD
S=$1
mkdir -p "$S"

run_one() {
  local dir=$1
  rm -rf "$dir"
  git clone -q --no-checkout https://github.com/mercurai/orca "$dir"
  cd "$dir"
  git checkout -q -B mercurai origin/mercurai
  export UPSTREAM_REPO=stablyai/orca MANIFEST=config/mercurai/patches.yaml MANIFEST_WORK=$dir.manifest.yaml
  TAG=$(yq -r '.base' "$MANIFEST")
  export TAG
  : > "$dir.assemble.out"
  GITHUB_OUTPUT=$dir.assemble.out bash "$W/config/mercurai/scripts/assemble-release.sh"
  git checkout -q mercurai
  git remote remove upstream 2>/dev/null || true
  cp "$MANIFEST" "$MANIFEST_WORK"
  yq -r '.patches[] | select(.status == "upstream-open" or .status == "ours-only") | .branch' "$MANIFEST_WORK" > /tmp/active
  : > "$dir.fetch.out"
  TARGET=v1.4.224 TAG_SHA='' GITHUB_OUTPUT=$dir.fetch.out bash "$W/config/mercurai/scripts/fetch-rebase-inputs.sh"
  BASE=$(sed -n 's/^base=//p' "$dir.fetch.out") bash "$W/config/mercurai/scripts/rebase-series.sh"
  : > "$dir.trees"
  while read -r branch _before after; do
    echo "$branch $(git rev-parse "$after^{tree}") $after" >> "$dir.trees"
  done < /tmp/rebased
  cp /tmp/conflicted "$dir.conflicted"
  cp /tmp/merged "$dir.merged"
  cd "$W"
}

run_one "$S/a"
sleep 3
run_one "$S/b"

echo "== assemble outputs (run a, run b)"
cat "$S/a.assemble.out" "$S/b.assemble.out"
echo "== rebase onto v1.4.224: branch tree commit (run a, run b)"
cat "$S/a.trees"
echo "--"
cat "$S/b.trees"
echo "== conflicted (run a)"
cat "$S/a.conflicted"
echo "== merged (run a)"
cat "$S/a.merged"

status=0
if [ "$(grep '^tree=' "$S/a.assemble.out")" = "$(grep '^tree=' "$S/b.assemble.out")" ] && grep -q '^tree=' "$S/a.assemble.out"; then
  echo "PASS assemble trees equal"
else
  echo "FAIL assemble trees differ"; status=1
fi
if [ -s "$S/a.trees" ] && [ "$(cut -d' ' -f1,2 "$S/a.trees")" = "$(cut -d' ' -f1,2 "$S/b.trees")" ]; then
  echo "PASS rebase trees equal ($(wc -l < "$S/a.trees") branches)"
else
  echo "FAIL rebase trees differ or none rebased"; status=1
fi
if cmp -s "$S/a.conflicted" "$S/b.conflicted" && cmp -s "$S/a.merged" "$S/b.merged"; then
  echo "PASS conflicts and merged lists equal"
else
  echo "FAIL conflicts or merged lists differ"; status=1
fi
if [ "$(cut -d' ' -f3 "$S/a.trees")" = "$(cut -d' ' -f3 "$S/b.trees")" ]; then
  echo "note: commit shas are equal too"
else
  echo "note: commit shas differ (committer dates), which is why the push jobs compare trees"
fi
exit "$status"
