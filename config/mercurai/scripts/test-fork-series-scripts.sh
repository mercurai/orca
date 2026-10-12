#!/usr/bin/env bash
# Local tests for push-rebased-series.sh and carry-ci-base.sh against throwaway repos.
# Usage: bash config/mercurai/scripts/test-fork-series-scripts.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
export PUSH_RETRY_SLEEP=0 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
fails=0
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; fails=$((fails + 1)); }
commit() { echo "$2" > "$1"; git add "$1"; git commit -qm "$3"; }
remote_sha() { git --git-dir="$root/origin.git" rev-parse "refs/heads/$1"; }
remote_has() { git --git-dir="$root/origin.git" merge-base --is-ancestor "$1" "$2"; }

setup() {
  rm -rf "$root/origin.git" "$root/work"
  git init -q --bare "$root/origin.git"
  git init -q -b fork "$root/work"
  cd "$root/work"
  git remote add origin "$root/origin.git"
  commit base.txt v1 "upstream v1"; git tag v1
  commit base.txt v2 "upstream v2"; git tag v2
  commit manifest.yaml "base: v1" "manifest"
  git push -q origin fork:mercurai v1:refs/tags/v1 v2:refs/tags/v2
  for p in a b; do
    git checkout -q -b "patch/$p" v1; commit "$p.txt" "$p" "patch $p"
    git push -q origin "patch/$p"
  done
  git checkout -q fork
}

rebase_series() {  # rebases patch/a and patch/b onto v2 locally, commits the manifest locally
  : > "$root/rebased"
  for p in a b; do
    before=$(git rev-parse "patch/$p"); git checkout -q "patch/$p"; git rebase -q --onto v2 v1
    echo "patch/$p $before $(git rev-parse HEAD)" >> "$root/rebased"
  done
  git checkout -q fork; echo "base: v2" > manifest.yaml; git commit -qam "manifest v2"
  manifest=$(git rev-parse HEAD)
}

# 1. Everything moves together.
setup; rebase_series
bash "$here/push-rebased-series.sh" "$root/rebased" mercurai "$manifest" >/dev/null
if remote_has v2 "$(remote_sha patch/a)" && remote_has v2 "$(remote_sha patch/b)" &&
   [ "$(git --git-dir="$root/origin.git" show mercurai:manifest.yaml)" = "base: v2" ]; then
  pass "atomic push moves every patch and the manifest"; else fail "atomic push moves every patch and the manifest"; fi

# 2. Someone moved patch/b on the remote after we read it: nothing moves.
setup
a0=$(remote_sha patch/a) m0=$(remote_sha mercurai)
rebase_series
git checkout -q -b other "$(remote_sha patch/b)"; commit extra.txt x "someone else"; git push -q origin other:patch/b
b1=$(remote_sha patch/b); git checkout -q fork
if bash "$here/push-rebased-series.sh" "$root/rebased" mercurai "$manifest" >/dev/null 2>&1; then fail "a stale lease pushes nothing"
elif [ "$(remote_sha patch/a)" = "$a0" ] && [ "$(remote_sha patch/b)" = "$b1" ] && [ "$(remote_sha mercurai)" = "$m0" ]; then
  pass "a stale lease pushes nothing"; else fail "a stale lease pushes nothing"; fi

# 3. The fork branch moved (a merge-forward): the manifest commit replays on top of it.
setup; rebase_series
git checkout -q -b mover "$(remote_sha mercurai)"; commit other.txt y "merge-forward"; git push -q origin mover:mercurai
moved=$(remote_sha mercurai); git checkout -q fork
bash "$here/push-rebased-series.sh" "$root/rebased" mercurai "$manifest" >/dev/null
if remote_has "$moved" "$(remote_sha mercurai)" && [ "$(git --git-dir="$root/origin.git" show mercurai:manifest.yaml)" = "base: v2" ] &&
   remote_has v2 "$(remote_sha patch/a)" && remote_has v2 "$(remote_sha patch/b)"; then
  pass "a moved fork branch keeps its commit and gains the manifest"; else fail "a moved fork branch keeps its commit and gains the manifest"; fi

# ci-base fixtures: ci-base/v1 = v1 + two fork-CI commits.
ci_setup() {
  setup
  git checkout -q -b ci1 v1; commit ci.yml "fetch pinned" "ci: fetch"; commit ci2.yml "tmpdir" "ci: tmpdir"
  git push -q origin ci1:refs/heads/ci-base/v1; git checkout -q fork
}
carried() { [ "$(git --git-dir="$root/origin.git" rev-list --count "v2..refs/heads/ci-base/v2")" = "$1" ] && remote_has v2 refs/heads/ci-base/v2; }

# 4. No ci-base/v2 yet: created on v2 with both commits.
ci_setup
bash "$here/carry-ci-base.sh" v1 v2 "$(git rev-parse v2)" >/dev/null
if carried 2; then pass "creates ci-base/<new> with the fork-CI commits"; else fail "creates ci-base/<new> with the fork-CI commits"; fi

# 5. A bare ci-base/v2 exists: it gains both commits as a fast-forward.
ci_setup; git push -q origin v2:refs/heads/ci-base/v2; bare=$(remote_sha ci-base/v2)
bash "$here/carry-ci-base.sh" v1 v2 "$(git rev-parse v2)" >/dev/null
if carried 2 && remote_has "$bare" refs/heads/ci-base/v2; then pass "carries the commits onto an existing bare ci-base"; else fail "carries the commits onto an existing bare ci-base"; fi

# 6. Rerun: nothing changes.
before=$(remote_sha ci-base/v2)
bash "$here/carry-ci-base.sh" v1 v2 "$(git rev-parse v2)" >/dev/null
if [ "$(remote_sha ci-base/v2)" = "$before" ] && carried 2; then pass "a rerun is a no-op"; else fail "a rerun is a no-op"; fi

# 7. A fork-CI commit that conflicts with the new tag: fails and pushes nothing.
ci_setup
git checkout -q -b up v2; commit ci.yml "upstream changed it" "upstream ci"; git tag v3; git push -q origin v3:refs/tags/v3; git checkout -q fork
if bash "$here/carry-ci-base.sh" v1 v3 "$(git rev-parse v3)" >/dev/null 2>&1; then fail "a conflicting carry fails and pushes nothing"
elif ! git --git-dir="$root/origin.git" rev-parse -q --verify refs/heads/ci-base/v3 >/dev/null; then
  pass "a conflicting carry fails and pushes nothing"; else fail "a conflicting carry fails and pushes nothing"; fi

# 8. A rerun after upstream changed the lines around a carried change: no duplicate pick, no failure.
setup
git checkout -q -b old-b v1; printf 'a
b
c
d
e
' > ctx.yml; git add ctx.yml; git commit -qm "upstream ctx"; git tag v1b
git checkout -q -b ci1b v1b; printf 'a
b
c
FORK
e
' > ctx.yml; git commit -qam "ci: fork line"
git checkout -q -b up4 v1b; printf 'A-upstream
b
c
d
e
' > ctx.yml; git commit -qam "upstream edits a line inside the carried hunk's context"; git tag v4
git push -q origin v1b:refs/tags/v1b v4:refs/tags/v4 ci1b:refs/heads/ci-base/v1b; git checkout -q fork
bash "$here/carry-ci-base.sh" v1b v4 "$(git rev-parse v4)" >/dev/null
first=$(remote_sha ci-base/v4)
if bash "$here/carry-ci-base.sh" v1b v4 "$(git rev-parse v4)" >/dev/null 2>&1 && [ "$(remote_sha ci-base/v4)" = "$first" ] &&
   [ "$(git --git-dir="$root/origin.git" rev-list --count v4..refs/heads/ci-base/v4)" = 1 ]; then
  pass "a rerun skips a commit whose surroundings changed"; else fail "a rerun skips a commit whose surroundings changed"; fi

# 9. No old ci-base: publishes the bare tag with a warning.
setup
out=$(bash "$here/carry-ci-base.sh" v1 v2 "$(git rev-parse v2)" 2>&1 >/dev/null || true)
if [ "$(remote_sha ci-base/v2)" = "$(git rev-parse v2)" ] && echo "$out" | grep -q "::warning::"; then
  pass "a missing old ci-base warns and publishes the bare tag"; else fail "a missing old ci-base warns and publishes the bare tag"; fi

# 10. The manifest commit does not apply to the moved fork branch: an error, nothing pushed.
setup; rebase_series
a0=$(remote_sha patch/a)
git checkout -q -b clash "$(remote_sha mercurai)"; echo "base: hand-edited" > manifest.yaml; git commit -qam "human edit"; git push -q origin clash:mercurai
m1=$(remote_sha mercurai); git checkout -q fork
if bash "$here/push-rebased-series.sh" "$root/rebased" mercurai "$manifest" >/dev/null 2>&1; then fail "a manifest conflict pushes nothing"
elif [ "$(remote_sha patch/a)" = "$a0" ] && [ "$(remote_sha mercurai)" = "$m1" ]; then pass "a manifest conflict pushes nothing"; else fail "a manifest conflict pushes nothing"; fi

# 11. A branch the run left unchanged but someone moved: its lease rejects the whole push.
setup; rebase_series
b_before=$(awk '$1 == "patch/b" {print $2}' "$root/rebased")
awk '$1 == "patch/b" {print $1, $2, $2; next} {print}' "$root/rebased" > "$root/rebased2"   # b unchanged by the run
a0=$(remote_sha patch/a) m0=$(remote_sha mercurai)
git checkout -q -b mover2 "$b_before"; commit late.txt z "late push"; git push -q origin mover2:patch/b; git checkout -q fork
if bash "$here/push-rebased-series.sh" "$root/rebased2" mercurai "$manifest" >/dev/null 2>&1; then fail "an unchanged branch is leased too"
elif [ "$(remote_sha patch/a)" = "$a0" ] && [ "$(remote_sha mercurai)" = "$m0" ]; then pass "an unchanged branch is leased too"; else fail "an unchanged branch is leased too"; fi

# 11b. The same unchanged-branch lease when nobody moved it: the other refs and the manifest go through.
setup; rebase_series
awk '$1 == "patch/b" {print $1, $2, $2; next} {print}' "$root/rebased" > "$root/rebased3"
b0=$(remote_sha patch/b)
bash "$here/push-rebased-series.sh" "$root/rebased3" mercurai "$manifest" >/dev/null
if remote_has v2 "$(remote_sha patch/a)" && [ "$(remote_sha patch/b)" = "$b0" ] &&
   [ "$(git --git-dir="$root/origin.git" show mercurai:manifest.yaml)" = "base: v2" ]; then
  pass "an untouched leased branch lets the rest of the series through"; else fail "an untouched leased branch lets the rest of the series through"; fi

# 12. Patches only, no manifest change.
setup; rebase_series; m0=$(remote_sha mercurai)
bash "$here/push-rebased-series.sh" "$root/rebased" mercurai "" >/dev/null
if remote_has v2 "$(remote_sha patch/a)" && [ "$(remote_sha mercurai)" = "$m0" ]; then pass "patches alone push without a manifest commit"; else fail "patches alone push without a manifest commit"; fi

# Hand-ported heads (claude-code-config#1123). The scripts read and write /tmp/active, /tmp/rebased and the
# like, and need yq, as the workflows do. Heads sit on ci-only/* branches, as a ported head does before it moves patch/*.
ported_setup() {
  setup
  { echo "base: v1"; echo "release_branch: release/test"; echo "patches:"
    for p in a b; do printf '  - branch: patch/%s\n    base: v1\n    status: ours-only\n' "$p"; done; } > "$root/patches.yaml"
  git --git-dir="$root/origin.git" config uploadpack.allowAnySHA1InWant true
  for p in a b; do
    git checkout -q -b "ported-$p" v2; commit "$p.txt" "$p" "ported $p"; git push -q origin "ported-$p:refs/heads/ci-only/$p"
  done
  pa=$(git rev-parse ported-a) pb=$(git rev-parse ported-b)
  git checkout -q -b onv1 v1; commit z.txt z "head on the old base"; stale=$(git rev-parse HEAD)
  git push -q origin onv1:refs/heads/ci-only/z; git checkout -q fork
  git tag v2.0.0 v2; git push -q origin refs/tags/v2.0.0   # assemble-release takes stable vX.Y.Z tags only
  printf 'patch/a\npatch/b\n' > /tmp/active
}
runner_clone() {  # a runner checkout: only the fork branch and the patch branches, so a ported head must be fetched
  rm -rf "$root/runner"; git clone -q --single-branch --branch mercurai "$root/origin.git" "$root/runner"; cd "$root/runner"
  git fetch -q origin '+refs/heads/patch/*:refs/remotes/origin/patch/*'
  export BASE=$(git rev-parse v2) MANIFEST_WORK="$root/patches.yaml"
}
line_of() { awk -v b="$1" '$1 == b' /tmp/rebased; }
rebase_with() { OVERRIDES="$1" bash "$here/rebase-series.sh" >"$root/rebase.out" 2>&1; }

# 13. A ported head replaces the rebase, is fetched by sha, and is leased on the branch's old sha; the rest rebases.
ported_setup; a0=$(remote_sha patch/a); runner_clone
if rebase_with "patch/a=$pa" && [ "$(line_of patch/a)" = "patch/a $a0 $pa" ] &&
   [ "$(line_of patch/b | cut -d' ' -f3)" != "$(remote_sha patch/b)" ] && git merge-base --is-ancestor v2 "$(line_of patch/b | cut -d' ' -f3)"; then
  pass "a ported head is used instead of rebasing"; else fail "a ported head is used instead of rebasing"; fi

# 14. The ported head goes out in the same atomic push as the rebased patches.
if bash "$here/push-rebased-series.sh" /tmp/rebased mercurai "" >/dev/null && [ "$(remote_sha patch/a)" = "$pa" ] && remote_has v2 "$(remote_sha patch/b)"; then
  pass "a ported head is pushed with the series"; else fail "a ported head is pushed with the series"; fi

# 15. A head that does not contain the base fails closed.
ported_setup; runner_clone
if rebase_with "patch/a=$stale"; then fail "a head without the base fails"
elif grep -q "does not contain" "$root/rebase.out"; then pass "a head without the base fails"; else fail "a head without the base fails"; fi

# 16. Malformed, unlisted, duplicate and unfetchable overrides all fail before anything is pushed.
ported_setup; runner_clone
bad_ok=1
for bad in "patch/a=${pa:0:12}" "patch/a=$pa;touch $root/pwned" "patch/c=$pa" "patch/a=$pa patch/a=$pb" "origin/a=$pa" "patch/a=$(printf '0%.0s' {1..40})"; do
  if rebase_with "$bad"; then bad_ok=0; echo "accepted: $bad"; fi
done
if [ "$bad_ok" = 1 ] && [ ! -e "$root/pwned" ]; then pass "bad overrides fail closed"; else fail "bad overrides fail closed"; fi

# 17. No overrides: the series rebases as before.
ported_setup; runner_clone
if rebase_with "" && [ "$(line_of patch/a | cut -d' ' -f3)" != "$pa" ] && [ "$(wc -l < /tmp/rebased)" = 2 ]; then
  pass "without overrides every patch rebases"; else fail "without overrides every patch rebases"; fi

assemble_with() {  # TAG v2 against a manifest still recorded on v1, as before the series is pushed
  export GITHUB_OUTPUT="$root/out" MANIFEST="$root/patches.yaml" MANIFEST_WORK="$root/manifest-work.yaml" TAG=v2.0.0 UPSTREAM_REPO=test/up
  : > "$GITHUB_OUTPUT"
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="url.$root/origin.git.insteadOf" GIT_CONFIG_VALUE_0=https://github.com/test/up.git \
    OVERRIDES="$1" bash "$here/assemble-release.sh" >"$root/assemble.out" 2>&1 || { sed 's/^/  assemble: /' "$root/assemble.out"; return 1; }
}

# 18. Without overrides an unrebased series does not assemble.
ported_setup
if assemble_with ""; then fail "an unrebased series does not assemble"
elif grep -q "manifest base is v1" "$root/assemble.out"; then pass "an unrebased series does not assemble"; else fail "an unrebased series does not assemble"; fi

# 19. Ported heads for the whole series assemble on the tag before any patch/* ref moves.
ported_setup
if assemble_with "patch/a=$pa,patch/b=$pb" && [ "$(git rev-list --count v2..release/test)" = 2 ] &&
   [ "$(git show release/test:a.txt)" = a ] && [ "$(git show release/test:b.txt)" = b ]; then
  pass "ported heads assemble before patch/* moves"; else fail "ported heads assemble before patch/* moves"; fi

# 20. A patch without an override still has to be rebased.
ported_setup
if assemble_with "patch/a=$pa"; then fail "an unrebased patch beside an override fails"
elif grep -q "recorded on v1" "$root/assemble.out"; then pass "an unrebased patch beside an override fails"; else fail "an unrebased patch beside an override fails"; fi

# 21. An overridden assembly head must contain the tag.
ported_setup
if assemble_with "patch/a=$stale,patch/b=$pb"; then fail "an assembly head without the tag fails"
elif grep -q "does not contain" "$root/assemble.out"; then pass "an assembly head without the tag fails"; else fail "an assembly head without the tag fails"; fi

echo "$fails failure(s)"
[ "$fails" -eq 0 ]
