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
# Public issue text names no internal session, model or role.
internal_names() { grep -qiE 'orca-config-0f|opus|sonnet|\blane\b|orchestrat' "$1"; }
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

# 7b. A CR in the subject of the conflicting fork-CI commit never reaches the log (git echoes it in "could not apply").
setup
git checkout -q -b ci1c v1; commit ci.yml fetch $'ci: evil\r::error::injected'; git push -q origin ci1c:refs/heads/ci-base/v1
git checkout -q -b up5 v2; commit ci.yml "upstream changed it" "upstream ci"; git tag v5; git push -q origin v5:refs/tags/v5; git checkout -q fork
rc=0; bash "$here/carry-ci-base.sh" v1 v5 "$(git rev-parse v5)" > "$root/carry.out" 2>&1 || rc=$?
if [ "$rc" != 0 ] && grep -q evil "$root/carry.out" && ! grep -q $'\r' "$root/carry.out"; then
  pass "carry-ci-base strips CR from git's cherry-pick output"; else fail "carry-ci-base strips CR from git's cherry-pick output"; cat -v "$root/carry.out"; fi
# 7c. Current git prints a control character in a subject as "?"; a git that does not must still not reach the log with a CR.
real_git=$(command -v git); mkdir -p "$root/oldgit"
cat > "$root/oldgit/git" <<EOF
#!/bin/sh
if [ "\$1" = cherry-pick ] && [ "\$2" = -x ]; then "$real_git" "\$@"; rc=\$?; printf 'error: could not apply x... ci: evil\r::error::injected\n' >&2; exit \$rc; fi
exec "$real_git" "\$@"
EOF
chmod +x "$root/oldgit/git"
rc=0; PATH="$root/oldgit:$PATH" bash "$here/carry-ci-base.sh" v1 v5 "$(git rev-parse v5)" > "$root/carry.out" 2>&1 || rc=$?
if [ "$rc" != 0 ] && grep -q 'ci: evil::error::injected' "$root/carry.out" && ! grep -q $'\r' "$root/carry.out"; then
  pass "carry-ci-base strips a CR an older git echoes from a subject"; else fail "carry-ci-base strips a CR an older git echoes from a subject"; cat -v "$root/carry.out"; fi

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

# 13. A rebased file naming a branch outside patch/ is refused before anything is pushed.
for bad in mercurai 'patch/../x' 'release/v1'; do
  setup; rebase_series
  a0=$(remote_sha patch/a) m0=$(remote_sha mercurai)
  { cat "$root/rebased"; printf '%s %s %s\n' "$bad" "$m0" "$(git rev-parse HEAD)"; } > "$root/rebased-bad"
  if bash "$here/push-rebased-series.sh" "$root/rebased-bad" mercurai "$manifest" >/dev/null 2>"$root/err"; then fail "a push naming '$bad' is refused"
  elif [ "$(remote_sha patch/a)" = "$a0" ] && [ "$(remote_sha mercurai)" = "$m0" ] && grep -qF "not patch/<name>" "$root/err"; then
    pass "a push naming '$bad' is refused"; else fail "a push naming '$bad' is refused"; fi
done

# --- assemble-release.sh, rebase-series.sh and fetch-rebase-inputs.sh -------------------------------
# Fixture: the fork's origin holds the fork's tags and the patch branches; up.git is upstream, a
# separate repo with its own tags. The scripts keep their state in FORK_STATE_DIR (/tmp in the
# workflows), a directory of this run's own so two runs on one host do not share files.
export GITHUB_OUTPUT="$root/out" FORK_STATE_DIR="$root/state"
mkdir -p "$FORK_STATE_DIR"
fx_setup() {  # tags v1.0.0 and v1.0.1 in both repos; upstream main at v1.0.1
  rm -rf "$root/origin.git" "$root/up.git" "$root/work"
  git init -q --bare "$root/origin.git"; git init -q --bare "$root/up.git"
  git init -q -b fork "$root/work"; cd "$root/work"
  git remote add origin "$root/origin.git"
  commit base.txt one "upstream 1.0.0"; git tag v1.0.0
  commit base.txt two "upstream 1.0.1"; git tag v1.0.1
  git push -q "$root/up.git" fork:refs/heads/main refs/tags/v1.0.0 refs/tags/v1.0.1
  git push -q origin fork:refs/heads/mercurai refs/tags/v1.0.0 refs/tags/v1.0.1
}
fx_patch() {  # fx_patch <name> <on> [file]: patch/<name> is <on> plus one commit
  git checkout -q -b "patch/$1" "$2"; commit "${3:-$1.txt}" "$1" "patch $1"
  git push -q origin "patch/$1"; git checkout -q fork
}
fx_manifest() {  # fx_manifest <base> <release branch> <branch[=its base]>...
  local base=$1 release=$2 spec; shift 2
  { echo "base: $base"; echo "release_branch: $release"; echo "patches:"
    for spec in "$@"; do
      echo "  - branch: ${spec%%=*}"; echo "    status: ours-only"
      if [ "$spec" != "${spec#*=}" ]; then echo "    base: ${spec#*=}"; fi
    done; } > "$root/manifest.yaml"
  cp "$root/manifest.yaml" "$root/manifest-work.yaml"
}
out_of() { { grep "^$1=" "$GITHUB_OUTPUT" || true; } | cut -d= -f2-; }
run_assemble() {  # run_assemble <tag>
  : > "$GITHUB_OUTPUT"
  (cd "$root/work" && TAG=$1 MANIFEST="$root/manifest.yaml" MANIFEST_WORK="$root/manifest-work.yaml" bash "$here/assemble-release.sh") > "$root/log" 2>&1
}
run_rebase() {  # run_rebase <base ref> <branch>...
  printf '%s\n' "${@:2}" > "$FORK_STATE_DIR/active"
  (cd "$root/work" && BASE=$(git rev-parse "$1") MANIFEST_WORK="$root/manifest-work.yaml" bash "$here/rebase-series.sh") > "$root/log" 2>&1
}
run_fetch() {  # run_fetch <target> [tag sha]: upstream is the local up.git, whatever UPSTREAM_REPO names
  : > "$GITHUB_OUTPUT"
  (cd "$root/work" && { git remote remove upstream 2>/dev/null || true; }
   GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="url.$root/up.git.insteadOf" GIT_CONFIG_VALUE_0="https://github.com/o/up.git" \
     UPSTREAM_REPO=o/up TARGET="$1" TAG_SHA="${2:-}" bash "$here/fetch-rebase-inputs.sh") > "$root/log" 2>&1
}
subjects() { git -C "$root/work" log --reverse --format=%s "$1..HEAD" | tr '\n' ','; }

# 14. assemble: release/<name> is the tag plus the patches in manifest order, and the first fork release is .1.
fx_setup; fx_patch a v1.0.1; fx_patch b v1.0.1
fx_manifest v1.0.1 release/mercurai patch/b=v1.0.1 patch/a=v1.0.1
if run_assemble v1.0.1 && [ "$(git -C "$root/work" rev-parse --abbrev-ref HEAD)" = release/mercurai ] &&
   [ "$(subjects v1.0.1)" = "patch b,patch a," ] && [ "$(out_of release_branch)" = release/mercurai ] &&
   [ "$(out_of release_tag)" = v1.0.1-mercurai.1 ] && [ "$(out_of tree)" = "$(git -C "$root/work" rev-parse 'HEAD^{tree}')" ]; then
  pass "assemble builds the tag plus the patches in manifest order"; else fail "assemble builds the tag plus the patches in manifest order"; cat "$root/log"; fi

# 15. assemble: a second run gives the identical tree, which the push job compares with the tested one.
first=$(out_of tree)
if run_assemble v1.0.1 && [ -n "$first" ] && [ "$(out_of tree)" = "$first" ]; then
  pass "assemble twice gives the identical tree"; else fail "assemble twice gives the identical tree"; fi

# 16. assemble: a patch recorded on the tag but built on an older tag does not contain the tag: fails, nothing built.
fx_setup; fx_patch c v1.0.0
fx_manifest v1.0.1 release/mercurai patch/c=v1.0.1
if run_assemble v1.0.1; then fail "assemble refuses a patch that is not on the tag"
elif grep -qF "does not contain v1.0.1" "$root/log" && ! git -C "$root/work" rev-parse -q --verify refs/heads/release/mercurai >/dev/null && [ ! -s "$GITHUB_OUTPUT" ]; then
  pass "assemble refuses a patch that is not on the tag"; else fail "assemble refuses a patch that is not on the tag"; cat "$root/log"; fi

# 17. assemble: numbering counts the fork's own tags (numerically); a name only upstream holds is ignored.
fx_setup; fx_patch a v1.0.1
git remote add upstream "$root/up.git"   # a reintroduced `git fetch upstream --tags` would pull the upstream-only name
git push -q origin v1.0.1:refs/tags/v1.0.1-mercurai.2 v1.0.1:refs/tags/v1.0.1-mercurai.10
git push -q "$root/up.git" v1.0.1:refs/tags/v1.0.1-mercurai.50
fx_manifest v1.0.1 release/mercurai patch/a=v1.0.1
if run_assemble v1.0.1 && [ "$(out_of release_tag)" = v1.0.1-mercurai.11 ]; then
  pass "assemble numbers from the fork's tags and ignores upstream-only names"; else fail "assemble numbers from the fork's tags and ignores upstream-only names"; cat "$root/log"; fi

# 18. assemble: a release tag only upstream holds is not one the fork can build.
# patch/a sits on v1.0.2, so only the tag-source check can fail the run.
fx_setup; git remote add upstream "$root/up.git"
git commit -q --allow-empty -m "upstream 1.0.2"; git tag v1.0.2; fx_patch a v1.0.2
git push -q "$root/up.git" refs/tags/v1.0.2; git tag -d v1.0.2 >/dev/null; git reset -q --hard v1.0.1
fx_manifest v1.0.2 release/mercurai patch/a=v1.0.2
if run_assemble v1.0.2; then fail "assemble refuses a tag the fork does not hold"
elif grep -qF "::error::the fork has no tag v1.0.2; fork-sync-upstream mirrors it first" "$root/log" && [ ! -s "$GITHUB_OUTPUT" ] &&
     ! git -C "$root/work" rev-parse -q --verify refs/heads/release/mercurai >/dev/null; then
  pass "assemble refuses a tag the fork does not hold"; else fail "assemble refuses a tag the fork does not hold"; fi

# 19b. A name that is no stable tag is refused before git is asked about it, so the name is not echoed by the missing-tag error.
if run_assemble 'v1.0.1;x'; then fail "assemble refuses a name that is no stable tag first"
elif grep -qF "is not a stable upstream tag" "$root/log" && ! grep -qF "has no tag" "$root/log" && [ ! -s "$GITHUB_OUTPUT" ]; then
  pass "assemble refuses a name that is no stable tag first"; else fail "assemble refuses a name that is no stable tag first"; cat "$root/log"; fi

# 19. assemble: branch names the push job would force-push are refused up front.
fx_setup; fx_patch a v1.0.1
for row in "mercurai|patch/a|release_branch 'mercurai' is not release/<name>" \
            "release/x|mercurai|patch branch 'mercurai' is not patch/<name>" \
            "release/x|patch/../x|patch branch 'patch/../x' is not patch/<name>" \
            "release/..|patch/a|release_branch 'release/..' is not release/<name>"; do
  IFS='|' read -r release patch message <<<"$row"
  fx_manifest v1.0.1 "$release" "$patch=v1.0.1"
  if run_assemble v1.0.1; then fail "assemble refuses release '$release' with patch '$patch'"
  elif grep -qF "$message" "$root/log" && [ "$(git -C "$root/work" rev-parse --abbrev-ref HEAD)" = fork ] && [ ! -s "$GITHUB_OUTPUT" ]; then
    pass "assemble refuses release '$release' with patch '$patch'"; else fail "assemble refuses release '$release' with patch '$patch'"; cat "$root/log"; fi
done

# 20. rebase-series: every patch lands on the new base; a patch from an explicit base and one from the manifest's.
fx_setup; fx_patch a v1.0.0; fx_patch b v1.0.0
fx_manifest v1.0.0 release/mercurai patch/a=v1.0.0 patch/b
a0=$(git rev-parse origin/patch/a)
ok=1
if run_rebase v1.0.1 patch/a patch/b && [ "$(grep -c . "$FORK_STATE_DIR/rebased")" = 2 ] && [ ! -s "$FORK_STATE_DIR/conflicted" ] && [ ! -s "$FORK_STATE_DIR/merged" ] && [ "$(awk '$1 == "patch/a" {print $2}' "$FORK_STATE_DIR/rebased")" = "$a0" ]; then
  while read -r _branch before after; do
    if [ "$before" = "$after" ] || ! git -C "$root/work" merge-base --is-ancestor v1.0.1 "$after"; then ok=0; fi
  done < "$FORK_STATE_DIR/rebased"
else ok=0; fi
if [ "$ok" = 1 ]; then pass "rebase-series rebases every patch onto the base"; else fail "rebase-series rebases every patch onto the base"; cat "$root/log"; fi

# 21. rebase-series: a conflicting patch is recorded and aborted; the others still rebase and no rebase is left running.
fx_setup; fx_patch a v1.0.0; fx_patch c v1.0.0 base.txt; fx_patch b v1.0.0
fx_manifest v1.0.0 release/mercurai patch/a patch/c patch/b
if run_rebase v1.0.1 patch/a patch/c patch/b && [ "$(cat "$FORK_STATE_DIR/conflicted")" = "patch/c v1.0.0" ] &&
   grep -qx base.txt "$FORK_STATE_DIR/conflicts/patch__c" && [ "$(awk '{print $1}' "$FORK_STATE_DIR/rebased" | tr '\n' ' ')" = "patch/a patch/b " ] &&
   [ ! -d "$root/work/.git/rebase-merge" ] && [ ! -d "$root/work/.git/rebase-apply" ]; then
  pass "rebase-series records a conflict and carries on"; else fail "rebase-series records a conflict and carries on"; cat "$root/log"; fi

# 22. rebase-series: a branch outside patch/ is refused before any rebase.
fx_setup; fx_patch a v1.0.0
fx_manifest v1.0.0 release/mercurai patch/a
for bad in mercurai 'patch/../x'; do
  if run_rebase v1.0.1 patch/a "$bad"; then fail "rebase-series refuses '$bad'"
  elif grep -qF "patch branch '$bad' is not patch/<name>" "$root/log" && [ ! -s "$FORK_STATE_DIR/rebased" ]; then
    pass "rebase-series refuses '$bad'"; else fail "rebase-series refuses '$bad'"; cat "$root/log"; fi
done

# 23. fetch-rebase-inputs: no target pins upstream/main; a target pins its tag and brings the patch branches.
fx_setup; fx_patch a v1.0.0
git commit -q --allow-empty -m "upstream 1.0.2"; up2=$(git rev-parse HEAD)
git push -q "$root/up.git" HEAD:refs/tags/v1.0.2; git push -q origin HEAD:refs/tags/v1.0.2; git reset -q --hard HEAD~1
git update-ref -d refs/remotes/origin/patch/a
if run_fetch "" && [ "$(out_of base)" = "$(git --git-dir="$root/up.git" rev-parse main)" ] &&
   git -C "$root/work" rev-parse -q --verify refs/remotes/origin/patch/a >/dev/null; then
  pass "fetch-rebase-inputs pins upstream/main for a dry run"; else fail "fetch-rebase-inputs pins upstream/main for a dry run"; cat "$root/log"; fi
if run_fetch v1.0.2 "$up2" && [ "$(out_of base)" = "$up2" ]; then
  pass "fetch-rebase-inputs pins the fork's tag to its commit"; else fail "fetch-rebase-inputs pins the fork's tag to its commit"; cat "$root/log"; fi

# 23b. The same name on both sides, pointing apart (upstream re-cut it): the rebase uses the fork's commit, as assemble does.
git commit -q --allow-empty -m "upstream 1.0.3 as the fork mirrored it"; fork3=$(git rev-parse HEAD)
git commit -q --allow-empty -m "upstream 1.0.3 re-cut"; recut3=$(git rev-parse HEAD)
git push -q origin "$fork3:refs/tags/v1.0.3"; git push -q "$root/up.git" "$recut3:refs/tags/v1.0.3"; git reset -q --hard "$up2"
if run_fetch v1.0.3 && [ "$(out_of base)" = "$fork3" ] && [ "$fork3" != "$recut3" ]; then
  pass "fetch-rebase-inputs ignores upstream's re-cut of a tag the fork holds"; else fail "fetch-rebase-inputs ignores upstream's re-cut of a tag the fork holds"; cat "$root/log"; fi
# A tag only upstream holds is not a target.
git push -q "$root/up.git" "$recut3:refs/tags/v1.0.4"
if run_fetch v1.0.4; then fail "fetch-rebase-inputs refuses a tag the fork does not hold"
elif grep -qF "::error::the fork has no tag v1.0.4; fork-sync-upstream mirrors it first" "$root/log" && [ ! -s "$GITHUB_OUTPUT" ]; then
  pass "fetch-rebase-inputs refuses a tag the fork does not hold"; else fail "fetch-rebase-inputs refuses a tag the fork does not hold"; cat -v "$root/log"; fi


# 24. fetch-rebase-inputs: a tag that moved since fork-sync-upstream saw it, or a name that is no release, fails closed.
if run_fetch v1.0.2 "$(git -C "$root/work" rev-parse v1.0.0)"; then fail "fetch-rebase-inputs refuses a moved tag"
elif grep -qF "now points at $up2" "$root/log" && [ ! -s "$GITHUB_OUTPUT" ]; then pass "fetch-rebase-inputs refuses a moved tag"; else fail "fetch-rebase-inputs refuses a moved tag"; fi
for bad in main v1.0 v1.0.2-rc v1.0.2-mercurai.1 'v1.0.2;x'; do
  if run_fetch "$bad"; then fail "fetch-rebase-inputs refuses '$bad'"
  elif grep -qF "is not v<major>.<minor>.<patch>" "$root/log" && [ ! -s "$GITHUB_OUTPUT" ]; then pass "fetch-rebase-inputs refuses '$bad'"; else fail "fetch-rebase-inputs refuses '$bad'"; fi
done

# 25. assemble: a CR in a commit subject never reaches the log, where it could inject workflow commands.
fx_setup; git checkout -q -b patch/cr v1.0.1; commit cr.txt cr $'evil\r::error::injected'; git push -q origin patch/cr; git checkout -q fork
fx_manifest v1.0.1 release/mercurai patch/cr=v1.0.1
if run_assemble v1.0.1 && grep -q evil "$root/log" && ! grep -q $'\r' "$root/log"; then
  pass "assemble strips CR from commit subjects in its log"; else fail "assemble strips CR from commit subjects in its log"; cat -v "$root/log"; fi

# 26. assemble: two patches editing the same lines: the second does not apply; fails, no cherry-pick left running.
fx_setup; fx_patch p v1.0.1 base.txt; fx_patch q v1.0.1 base.txt
fx_manifest v1.0.1 release/mercurai patch/p=v1.0.1 patch/q=v1.0.1
if run_assemble v1.0.1; then fail "assemble fails when a patch does not apply"
elif grep -qF "::error::patch/q does not apply on v1.0.1" "$root/log" && [ ! -f "$root/work/.git/CHERRY_PICK_HEAD" ] &&
     [ ! -d "$root/work/.git/sequencer" ] && [ ! -s "$GITHUB_OUTPUT" ]; then
  pass "assemble fails when a patch does not apply"; else fail "assemble fails when a patch does not apply"; cat -v "$root/log"; fi

# 27. rebase-series: a CR in the subject of a conflicting commit never reaches the log; the conflict is still recorded.
fx_setup; git checkout -q -b patch/crc v1.0.0; commit base.txt crc $'evil\r::error::injected'; git push -q origin patch/crc; git checkout -q fork
fx_manifest v1.0.0 release/mercurai patch/crc=v1.0.0
if run_rebase v1.0.1 patch/crc && [ "$(cat "$FORK_STATE_DIR/conflicted")" = "patch/crc v1.0.0" ] && grep -q evil "$root/log" && ! grep -q $'\r' "$root/log"; then
  pass "rebase-series strips CR from git's rebase output"; else fail "rebase-series strips CR from git's rebase output"; cat -v "$root/log"; fi

# --- merge-guard.sh ---------------------------------------------------------------------------------
# `fork` and `up` leave one base; the fork has a file of its own under config/mercurai, which never counts.
guard_setup() {
  rm -rf "$root/g"; git init -q -b fork "$root/g"; cd "$root/g"
  mkdir -p .github/workflows config/mercurai config/scripts config/mercurai-docs src docs
  commit base.txt one "base"; commit .github/workflows/ci.yml ci "ci"; commit config/mercurai/keep.md keep "keep"; commit config/scripts/keep.sh keep "keep"; commit src/a.txt a "a"
  git branch up; commit config/mercurai/fork-own.md own "the fork's own file"; git checkout -q up
}
guard_rc() {  # guard_rc: runs the guard, prints its exit status; the output is left in $root/guard.out
  local rc=0; bash "$here/merge-guard.sh" fork up > "$root/guard.out" 2>&1 || rc=$?; echo "$rc"
}
guard_expect() {  # guard_expect <name> <exit status> [path the output must list]
  local rc; rc=$(guard_rc)
  if [ "$rc" = "$2" ] && { [ -z "${3:-}" ] || grep -qxF "$3" "$root/guard.out"; }; then pass "$1"; else fail "$1"; cat "$root/guard.out"; fi
}

# 28. Upstream changes outside the guarded paths merge, whatever the fork changed under them; a lookalike name is not guarded.
guard_setup; commit docs/up.md up "upstream docs"; commit config/mercurai-docs/x.md x "lookalike"
guard_expect "guard: a change outside the guarded paths merges" 0

# 29. A change under .github/workflows/ is refused.
guard_setup; commit .github/workflows/evil.yml evil "upstream workflow"
guard_expect "guard: a change under .github/workflows is refused" 3 .github/workflows/evil.yml

# 30. A change under config/mercurai/ is refused.
guard_setup; mkdir -p config/mercurai/scripts; commit config/mercurai/scripts/x.sh x "upstream fork script"
guard_expect "guard: a change under config/mercurai is refused" 3 config/mercurai/scripts/x.sh

# 30b. Composite actions and other .github files run inside workflows or steer them: refused; a lookalike outside is not.
guard_setup; mkdir -p .github/actions/x; commit .github/actions/x/action.yml x "upstream composite action"
guard_expect "guard: a change under .github/actions is refused" 3 .github/actions/x/action.yml
guard_setup; commit .github/CODEOWNERS owners "upstream CODEOWNERS"
guard_expect "guard: a plain .github file is refused" 3 .github/CODEOWNERS
guard_setup; commit .github/dependabot.yml dep "upstream dependabot"
guard_expect "guard: .github/dependabot.yml is refused" 3 .github/dependabot.yml
guard_setup; commit docs/.github-notes.md notes "lookalike"; commit .githubx.md x "lookalike root file"
guard_expect "guard: a lookalike outside .github merges" 0

# 31. A rename into a guarded path, and one out of it, are refused.
guard_setup; git mv src/a.txt config/mercurai/a.txt; git commit -qm "rename in"
guard_expect "guard: a rename into a guarded path is refused" 3 config/mercurai/a.txt
guard_setup; git mv .github/workflows/ci.yml docs/ci.yml; git commit -qm "rename out"
guard_expect "guard: a rename out of a guarded path is refused" 3 .github/workflows/ci.yml

# 32. A delete in a guarded path is refused.
guard_setup; git rm -q config/mercurai/keep.md; git commit -qm "delete"
guard_expect "guard: a delete in a guarded path is refused" 3 config/mercurai/keep.md

# 32b. Scripts consumed by privileged workflows are guarded too.
guard_setup; commit config/scripts/upstream.sh x "upstream privileged script"
guard_expect "guard: a change under config/scripts is refused" 3 config/scripts/upstream.sh

# 33. The owner's override is the full sha of the commit that is merged: it merges (exit 4) and still lists the paths.
# true, a short sha, and the sha of an older reviewed commit, with upstream moved on since, all refuse.
guard_setup; commit .github/workflows/evil.yml evil "upstream workflow"
reviewed=$(git rev-parse up)
export ALLOWED_SHA=$reviewed
guard_expect "guard: the full sha of the reviewed commit lets it merge" 4 .github/workflows/evil.yml
export ALLOWED_SHA=true
guard_expect "guard: any other override value still refuses" 3 .github/workflows/evil.yml
export ALLOWED_SHA=${reviewed:0:12}
guard_expect "guard: a short sha still refuses" 3 .github/workflows/evil.yml
export ALLOWED_SHA=$reviewed
commit .github/workflows/steal.yml steal "upstream moved on after the review"
guard_expect "guard: an older reviewed sha refuses a range that moved on" 3 .github/workflows/steal.yml
unset ALLOWED_SHA

# 33b. A path name with a CR, "::" and a backtick is refused and printed without any of them.
guard_setup; commit $'config/mercurai/a\r::error::x`b' x "hostile name"
guard_expect "guard: a hostile path name is refused" 3 'config/mercurai/a???error??x?b'
if ! grep -q $'\r' "$root/guard.out" && ! grep -q '`' "$root/guard.out"; then pass "guard: the printed list has no CR and no backtick"; else fail "guard: the printed list has no CR and no backtick"; fi

# 33c. A range that nets to no guarded change passes; the fork then takes its first half in a reviewed merge, and the
# merge of the second half changes the workflow: the result check refuses it, though the guard judged the old base.
guard_setup; commit .github/workflows/ci.yml A "u1"; commit .github/workflows/ci.yml ci "u2 reverts u1"
guard_expect "guard: a range that nets to no guarded change passes" 0
git checkout -q fork; git merge -q --no-edit up~1; before=$(git rev-parse HEAD); git merge -q --no-edit up
rc=0; bash "$here/merge-result-guard.sh" "$before" > "$root/guard.out" 2>&1 || rc=$?
if [ "$rc" = 3 ] && grep -qxF .github/workflows/ci.yml "$root/guard.out"; then pass "result guard: a merge that moved the base is refused"; else fail "result guard: a merge that moved the base is refused"; cat "$root/guard.out"; fi
guard_setup; commit docs/up.md up "upstream docs"; git checkout -q fork; before=$(git rev-parse HEAD); git merge -q --no-edit up
rc=0; bash "$here/merge-result-guard.sh" "$before" > "$root/guard.out" 2>&1 || rc=$?
if [ "$rc" = 0 ]; then pass "result guard: a merge outside the guarded paths passes"; else fail "result guard: a merge outside the guarded paths passes"; cat "$root/guard.out"; fi
guard_setup; mkdir -p .github/actions/x; commit .github/actions/x/action.yml x "upstream composite action"; git checkout -q fork; before=$(git rev-parse HEAD); git merge -q --no-edit up
rc=0; bash "$here/merge-result-guard.sh" "$before" > "$root/guard.out" 2>&1 || rc=$?
if [ "$rc" = 3 ] && grep -qxF .github/actions/x/action.yml "$root/guard.out"; then pass "result guard: a merge that changed .github/actions is refused"; else fail "result guard: a merge that changed .github/actions is refused"; cat "$root/guard.out"; fi

# 33ca. An approved guarded path must retain the exact merge-tree content; a same-path edit is refused.
guard_setup; git checkout -q up; commit .github/workflows/ci.yml approved "approved workflow"; approved=$(git rev-parse HEAD)
git checkout -q fork; before=$(git rev-parse HEAD); git merge -q --no-edit up; echo tampered >> .github/workflows/ci.yml; git add .github/workflows/ci.yml; git commit -qm "tamper approved workflow"
rc=0; bash "$here/merge-result-guard.sh" "$before" "$approved" > "$root/guard.out" 2>&1 || rc=$?
if [ "$rc" = 3 ] && grep -qxF .github/workflows/ci.yml "$root/guard.out"; then pass "result guard: an approved path with altered content is refused"; else fail "result guard: an approved path with altered content is refused"; cat "$root/guard.out"; fi

# 33d. merge-forward.sh: the merge, the result check and the reset, as the workflow runs them (the push stays outside).
mf_run() {  # mf_run <GUARD_ALLOWED>: merges `up` into `fork`; prints the exit status
  local rc=0; git checkout -q fork; : > "$root/mf.gho"
  GITHUB_OUTPUT="$root/mf.gho" UPSTREAM_SHA=$(git rev-parse up) GUARD_ALLOWED=$1 bash "$here/merge-forward.sh" > "$root/mf.out" 2>&1 || rc=$?
  echo "$rc"
}
mf_outputs() { tr '\n' ' ' < "$root/mf.gho"; }
guard_setup; commit docs/up.md up "upstream docs"
rc=$(mf_run false)
if [ "$rc" = 0 ] && [ -f docs/up.md ] && git merge-base --is-ancestor up fork && [ "$(mf_outputs)" = "conflict=false guarded=false " ]; then pass "merge-forward: a clean range merges, both outputs false"; else fail "merge-forward: a clean range merges, both outputs false"; cat "$root/mf.out"; mf_outputs; fi
guard_setup; commit .github/workflows/evil.yml evil "upstream workflow"
git checkout -q fork; before=$(git rev-parse HEAD)
rc=$(mf_run false)
if [ "$rc" = 11 ] && [ "$(git rev-parse HEAD)" = "$before" ] && [ ! -e .github/workflows/evil.yml ] && grep -qxF .github/workflows/evil.yml "$FORK_STATE_DIR/guarded" && [ "$(mf_outputs)" = "conflict=false guarded=false guarded=true " ]; then
  pass "merge-forward: an unallowed guarded result is reset, exits 11 and sets guarded"; else fail "merge-forward: an unallowed guarded result is reset, exits 11 and sets guarded"; cat "$root/mf.out"; mf_outputs; fi
git checkout -q up; rc=$(mf_run true)
if [ "$rc" = 0 ] && [ -f .github/workflows/evil.yml ]; then pass "merge-forward: an allowed guarded commit merges"; else fail "merge-forward: an allowed guarded commit merges"; cat "$root/mf.out"; fi
guard_setup; commit .github/workflows/evil.yml evil "upstream workflow"; commit docs/up.md up "upstream docs"; git checkout -q fork
rc=$(mf_run true)
if [ "$rc" = 0 ] && [ -f .github/workflows/evil.yml ] && [ -f docs/up.md ]; then
  pass "merge-forward: an allowed guarded commit still merges its unguarded companions"; else fail "merge-forward: an allowed guarded commit still merges its unguarded companions"; cat "$root/mf.out"; fi
guard_setup; commit base.txt upside "upstream edits base"; git checkout -q fork; commit base.txt forkside "fork edits base"
before=$(git rev-parse HEAD); rc=$(mf_run false)
if [ "$rc" = 10 ] && [ "$(git rev-parse HEAD)" = "$before" ] && ! git rev-parse -q --verify MERGE_HEAD >/dev/null && grep -qxF base.txt "$FORK_STATE_DIR/sync-conflicts" && [ "$(mf_outputs)" = "conflict=false guarded=false conflict=true " ]; then
  pass "merge-forward: a conflict is aborted, exits 10 and sets conflict"; else fail "merge-forward: a conflict is aborted, exits 10 and sets conflict"; cat "$root/mf.out"; mf_outputs; fi
# The rebase cases left a conflicts/ directory in this same state dir: the sync list has a name of its own.
if [ -d "$FORK_STATE_DIR/conflicts" ] && [ -f "$FORK_STATE_DIR/sync-conflicts" ]; then pass "merge-forward: its conflict list does not clash with rebase-series'"; else fail "merge-forward: its conflict list does not clash with rebase-series'"; fi

# 33e. A result guard that fails (not "guarded paths found") is an error: merge-forward exits with its status and the merge does not stay.
guard_setup; commit docs/up.md up "upstream docs"; git checkout -q fork; before=$(git rev-parse HEAD)
rm -rf "$root/stub"; mkdir -p "$root/stub"; cp "$here/merge-forward.sh" "$root/stub/"; printf '#!/usr/bin/env bash\nexit 2\n' > "$root/stub/merge-result-guard.sh"
rc=0; UPSTREAM_SHA=$(git rev-parse up) GUARD_ALLOWED=false bash "$root/stub/merge-forward.sh" > "$root/mf.out" 2>&1 || rc=$?
if [ "$rc" = 2 ] && [ "$(git rev-parse HEAD)" = "$before" ] && ! git rev-parse -q --verify MERGE_HEAD >/dev/null; then
  pass "merge-forward: a failing result guard exits with its status and leaves no merge"; else fail "merge-forward: a failing result guard exits with its status and leaves no merge"; cat "$root/mf.out"; fi

# 33f. The guard takes the union of the ranges: a range the fork already took in a reviewed merge is clean for the merge-forward
# but still new for the main mirror, which publishes from where origin/main is.
guard_setup; git branch mainmirror up; commit .github/workflows/ci.yml A "upstream workflow"; git branch took up
git checkout -q fork; git merge -q --no-edit took; git checkout -q up; commit docs/later.md later "upstream docs"
guard_expect "guard: a range the fork already merged is clean for the merge-forward alone" 0
rc=0; bash "$here/merge-guard.sh" fork up mainmirror > "$root/guard.out" 2>&1 || rc=$?
if [ "$rc" = 3 ] && grep -qxF .github/workflows/ci.yml "$root/guard.out"; then pass "guard: the main mirror's range is guarded too"; else fail "guard: the main mirror's range is guarded too"; cat "$root/guard.out"; fi

# 33g. pin-upstream-sha.sh: the tip, unless the owner's full sha is inside it (the reviewed commit lands, newer ones wait).
guard_setup; commit docs/a.md a "a"; second=$(git rev-parse up); commit docs/b.md b "b"; tip=$(git rev-parse up)
pin() { ALLOWED_SHA=$1 bash "$here/pin-upstream-sha.sh" up; }
if [ "$(pin '')" = "$tip" ] && [ "$(pin "$second")" = "$second" ] && [ "$(pin "$tip")" = "$tip" ] &&
   [ "$(pin "${second:0:12}")" = "$tip" ] && [ "$(pin true)" = "$tip" ] && [ "$(pin 0000000000000000000000000000000000000000)" = "$tip" ]; then
  pass "pin: the owner's full sha inside the tip is pinned, anything else gives the tip"; else fail "pin: the owner's full sha inside the tip is pinned, anything else gives the tip"; fi
git checkout -q -b side "$(git rev-parse fork)"; mkdir -p docs; commit docs/side.md side "not in up"; sideshot=$(git rev-parse HEAD); git checkout -q up
if [ "$(pin "$sideshot")" = "$tip" ]; then pass "pin: an owner sha that is not inside the tip gives the tip"; else fail "pin: an owner sha that is not inside the tip gives the tip"; fi

# 33h. sync-push.sh: nothing is pushed unless the guard said false, and only refs inside the pinned commit. The bare origin logs every push.
sp_setup() {
  rm -rf "$root/sp"; mkdir -p "$root/sp"; git init -q --bare "$root/sp/origin.git"
  printf '#!/bin/sh\necho push >> "%s/sp/pushes"\n' "$root" > "$root/sp/origin.git/hooks/pre-receive"; chmod +x "$root/sp/origin.git/hooks/pre-receive"
  : > "$root/sp/pushes"
  git init -q -b fork "$root/sp/work"; cd "$root/sp/work"; git remote add origin "$root/sp/origin.git"
  commit a.txt 1 "u1"; u1=$(git rev-parse HEAD); commit a.txt 2 "u2"; u2=$(git rev-parse HEAD); commit a.txt 3 "u3"; u3=$(git rev-parse HEAD)
  git checkout -q -b sidebranch "$u1"; commit side.txt s "side"; side=$(git rev-parse HEAD); git checkout -q fork
  git update-ref refs/upstream-tags/v1.0.0 "$u1"; git update-ref refs/upstream-tags/v1.0.1-rc.1 "$u2"; git update-ref refs/upstream-tags/v1.0.2 "$u3"
  printf 'v1.0.0\nv1.0.1-rc.1\nv1.0.2\n' > "$FORK_STATE_DIR/tags-new"
  git update-ref refs/remotes/upstream/rel "$u1"; git update-ref refs/remotes/upstream/main "$u3"; git update-ref refs/remotes/upstream/feat "$side"
}
sp_run() {  # sp_run <GUARD_REFUSED or ->; runs main, tags, branches; prints the three exit statuses
  local r=() k
  for k in main tags branches; do
    local rc=0
    if [ "$1" = - ]; then env -u GUARD_REFUSED GITHUB_OUTPUT="$root/sp/gho" UPSTREAM_SHA="$u2" bash "$here/sync-push.sh" "$k" > "$root/sp/out.$k" 2>&1 || rc=$?
    else GUARD_REFUSED=$1 GITHUB_OUTPUT="$root/sp/gho" UPSTREAM_SHA="$u2" bash "$here/sync-push.sh" "$k" > "$root/sp/out.$k" 2>&1 || rc=$?; fi
    r+=("$rc")
  done
  echo "${r[*]}"
}
sp_origin() { git --git-dir="$root/sp/origin.git" for-each-ref --format='%(refname)' | tr '\n' ' '; }
sp_setup
if [ "$(sp_run true)" = "3 3 3" ] && [ ! -s "$root/sp/pushes" ] && [ -z "$(sp_origin)" ]; then pass "sync-push: a refused guard makes zero pushes"; else fail "sync-push: a refused guard makes zero pushes"; cat "$root/sp/pushes"; fi
if [ "$(sp_run -)" = "3 3 3" ] && [ ! -s "$root/sp/pushes" ] && [ -z "$(sp_origin)" ]; then pass "sync-push: a guard that did not run makes zero pushes"; else fail "sync-push: a guard that did not run makes zero pushes"; fi
if [ "$(sp_run 1)" = "3 3 3" ] && [ ! -s "$root/sp/pushes" ]; then pass "sync-push: only the exact word false opens the gate"; else fail "sync-push: only the exact word false opens the gate"; fi
if [ "$(sp_run false)" = "0 0 0" ] &&
   [ "$(sp_origin)" = "refs/heads/main refs/heads/upstream/rel refs/tags/v1.0.0 refs/tags/v1.0.1-rc.1 " ] &&
   [ "$(git --git-dir="$root/sp/origin.git" rev-parse refs/heads/main)" = "$u2" ] &&
   [ "$(cat "$FORK_STATE_DIR/rebase-tag")" = v1.0.0 ] && [ "$(wc -l < "$root/sp/pushes")" = 3 ] && [ "$(cat "$root/sp/gho")" = "rebase_tag=v1.0.0" ]; then
  pass "sync-push: a clean range pushes main at the pin, the tags and branches inside it, and skips the rest"; else fail "sync-push: a clean range pushes main at the pin, the tags and branches inside it, and skips the rest"; sp_origin; cat "$root/sp/out."*; fi
if grep -qF "tags not mirrored" "$root/sp/out.tags" && grep -qF "v1.0.2" "$root/sp/out.tags" && grep -qF "branches not mirrored" "$root/sp/out.branches" &&
   grep -qF "feat" "$root/sp/out.branches"; then pass "sync-push: what is skipped is named in a warning"; else fail "sync-push: what is skipped is named in a warning"; cat "$root/sp/out.tags" "$root/sp/out.branches"; fi

# 33i. The owner's override, end to end: the guard says 4 for the exact sha, which opens the gate; a refused range stays shut.
guard_setup; commit .github/workflows/evil.yml evil "upstream workflow"
reviewed=$(git rev-parse up)
rc=0; ALLOWED_SHA=$reviewed bash "$here/merge-guard.sh" fork up > "$root/guard.out" 2>&1 || rc=$?
if [ "$rc" = 4 ]; then refused=false; else refused=true; fi
sp_setup; u2=$(git -C "$root/sp/work" rev-parse fork~1)
if [ "$refused" = false ] && [ "$(sp_run "$refused")" = "0 0 0" ] && [ -s "$root/sp/pushes" ]; then pass "sync-push: the exact override sha releases every push"; else fail "sync-push: the exact override sha releases every push"; fi
cd "$root/g"; rc=0; ALLOWED_SHA=${reviewed:0:12} bash "$here/merge-guard.sh" fork up > "$root/guard.out" 2>&1 || rc=$?
if [ "$rc" = 3 ]; then refused=true; else refused=false; fi
sp_setup; u2=$(git -C "$root/sp/work" rev-parse fork~1); : > "$root/sp/pushes"
if [ "$refused" = true ] && [ "$(sp_run "$refused")" = "3 3 3" ] && [ ! -s "$root/sp/pushes" ]; then pass "sync-push: a short override sha leaves every push shut"; else fail "sync-push: a short override sha leaves every push shut"; fi

# 33j. A ref on an intermediate commit carries its own tree: X1 adds a workflow, X2 (the pin) removes it, so the range nets to
# nothing and the guard passes, but a tag or branch on X1 would push the workflow and run it. It is skipped; the pin's refs go.
rm -rf "$root/xp"; mkdir -p "$root/xp"; git init -q --bare "$root/xp/origin.git"
printf '#!/bin/sh\necho push >> "%s/xp/pushes"\n' "$root" > "$root/xp/origin.git/hooks/pre-receive"; chmod +x "$root/xp/origin.git/hooks/pre-receive"; : > "$root/xp/pushes"
git init -q -b fork "$root/xp/work"; cd "$root/xp/work"; git remote add origin "$root/xp/origin.git"; mkdir -p .github/workflows
commit a.txt 1 "base"; git branch mainmirror; mkdir -p .github/workflows
commit .github/workflows/x.yml x "X1 adds a workflow"; x1=$(git rev-parse HEAD)
git rm -q .github/workflows/x.yml; git commit -qm "X2 removes it"; x2=$(git rev-parse HEAD)
git branch up "$x2"; git checkout -q fork; git reset -q --hard mainmirror
git update-ref refs/upstream-tags/v9.9.9 "$x1"; git update-ref refs/upstream-tags/v9.9.10 "$x2"
git update-ref refs/remotes/upstream/mid "$x1"; git update-ref refs/remotes/upstream/tip "$x2"
printf 'v9.9.9\nv9.9.10\n' > "$FORK_STATE_DIR/tags-new"
rc=0; bash "$here/merge-guard.sh" fork "$x2" mainmirror > "$root/guard.out" 2>&1 || rc=$?
if [ "$rc" = 0 ]; then pass "intermediate refs: the guard passes a range that nets to no guarded change"; else fail "intermediate refs: the guard passes a range that nets to no guarded change"; cat "$root/guard.out"; fi
ok=true
for kind in main tags branches; do GUARD_REFUSED=false UPSTREAM_SHA="$x2" bash "$here/sync-push.sh" "$kind" > "$root/xp/out.$kind" 2>&1 || ok=false; done
xp_origin=$(git --git-dir="$root/xp/origin.git" for-each-ref --format='%(refname)' | tr '\n' ' ')
if [ "$ok" = true ] && [ "$xp_origin" = "refs/heads/main refs/heads/upstream/tip refs/tags/v9.9.10 " ] && [ "$(wc -l < "$root/xp/pushes")" = 3 ] &&
   [ "$(cat "$FORK_STATE_DIR/rebase-tag")" = v9.9.10 ]; then
  pass "intermediate refs: a tag and a branch on a commit whose guarded paths differ from the pin are not pushed; the pin's are"
else fail "intermediate refs: a tag and a branch on a commit whose guarded paths differ from the pin are not pushed; the pin's are"; echo "$xp_origin"; cat "$root/xp/out."*; fi
if grep -qF v9.9.9 "$root/xp/out.tags" && grep -qF mid "$root/xp/out.branches"; then pass "intermediate refs: the skipped ones are named in a warning"; else fail "intermediate refs: the skipped ones are named in a warning"; fi
# list-skipped-tags.sh, which feeds the review issues, lists exactly the tag sync-push.sh did not push.
UPSTREAM_SHA="$x2" bash "$here/list-skipped-tags.sh"
if [ "$(cat "$FORK_STATE_DIR/tags-skipped")" = v9.9.9 ]; then pass "intermediate refs: the review-issue list is the tag sync-push skipped"; else fail "intermediate refs: the review-issue list is the tag sync-push skipped"; cat "$FORK_STATE_DIR/tags-skipped"; fi
# The same under config/mercurai/: Y1 adds a fork script, Y2 (the pin) removes it; the tag and branch on Y1 stay behind.
rm -rf "$root/yp"; mkdir -p "$root/yp"; git init -q --bare "$root/yp/origin.git"
git init -q -b fork "$root/yp/work"; cd "$root/yp/work"; git remote add origin "$root/yp/origin.git"
commit a.txt 1 "base"; y0=$(git rev-parse HEAD); mkdir -p config/mercurai
commit config/mercurai/y.sh y "Y1 adds a fork script"; y1=$(git rev-parse HEAD)
git rm -q config/mercurai/y.sh; git commit -qm "Y2 removes it"; y2=$(git rev-parse HEAD)
git update-ref refs/upstream-tags/v9.8.1 "$y1"; git update-ref refs/upstream-tags/v9.8.2 "$y2"
git update-ref refs/remotes/upstream/ymid "$y1"; git update-ref refs/remotes/upstream/ytip "$y2"
printf 'v9.8.1\nv9.8.2\n' > "$FORK_STATE_DIR/tags-new"
ok=true
for kind in tags branches; do GUARD_REFUSED=false UPSTREAM_SHA="$y2" bash "$here/sync-push.sh" "$kind" > "$root/yp/out.$kind" 2>&1 || ok=false; done
UPSTREAM_SHA="$y2" bash "$here/list-skipped-tags.sh"
if [ "$ok" = true ] && [ "$(git --git-dir="$root/yp/origin.git" for-each-ref --format='%(refname)' | tr '\n' ' ')" = "refs/heads/upstream/ytip refs/tags/v9.8.2 " ] &&
   [ "$(cat "$FORK_STATE_DIR/tags-skipped")" = v9.8.1 ]; then
  pass "intermediate refs: a commit whose config/mercurai differs from the pin is not pushed, and is listed for review"
else fail "intermediate refs: a commit whose config/mercurai differs from the pin is not pushed, and is listed for review"; cat "$root/yp/out."* "$FORK_STATE_DIR/tags-skipped"; fi
# A tag origin already holds at another commit is never rewritten, even when a stale list calls it new.
git push -q origin "$y0:refs/tags/v9.8.3"; git update-ref refs/upstream-tags/v9.8.3 "$y2"; echo v9.8.3 > "$FORK_STATE_DIR/tags-new"
rc=0; GUARD_REFUSED=false UPSTREAM_SHA="$y2" bash "$here/sync-push.sh" tags > "$root/yp/out.tags" 2>&1 || rc=$?
if [ "$rc" != 0 ] && [ "$(git --git-dir="$root/yp/origin.git" rev-parse refs/tags/v9.8.3)" = "$y0" ]; then pass "sync-push: a tag origin holds at another commit is not rewritten"
else fail "sync-push: a tag origin holds at another commit is not rewritten"; echo "rc=$rc"; cat "$root/yp/out.tags"; fi

# 33k. mirror-allowed-tag.sh: the owner's allow_tag=<tag>@<sha> mirrors exactly that tag, or nothing. A release tag sits on a release
# branch, so it is not inside the pin; v1.2.3 carries a workflow, v1.2.4 is the base commit.
at_setup() {
  rm -rf "$root/at"; mkdir -p "$root/at"; git init -q --bare "$root/at/origin.git"
  printf '#!/bin/sh\necho push >> "%s/at/pushes"\n' "$root" > "$root/at/origin.git/hooks/pre-receive"; chmod +x "$root/at/origin.git/hooks/pre-receive"; : > "$root/at/pushes"
  git init -q -b fork "$root/at/work"; cd "$root/at/work"; git remote add origin "$root/at/origin.git"
  commit a.txt 1 "base"; b0=$(git rev-parse HEAD)
  git checkout -q -b relbranch; mkdir -p .github/workflows; commit .github/workflows/r.yml r "release branch workflow"; r1=$(git rev-parse HEAD); git checkout -q fork
  git update-ref refs/upstream-tags/v1.2.3 "$r1"; git update-ref refs/upstream-tags/v1.2.4 "$b0"
  printf '%s v1.0.0\n' "$b0" > "$FORK_STATE_DIR/origin-tags"; rm -f "$FORK_STATE_DIR/tags-pushed"
}
at_run() { local rc=0; : > "$root/at/gho"; ALLOW_TAG=$1 GITHUB_OUTPUT="$root/at/gho" bash "$here/mirror-allowed-tag.sh" > "$root/at/out" 2>&1 || rc=$?; echo "$rc"; }
at_outputs() { tr '\n' ' ' < "$root/at/gho"; }
at_state() { echo "rc=$1 pushes=$(wc -l < "$root/at/pushes") refs=[$(git --git-dir="$root/at/origin.git" for-each-ref --format='%(refname)' | tr '\n' ' ')]"; }
at_setup; rc=$(at_run "v1.2.3@$r1")
if [ "$(at_state "$rc")" = "rc=0 pushes=1 refs=[refs/tags/v1.2.3 ]" ] && [ "$(cat "$FORK_STATE_DIR/allowed-tag")" = v1.2.3 ] && [ "$(cat "$FORK_STATE_DIR/allowed-tag-sha")" = "$r1" ] &&
   [ "$(at_outputs)" = "tag=v1.2.3 sha=$r1 " ]; then
  pass "allow_tag: the exact tag@sha mirrors that tag and only it"; else fail "allow_tag: the exact tag@sha mirrors that tag and only it"; at_state "$rc"; cat "$root/at/out"; fi
at_setup; git update-ref refs/upstream-tags/v1.2.3 "$b0"; rc=$(at_run "v1.2.3@$r1")
if [ "$(at_state "$rc")" = "rc=4 pushes=0 refs=[]" ] && [ ! -s "$FORK_STATE_DIR/allowed-tag" ]; then pass "allow_tag: a tag upstream moved is refused with zero pushes"; else fail "allow_tag: a tag upstream moved is refused with zero pushes"; at_state "$rc"; fi
at_setup; rc=$(at_run "v1.2.3@$b0")
if [ "$(at_state "$rc")" = "rc=4 pushes=0 refs=[]" ]; then pass "allow_tag: a wrong sha is refused with zero pushes"; else fail "allow_tag: a wrong sha is refused with zero pushes"; at_state "$rc"; fi
for bad in "v1.2.3" "v1.2.3@abc" "main@$r1" "v1.2.3@${r1^^}" "v1.2.3@${r1:0:39}" "v1.2@$r1" "v1.2.3@$r1 v1.2.4@$b0" "v1.2.3@$r1;x" ""; do
  at_setup; rc=$(at_run "$bad")
  if [ "$(at_state "$rc")" = "rc=2 pushes=0 refs=[]" ]; then pass "allow_tag: '$bad' is refused as malformed"; else fail "allow_tag: '$bad' is refused as malformed"; at_state "$rc"; fi
done
# Origin holds the tag at another commit: refused (exit 5), nothing pushed, no outputs.
at_setup; git push -q origin "$b0:refs/tags/v1.2.3"; : > "$root/at/pushes"; rc=$(at_run "v1.2.3@$r1")
if [ "$(at_state "$rc")" = "rc=5 pushes=0 refs=[refs/tags/v1.2.3 ]" ] && [ -z "$(at_outputs)" ] && [ ! -s "$FORK_STATE_DIR/allowed-tag" ] &&
   grep -q '::error::the fork already holds v1.2.3 at another commit' "$root/at/out"; then
  pass "allow_tag: a tag the fork holds at another commit is refused"; else fail "allow_tag: a tag the fork holds at another commit is refused"; at_state "$rc"; cat "$root/at/out"; fi
# A successful push, then a failed hand-off, then the same input again: zero further pushes, and the outputs come back.
at_setup; rc=$(at_run "v1.2.3@$r1"); first=$(at_state "$rc"); rc=$(at_run "v1.2.3@$r1")
if [ "$first" = "rc=0 pushes=1 refs=[refs/tags/v1.2.3 ]" ] && [ "$(at_state "$rc")" = "rc=0 pushes=1 refs=[refs/tags/v1.2.3 ]" ] && [ "$(at_outputs)" = "tag=v1.2.3 sha=$r1 " ] &&
   [ "$(cat "$FORK_STATE_DIR/allowed-tag")" = v1.2.3 ] && grep -q 'already on origin at' "$root/at/out"; then
  pass "allow_tag: a retry after a failed hand-off pushes nothing and emits the outputs again"; else fail "allow_tag: a retry after a failed hand-off pushes nothing and emits the outputs again"; echo "$first"; at_state "$rc"; cat "$root/at/out"; fi
# An annotated tag already on origin: its commit is on the peeled line.
at_setup; git tag -a -m annotated v1.2.3 "$r1"; git push -q origin refs/tags/v1.2.3; git tag -d v1.2.3 > /dev/null; : > "$root/at/pushes"; rc=$(at_run "v1.2.3@$r1")
if [ "$(at_state "$rc")" = "rc=0 pushes=0 refs=[refs/tags/v1.2.3 ]" ] && [ "$(at_outputs)" = "tag=v1.2.3 sha=$r1 " ]; then
  pass "allow_tag: an annotated tag already on origin at the approved commit is handed on without a push"; else fail "allow_tag: an annotated tag already on origin at the approved commit is handed on without a push"; at_state "$rc"; cat "$root/at/out"; fi
# Origin cannot be asked: nothing is pushed and nothing is handed on.
at_setup; git remote set-url origin "$root/at/nonexistent.git"; rc=$(at_run "v1.2.3@$r1")
if [ "$rc" = 6 ] && [ -z "$(at_outputs)" ] && grep -q '::error::could not ask origin about v1.2.3' "$root/at/out"; then pass "allow_tag: an unreachable origin is an error, not 'not held'"; else fail "allow_tag: an unreachable origin is an error, not 'not held'"; echo "rc=$rc"; cat "$root/at/out"; fi
# The automatic mirror pushed the approved tag earlier in the run (pin r1, so v1.2.3 and v1.2.3-rc.1 are both
# eligible); it hands on only the newest tag, and only if its dispatch worked (Finding 2fd3023b95eb).
at_auto() {  # at_auto: sync-push.sh tags on the pin r1; its rebase_tag output is what the automatic step would dispatch
  at_setup; git update-ref refs/upstream-tags/v1.2.3-rc.1 "$r1"; printf 'v1.2.3\nv1.2.3-rc.1\n' > "$FORK_STATE_DIR/tags-new"
  GUARD_REFUSED=false UPSTREAM_SHA="$r1" GITHUB_OUTPUT="$root/at/gho" bash "$here/sync-push.sh" tags > "$root/at/auto.out" 2>&1
}
at_auto; auto=$(cat "$root/at/gho"); rc=$(DISPATCHED_TAG=v1.2.3 DISPATCHED_SHA=$r1 at_run "v1.2.3-rc.1@$r1")
if [ "$auto" = "rebase_tag=v1.2.3" ] && [ "$(at_state "$rc")" = "rc=0 pushes=1 refs=[refs/tags/v1.2.3 refs/tags/v1.2.3-rc.1 ]" ] &&
   [ "$(at_outputs)" = "tag=v1.2.3-rc.1 sha=$r1 " ]; then
  pass "allow_tag: an approved tag the automatic step pushed but did not hand on is handed on, not pushed again"
else fail "allow_tag: an approved tag the automatic step pushed but did not hand on is handed on, not pushed again"; echo "$auto"; at_state "$rc"; at_outputs; cat "$root/at/out"; fi
at_auto; rc=$(at_run "v1.2.3@$r1")
if [ "$(at_state "$rc")" = "rc=0 pushes=1 refs=[refs/tags/v1.2.3 refs/tags/v1.2.3-rc.1 ]" ] && [ "$(at_outputs)" = "tag=v1.2.3 sha=$r1 " ] && [ "$(cat "$FORK_STATE_DIR/allowed-tag")" = v1.2.3 ]; then
  pass "allow_tag: when the automatic dispatch of the approved tag failed, allow_tag hands it on"
else fail "allow_tag: when the automatic dispatch of the approved tag failed, allow_tag hands it on"; at_state "$rc"; at_outputs; cat "$root/at/out"; fi
at_auto; rc=$(DISPATCHED_TAG=v1.2.3 DISPATCHED_SHA=$r1 at_run "v1.2.3@$r1")
if [ "$(at_state "$rc")" = "rc=0 pushes=1 refs=[refs/tags/v1.2.3 refs/tags/v1.2.3-rc.1 ]" ] && [ -z "$(at_outputs)" ] && [ ! -s "$FORK_STATE_DIR/allowed-tag" ]; then
  pass "allow_tag: the exact tag@sha the automatic step dispatched is not dispatched twice"
else fail "allow_tag: the exact tag@sha the automatic step dispatched is not dispatched twice"; at_state "$rc"; at_outputs; cat "$root/at/out"; fi
at_auto; rc=$(DISPATCHED_TAG=v1.2.3 DISPATCHED_SHA=$b0 at_run "v1.2.3@$r1")
if [ "$(at_state "$rc")" = "rc=0 pushes=1 refs=[refs/tags/v1.2.3 refs/tags/v1.2.3-rc.1 ]" ] && [ "$(at_outputs)" = "tag=v1.2.3 sha=$r1 " ]; then
  pass "allow_tag: the same tag dispatched at another commit does not count: the approved commit is handed on"
else fail "allow_tag: the same tag dispatched at another commit does not count: the approved commit is handed on"; at_state "$rc"; at_outputs; cat "$root/at/out"; fi
at_setup; git push -q origin "$b0:refs/tags/v1.2.3"; : > "$root/at/pushes"; rc=$(DISPATCHED_TAG=v1.2.3 DISPATCHED_SHA=$b0 at_run "v1.2.3@$r1")
if [ "$(at_state "$rc")" = "rc=5 pushes=0 refs=[refs/tags/v1.2.3 ]" ] && [ -z "$(at_outputs)" ]; then
  pass "allow_tag: the same tag dispatched at another commit, and held there, is still refused"
else fail "allow_tag: the same tag dispatched at another commit, and held there, is still refused"; at_state "$rc"; cat "$root/at/out"; fi

# 33l. list-skipped-tags.sh and render-tag-review.sh: a release tag outside the pin gets a review issue body; the owner-allowed one does not.
at_setup; printf 'v1.2.3\nv1.2.4\n' > "$FORK_STATE_DIR/tags-new"; rm -f "$FORK_STATE_DIR/allowed-tag"
UPSTREAM_SHA="$b0" bash "$here/list-skipped-tags.sh"
if [ "$(cat "$FORK_STATE_DIR/tags-skipped")" = v1.2.3 ]; then pass "skipped tags: the tag outside the pin is listed, the one inside it is not"; else fail "skipped tags: the tag outside the pin is listed, the one inside it is not"; cat "$FORK_STATE_DIR/tags-skipped"; fi
echo v1.2.3 > "$FORK_STATE_DIR/allowed-tag"; UPSTREAM_SHA="$b0" bash "$here/list-skipped-tags.sh"
if [ ! -s "$FORK_STATE_DIR/tags-skipped" ]; then pass "skipped tags: the owner-allowed tag is not listed"; else fail "skipped tags: the owner-allowed tag is not listed"; fi
rm -f "$FORK_STATE_DIR/allowed-tag"
git checkout -q relbranch; commit $'.github/we`ird' w "hostile name"; r2=$(git rev-parse HEAD); git checkout -q fork
bash "$here/render-tag-review.sh" v1.2.3 "$r2" "$b0" mercurai > "$root/at/body" 2>&1
if grep -qxF "gh workflow run fork-sync-upstream.yml --ref mercurai -f allow_tag=v1.2.3@$r2" "$root/at/body" && grep -qxF ".github/workflows/r.yml" "$root/at/body" &&
   grep -qxF ".github/we?ird" "$root/at/body" && grep -q "files changed" "$root/at/body" && ! grep -qF 'we`ird' "$root/at/body" &&
   ! internal_names "$root/at/body" && grep -qF 'Only the owner dispatches this, or someone the owner authorises after a security review of this diff.' "$root/at/body"; then
  pass "tag review body: the diff, the sanitised paths and the exact input"; else fail "tag review body: the diff, the sanitised paths and the exact input"; cat "$root/at/body"; fi
# Both lists stop at 50 lines: 62 guarded paths (2 under .github/, sorted first, then 60) list 48 of the 60, and say of how many.
git checkout -q relbranch; mkdir -p config/mercurai/many; for i in $(seq 1 60); do echo "$i" > "config/mercurai/many/f$i"; done; git add config; git commit -qm "many"
r3=$(git rev-parse HEAD); git checkout -q fork
bash "$here/render-tag-review.sh" v1.2.3 "$r3" "$b0" mercurai > "$root/at/body" 2>&1
if grep -qxF 'Paths (first 50 of 62):' "$root/at/body" && [ "$(grep -cE '^config/mercurai/many/f[0-9]+$' "$root/at/body")" = 48 ] &&
   [ "$(grep -cE '^ config/mercurai/many/f[0-9]+ +\|' "$root/at/body")" = 48 ] && ! grep -q 'files changed' "$root/at/body"; then
  pass "tag review body: the stat and the path list stop at 50 lines"; else fail "tag review body: the stat and the path list stop at 50 lines"; cat "$root/at/body"; fi

# 33m. tag-issues.sh against a stub gh: the per-run cap and the summary, closed issues, and whose words count as "reported".
cat > "$root/stub-gh" <<'STUB'
#!/usr/bin/env bash
# Stub gh: logs every call, serves canned issue and comment listings.
d=$STUB_DIR
echo "$*" >> "$d/calls.log"
case "$1 $2" in
  "api user") if [ -n "${STUB_FAIL_USER:-}" ]; then if [ "$STUB_FAIL_USER" = prints ]; then cat "$d/login"; fi; echo "HTTP 403: Resource not accessible by integration" >&2; exit 1; fi; cat "$d/login" ;;
  "api --paginate")
    case "$3" in
      */comments*) n=${3#*issues/}; n=${n%%/*}; cat "$d/comments-$n.ndjson" 2>/dev/null || true ;;
      *) cat "$d/issues.ndjson" 2>/dev/null || true ;;
    esac ;;
  "issue create") echo "https://example.invalid/issues/99" ;;
  *) : ;;
esac
STUB
chmod +x "$root/stub-gh"
ti_setup() {  # ti_setup <tag>...: those release tags sit on the release-branch commit, outside the pin (b0)
  at_setup; local t; : > "$FORK_STATE_DIR/tags-new"
  for t in "$@"; do git update-ref "refs/upstream-tags/$t" "$r1"; echo "$t" >> "$FORK_STATE_DIR/tags-new"; done
  rm -f "$FORK_STATE_DIR/allowed-tag"
  export STUB_DIR="$root/at/stub"; rm -rf "$STUB_DIR"; mkdir -p "$STUB_DIR"; echo the-bot > "$STUB_DIR/login"
}
ti_run() {  # TI_UP, TI_REFUSED and TI_MIRRORED override the pin, the guard result and the main mirror's outcome
  UPSTREAM_SHA="${TI_UP:-$b0}" FORK_MAIN="$b0" GUARD_REFUSED="${TI_REFUSED:-true}" MAIN_MIRRORED="${TI_MIRRORED:-success}" FORK_BRANCH=mercurai SYNC_ISSUE_LABEL=fork-sync GH_REPO=o/r GH="$root/stub-gh" \
    bash "$here/tag-issues.sh" > "$root/at/ti.out" 2>&1
}
ti_calls() { grep -c "^$1" "$STUB_DIR/calls.log" || true; }
issue_line() {  # issue_line <number> <title> <state> <login> <body>
  jq -nc --argjson n "$1" --arg t "$2" --arg s "$3" --arg l "$4" --arg b "$5" '{number:$n,title:$t,state:$s,login:$l,body:$b}'
}
# The cap: 8 skipped tags, none reported yet: 5 issues of their own and one summary naming the other 3.
ti_setup v2.0.1 v2.0.2 v2.0.3 v2.0.4 v2.0.5 v2.0.6 v2.0.7 v2.0.8
ti_run
if [ "$(ti_calls 'issue create')" = 6 ] && [ "$(grep -c '^issue create .*--title fork-sync tag: summary' "$STUB_DIR/calls.log")" = 1 ] &&
   [ "$(grep -c '^issue create .*--title fork-sync tag: v2.0.[0-9] needs owner review' "$STUB_DIR/calls.log")" = 5 ] && grep -q '3 release tags need owner review' "$STUB_DIR/calls.log" &&
   [ "$(grep -c '^issue create --label fork-sync-tag ' "$STUB_DIR/calls.log")" = 6 ]; then
  pass "tag issues: at most 5 new issues a run, the rest in one summary, all under the tag label"; else fail "tag issues: at most 5 new issues a run, the rest in one summary, all under the tag label"; cat "$STUB_DIR/calls.log" "$root/at/ti.out"; fi
# The summary lists what is left: each overflow tag with its commit, one per line (not an empty fence).
if grep -qx "v2.0.6 $r1" "$STUB_DIR/calls.log" && grep -qx "v2.0.7 $r1" "$STUB_DIR/calls.log" && grep -qx "v2.0.8 $r1" "$STUB_DIR/calls.log" && ! grep -qx "v2.0.1 $r1" "$STUB_DIR/calls.log" &&
   ! internal_names "$STUB_DIR/calls.log"; then
  pass "tag issues: the summary names every tag over the cap, with its commit"; else fail "tag issues: the summary names every tag over the cap, with its commit"; cat "$STUB_DIR/calls.log"; fi
# Listings are paged, never limited, and include closed issues; only the tag label is read.
if grep -q 'api --paginate repos/o/r/issues?state=all&labels=fork-sync-tag&per_page=100' "$STUB_DIR/calls.log" && ! grep -q -- '--limit\|state=open' "$STUB_DIR/calls.log"; then
  pass "tag issues: the lookup pages through every issue, open or closed"; else fail "tag issues: the lookup pages through every issue, open or closed"; cat "$STUB_DIR/calls.log"; fi
# A match found on the last of 250 listed issues is still found (no duplicate).
ti_setup v2.0.1
{ for i in $(seq 1 249); do issue_line "$i" "unrelated $i" open the-bot "x"; done; issue_line 250 "fork-sync tag: v2.0.1 needs owner review" open the-bot "allow_tag=v2.0.1@$r1"; } > "$STUB_DIR/issues.ndjson"
ti_run
if [ "$(ti_calls 'issue ')" = 0 ]; then pass "tag issues: an issue far down the listing is found, not duplicated"; else fail "tag issues: an issue far down the listing is found, not duplicated"; cat "$STUB_DIR/calls.log"; fi
# A closed issue of the bot that names the commit stays closed and quiet; with another commit it is reopened and commented on.
ti_setup v2.0.1
issue_line 7 "fork-sync tag: v2.0.1 needs owner review" closed the-bot "allow_tag=v2.0.1@$r1" > "$STUB_DIR/issues.ndjson"
ti_run
if [ "$(ti_calls 'issue ')" = 0 ]; then pass "tag issues: a closed issue stays closed while the tag's commit is unchanged"; else fail "tag issues: a closed issue stays closed while the tag's commit is unchanged"; cat "$STUB_DIR/calls.log"; fi
issue_line 7 "fork-sync tag: v2.0.1 needs owner review" closed the-bot "commit 0000000000000000000000000000000000000000" > "$STUB_DIR/issues.ndjson"
rm -f "$STUB_DIR/calls.log"; ti_run
if grep -q '^issue reopen 7' "$STUB_DIR/calls.log" && grep -q '^issue comment 7 ' "$STUB_DIR/calls.log" && [ "$(ti_calls 'issue create')" = 0 ]; then
  pass "tag issues: a closed issue is reopened and commented on when the tag's commit changed"; else fail "tag issues: a closed issue is reopened and commented on when the tag's commit changed"; cat "$STUB_DIR/calls.log"; fi
# Whose words count: a third party's comment, or a third party's issue of the same title, naming the commit silences nothing.
ti_setup v2.0.1
issue_line 7 "fork-sync tag: v2.0.1 needs owner review" open the-bot "old commit" > "$STUB_DIR/issues.ndjson"
jq -nc --arg b "seen allow_tag=v2.0.1@$r1" '{login:"mallory",body:$b}' > "$STUB_DIR/comments-7.ndjson"
rm -f "$STUB_DIR/calls.log"; ti_run
if grep -q '^issue comment 7 ' "$STUB_DIR/calls.log"; then pass "tag issues: a third party's comment naming the commit does not silence the bot"; else fail "tag issues: a third party's comment naming the commit does not silence the bot"; cat "$STUB_DIR/calls.log"; fi
ti_setup v2.0.1
issue_line 7 "fork-sync tag: v2.0.1 needs owner review" open mallory "allow_tag=v2.0.1@$r1" > "$STUB_DIR/issues.ndjson"
rm -f "$STUB_DIR/calls.log"; ti_run
if [ "$(ti_calls 'issue create')" = 1 ] && ! grep -q '^issue comment 7 ' "$STUB_DIR/calls.log"; then pass "tag issues: a third party's issue of the same title is not reused: the bot opens its own"; else fail "tag issues: a third party's issue of the same title is not reused: the bot opens its own"; cat "$STUB_DIR/calls.log"; fi
# The bare sha in the bot's own comment is not enough: only the exact allow_tag=<tag>@<sha> input counts.
ti_setup v2.0.1
issue_line 7 "fork-sync tag: v2.0.1 needs owner review" open the-bot "old commit" > "$STUB_DIR/issues.ndjson"
jq -nc --arg b "the commit $r1 again" '{login:"the-bot",body:$b}' > "$STUB_DIR/comments-7.ndjson"
rm -f "$STUB_DIR/calls.log"; ti_run
if grep -q '^issue comment 7 ' "$STUB_DIR/calls.log"; then pass "tag issues: the bare sha does not count as reported"; else fail "tag issues: the bare sha does not count as reported"; cat "$STUB_DIR/calls.log"; fi
# The input for the tag at an older commit is not the input for this one: the tag moved, so the bot reports again.
ti_setup v2.0.1
issue_line 7 "fork-sync tag: v2.0.1 needs owner review" open the-bot "allow_tag=v2.0.1@0000000000000000000000000000000000000000" > "$STUB_DIR/issues.ndjson"
rm -f "$STUB_DIR/calls.log"; ti_run
if grep -q '^issue comment 7 ' "$STUB_DIR/calls.log" && grep -q "allow_tag=v2.0.1@$r1" "$STUB_DIR/calls.log"; then pass "tag issues: the input for an older commit does not count as reported"; else fail "tag issues: the input for an older commit does not count as reported"; cat "$STUB_DIR/calls.log"; fi
ti_setup v2.0.1
issue_line 7 "fork-sync tag: v2.0.1 needs owner review" open the-bot "old commit" > "$STUB_DIR/issues.ndjson"
jq -nc --arg b "seen allow_tag=v2.0.1@$r1" '{login:"the-bot",body:$b}' > "$STUB_DIR/comments-7.ndjson"
rm -f "$STUB_DIR/calls.log"; ti_run
if [ "$(ti_calls 'issue ')" = 0 ]; then pass "tag issues: the bot's own comment naming the commit keeps it quiet"; else fail "tag issues: the bot's own comment naming the commit keeps it quiet"; cat "$STUB_DIR/calls.log"; fi
# The title is matched exactly: a longer title is another issue.
ti_setup v2.0.1
issue_line 7 "fork-sync tag: v2.0.1 needs owner review (copy)" open the-bot "allow_tag=v2.0.1@$r1" > "$STUB_DIR/issues.ndjson"
rm -f "$STUB_DIR/calls.log"; ti_run
if [ "$(ti_calls 'issue create')" = 1 ]; then pass "tag issues: the title is matched exactly"; else fail "tag issues: the title is matched exactly"; cat "$STUB_DIR/calls.log"; fi
# An existing summary (closed, different list) is reopened and edited, not duplicated.
ti_setup v2.0.1 v2.0.2 v2.0.3 v2.0.4 v2.0.5 v2.0.6 v2.0.7 v2.0.8
issue_line 40 "fork-sync tag: summary" closed the-bot "an older list" > "$STUB_DIR/issues.ndjson"
ti_run
if [ "$(ti_calls 'issue create')" = 5 ] && grep -q '^issue reopen 40' "$STUB_DIR/calls.log" && grep -q '^issue edit 40 ' "$STUB_DIR/calls.log"; then
  pass "tag issues: an existing summary is reopened and edited, not duplicated"; else fail "tag issues: an existing summary is reopened and edited, not duplicated"; cat "$STUB_DIR/calls.log"; fi
# An App installation token has no user: one clear error, non-zero, and nothing written to GitHub.
ti_setup v2.0.1 v2.0.2
rc=0; STUB_FAIL_USER=1 ti_run || rc=$?
if [ "$rc" != 0 ] && [ "$(grep -c '^::error::' "$root/at/ti.out")" = 1 ] && grep -q "::error::tag review issues need a user token; 'gh api user' failed or named no login, so FORK_BOT_TOKEN looks like an App installation token" "$root/at/ti.out" &&
   ! grep -q '^issue \|^label ' "$STUB_DIR/calls.log"; then
  pass "tag issues: a failing 'gh api user' gives one clear error and writes nothing"; else fail "tag issues: a failing 'gh api user' gives one clear error and writes nothing"; echo "rc=$rc"; cat "$root/at/ti.out"; cat "$STUB_DIR/calls.log"; fi
# An empty login (exit 0, no name) is the same error: without a login the bot would not recognise its own issues.
ti_setup v2.0.1 v2.0.2
: > "$STUB_DIR/login"
rc=0; ti_run || rc=$?
if [ "$rc" != 0 ] && [ "$(grep -c '^::error::' "$root/at/ti.out")" = 1 ] && grep -q "need a user token" "$root/at/ti.out" && ! grep -q '^issue \|^label ' "$STUB_DIR/calls.log"; then
  pass "tag issues: an empty login is an error and writes nothing"; else fail "tag issues: an empty login is an error and writes nothing"; echo "rc=$rc"; cat "$root/at/ti.out"; cat "$STUB_DIR/calls.log"; fi
# A 'gh api user' that fails is an error even when it printed a login first.
ti_setup v2.0.1 v2.0.2
rc=0; STUB_FAIL_USER=prints ti_run || rc=$?
if [ "$rc" != 0 ] && grep -q "need a user token" "$root/at/ti.out" && ! grep -q '^issue \|^label ' "$STUB_DIR/calls.log"; then
  pass "tag issues: a failing 'gh api user' that printed a login still writes nothing"; else fail "tag issues: a failing 'gh api user' that printed a login still writes nothing"; echo "rc=$rc"; cat "$root/at/ti.out"; cat "$STUB_DIR/calls.log"; fi
# A release-named tag upstream points at a tree is skipped with a warning; the next tag still gets its issue.
ti_setup v2.0.2
git update-ref refs/upstream-tags/v2.0.1 "$(git rev-parse 'fork^{tree}')"
printf 'v2.0.1\nv2.0.2\n' > "$FORK_STATE_DIR/tags-new"
rc=0; ti_run || rc=$?
if [ "$rc" = 0 ] && grep -q '^::warning::v2.0.1 does not point at a commit; skipped' "$root/at/ti.out" && [ "$(ti_calls 'issue create')" = 1 ] && grep -q '^issue create .*--title fork-sync tag: v2.0.2 needs owner review' "$STUB_DIR/calls.log"; then
  pass "tag issues: a tag that points at a tree is skipped with a warning, the next tag still gets its issue"; else fail "tag issues: a tag that points at a tree is skipped with a warning, the next tag still gets its issue"; echo "rc=$rc"; cat "$root/at/ti.out"; cat "$STUB_DIR/calls.log"; fi
# Each layer skips a tag that points at a tree on its own: list-skipped-tags.sh leaves it out of the list with the warning...
ti_setup v2.0.2
git update-ref refs/upstream-tags/v2.0.1 "$(git rev-parse 'fork^{tree}')"
printf 'v2.0.1\nv2.0.2\n' > "$FORK_STATE_DIR/tags-new"
UPSTREAM_SHA="$b0" bash "$here/list-skipped-tags.sh" > "$root/at/ls.out" 2>&1
if [ "$(cat "$FORK_STATE_DIR/tags-skipped")" = v2.0.2 ] && grep -qx '::warning::v2.0.1 does not point at a commit; skipped' "$root/at/ls.out"; then
  pass "skipped tags: a tag that points at a tree is left out of the list with a warning"; else fail "skipped tags: a tag that points at a tree is left out of the list with a warning"; cat "$FORK_STATE_DIR/tags-skipped" "$root/at/ls.out"; fi
# ... and tag-issues.sh skips it itself when it is handed one (a list-skipped-tags.sh stand-in puts it in the list).
rm -rf "$root/tiwrap"; mkdir -p "$root/tiwrap"; cp "$here/tag-issues.sh" "$here/render-tag-review.sh" "$root/tiwrap/"
printf '#!/usr/bin/env bash\nprintf "v2.0.1\\nv2.0.2\\n" > "$FORK_STATE_DIR/tags-skipped"\n' > "$root/tiwrap/list-skipped-tags.sh"
rm -f "$STUB_DIR/calls.log"
rc=0; UPSTREAM_SHA="$b0" FORK_MAIN="$b0" GUARD_REFUSED=true FORK_BRANCH=mercurai GH_REPO=o/r GH="$root/stub-gh" bash "$root/tiwrap/tag-issues.sh" > "$root/at/ti.out" 2>&1 || rc=$?
if [ "$rc" = 0 ] && grep -qx '::warning::v2.0.1 does not point at a commit; skipped' "$root/at/ti.out" && [ "$(ti_calls 'issue create')" = 1 ] &&
   grep -q '^issue create .*--title fork-sync tag: v2.0.2 needs owner review' "$STUB_DIR/calls.log"; then
  pass "tag issues: handed a tag that points at a tree, it skips it and still files the next"; else fail "tag issues: handed a tag that points at a tree, it skips it and still files the next"; echo "rc=$rc"; cat "$root/at/ti.out"; cat "$STUB_DIR/calls.log"; fi
# Handed a name with a backtick (a stand-in list again), the summary prints it sanitised, so it cannot break the fence.
ti_setup
printf 'v6.0.1\nv6.0.2\nv6.0.3\nv6.0.4\nv6.0.5\nv6.0.6`x\n' > "$root/tiwrap/names"
while read -r t; do git update-ref "refs/upstream-tags/$t" "$r1"; done < "$root/tiwrap/names"
printf '#!/usr/bin/env bash\ncp "%s/tiwrap/names" "$FORK_STATE_DIR/tags-skipped"\n' "$root" > "$root/tiwrap/list-skipped-tags.sh"
rc=0; UPSTREAM_SHA="$b0" FORK_MAIN="$b0" GUARD_REFUSED=true FORK_BRANCH=mercurai GH_REPO=o/r GH="$root/stub-gh" bash "$root/tiwrap/tag-issues.sh" > "$root/at/ti.out" 2>&1 || rc=$?
if [ "$rc" = 0 ] && grep -qx "v6.0.6?x $r1" "$STUB_DIR/calls.log" && ! grep -q "v6.0.6\`x $r1" "$STUB_DIR/calls.log"; then
  pass "tag issues: the summary list is sanitised"; else fail "tag issues: the summary list is sanitised"; echo "rc=$rc"; cat "$root/at/ti.out"; cat "$STUB_DIR/calls.log"; fi
# The update cap: 25 tags with an issue of the bot's that names an older commit: 20 comments, the other 5 in the summary.
tags25=(); for i in $(seq 1 25); do tags25+=("v3.0.$i"); done
ti_setup "${tags25[@]}"
for i in $(seq 1 25); do issue_line "$i" "fork-sync tag: v3.0.$i needs owner review" open the-bot "an older commit"; done > "$STUB_DIR/issues.ndjson"
ti_run
if [ "$(ti_calls 'issue comment')" = 20 ] && [ "$(ti_calls 'issue create')" = 1 ] && grep -q '^issue create .*--title fork-sync tag: summary --body 5 release tags' "$STUB_DIR/calls.log"; then
  pass "tag issues: at most 20 updates a run, the rest in the summary"; else fail "tag issues: at most 20 updates a run, the rest in the summary"; grep -c . "$STUB_DIR/calls.log"; head -c 600 "$root/at/ti.out"; fi
# A summary list larger than the pipe buffer must not fail the step (head would die on SIGPIPE under pipefail).
big=(); for i in $(seq 1 2000); do big+=("v5.0.$i"); done
ti_setup
for t in "${big[@]}"; do echo "create refs/upstream-tags/$t $r1"; done | git update-ref --stdin
printf '%s\n' "${big[@]}" > "$FORK_STATE_DIR/tags-new"
rc=0; ti_run || rc=$?
if [ "$rc" = 0 ] && [ "$(ti_calls 'issue create')" = 6 ] && grep -q '^issue create .*--title fork-sync tag: summary --body 1995 release tags' "$STUB_DIR/calls.log" &&
   [ "$(grep -cE "^v5\.0\.[0-9]+ $r1\$" "$STUB_DIR/calls.log")" = 50 ]; then
  pass "tag issues: a summary list past the pipe buffer is bounded without failing the step"; else fail "tag issues: a summary list past the pipe buffer is bounded without failing the step"; echo "rc=$rc"; head -c 600 "$root/at/ti.out"; fi
# The trusted tree is the pin only when the guard passed AND the main mirror succeeded.
ti_setup v2.0.1
git checkout -q fork; commit u.txt u "a newer upstream commit"; u1=$(git rev-parse HEAD)
TI_UP=$u1 TI_REFUSED=false TI_MIRRORED=success ti_run
if grep -q "trusted one (\`$u1\`)" "$STUB_DIR/calls.log"; then pass "tag issues: the pin is the trusted tree after a successful main mirror"; else fail "tag issues: the pin is the trusted tree after a successful main mirror"; head -c 800 "$STUB_DIR/calls.log"; fi
ti_setup v2.0.1
git checkout -q fork; commit u.txt u "a newer upstream commit"; u1=$(git rev-parse HEAD)
TI_UP=$u1 TI_REFUSED=false TI_MIRRORED=failure ti_run
if grep -q "trusted one (\`$b0\`)" "$STUB_DIR/calls.log"; then pass "tag issues: origin/main is the trusted tree when the main mirror failed"; else fail "tag issues: origin/main is the trusted tree when the main mirror failed"; head -c 800 "$STUB_DIR/calls.log"; fi
ti_setup v2.0.1
git checkout -q fork; commit u.txt u "a newer upstream commit"; u1=$(git rev-parse HEAD)
TI_UP=$u1 TI_REFUSED=true TI_MIRRORED=success ti_run
if grep -q "trusted one (\`$b0\`)" "$STUB_DIR/calls.log"; then pass "tag issues: origin/main is the trusted tree when the guard refused"; else fail "tag issues: origin/main is the trusted tree when the guard refused"; head -c 800 "$STUB_DIR/calls.log"; fi

# 33n. guard-step.sh: the guard's exit code becomes the step outputs, and nothing the script prints can set them.
gs_setup() { guard_setup; git update-ref refs/remotes/origin/main up; }
gs_run() {  # gs_run <ALLOWED_SHA>: runs the guard step on `up`; prints the exit status
  local rc=0; git checkout -q fork; : > "$root/gs.gho"
  FORK_BRANCH=fork UPSTREAM_SHA=$(git rev-parse up) ALLOWED_SHA=$1 GITHUB_OUTPUT="$root/gs.gho" bash "$here/guard-step.sh" > "$root/gs.out" 2>&1 || rc=$?
  echo "$rc"
}
gs_outputs() { tr '\n' ' ' < "$root/gs.gho"; }
gs_setup; git checkout -q up; commit docs/up.md up "upstream docs"
rc=$(gs_run '')
if [ "$rc" = 0 ] && [ "$(gs_outputs)" = "allowed=false refused=false " ]; then pass "guard step: a clean range is not refused"; else fail "guard step: a clean range is not refused"; echo "rc=$rc $(gs_outputs)"; cat "$root/gs.out"; fi
gs_setup; git checkout -q up; commit .github/workflows/evil.yml evil "upstream workflow"
rc=$(gs_run '')
if [ "$rc" = 0 ] && [ "$(gs_outputs)" = "allowed=false refused=true " ] && grep -qxF .github/workflows/evil.yml "$root/gs.out" && grep -qxF .github/workflows/evil.yml "$FORK_STATE_DIR/guarded"; then
  pass "guard step: a guarded range is refused and its paths listed"; else fail "guard step: a guarded range is refused and its paths listed"; echo "rc=$rc $(gs_outputs)"; cat "$root/gs.out"; fi
sha=$(git rev-parse up); rc=$(gs_run "$sha")
if [ "$rc" = 0 ] && [ "$(gs_outputs)" = "allowed=false refused=false allowed=true " ]; then pass "guard step: the owner's exact sha allows the range"; else fail "guard step: the owner's exact sha allows the range"; echo "rc=$rc $(gs_outputs)"; fi
rc=$(gs_run "${sha:0:12}")
if [ "$rc" = 0 ] && [ "$(gs_outputs)" = "allowed=false refused=true " ]; then pass "guard step: a short sha allows nothing"; else fail "guard step: a short sha allows nothing"; echo "rc=$rc $(gs_outputs)"; fi
# Exit 4 is also sed's I/O error: with no matching owner sha the step fails and sets neither refused nor allowed=true.
mkdir -p "$root/fakebin"; printf '#!/bin/sh\nexit 4\n' > "$root/fakebin/sed"; chmod +x "$root/fakebin/sed"
rc=$(PATH="$root/fakebin:$PATH" gs_run '')
if [ "$rc" = 4 ] && [ "$(gs_outputs)" = "allowed=false " ]; then pass "guard step: an exit 4 that is not the owner's sha fails the step"; else fail "guard step: an exit 4 that is not the owner's sha fails the step"; echo "rc=$rc $(gs_outputs)"; cat "$root/gs.out"; fi
rc=$(PATH="$root/fakebin:$PATH" gs_run 0123456789abcdef0123456789abcdef01234567)
if [ "$rc" = 4 ] && [ "$(gs_outputs)" = "allowed=false " ]; then pass "guard step: an exit 4 with a full sha that is not the pin fails the step"; else fail "guard step: an exit 4 with a full sha that is not the pin fails the step"; echo "rc=$rc $(gs_outputs)"; fi
# Only a full sha allows, even one spelled like the pin: here both are the ref name `up`.
rc=0; git checkout -q fork; : > "$root/gs.gho"
PATH="$root/fakebin:$PATH" FORK_BRANCH=fork UPSTREAM_SHA=up ALLOWED_SHA=up GITHUB_OUTPUT="$root/gs.gho" bash "$here/guard-step.sh" > "$root/gs.out" 2>&1 || rc=$?
if [ "$rc" = 4 ] && [ "$(gs_outputs)" = "allowed=false " ]; then pass "guard step: an owner value that is not a full sha allows nothing"; else fail "guard step: an owner value that is not a full sha allows nothing"; echo "rc=$rc $(gs_outputs)"; fi
git update-ref -d refs/remotes/origin/main; rc=$(gs_run '')
if [ "$rc" = 1 ] && [ "$(gs_outputs)" = "allowed=false " ]; then pass "guard step: a guard that fails sets no refused output"; else fail "guard step: a guard that fails sets no refused output"; echo "rc=$rc $(gs_outputs)"; cat "$root/gs.out"; fi

# 33n2. An exact owner sha also releases the result guard on a clean range (claude-code-config#1172).
gs_clean() { gs_setup; git checkout -q up; commit docs/up.md up "upstream docs"; }
gs_stub_run() {  # gs_stub_run <guard exit> <UPSTREAM_SHA> <ALLOWED_SHA>: guard-step beside a stub merge-guard.sh; prints the exit status
  local rc=0; rm -rf "$root/gstub"; mkdir -p "$root/gstub"; cp "$here/guard-step.sh" "$root/gstub/"
  printf '#!/usr/bin/env bash\nexit %s\n' "$1" > "$root/gstub/merge-guard.sh"
  git checkout -q fork; : > "$root/gs.gho"
  FORK_BRANCH=fork UPSTREAM_SHA=$2 ALLOWED_SHA=$3 GITHUB_OUTPUT="$root/gs.gho" bash "$root/gstub/guard-step.sh" > "$root/gs.out" 2>&1 || rc=$?
  echo "$rc"
}
gs_clean; sha=$(git rev-parse up); rc=$(gs_run "$sha")
if [ "$rc" = 0 ] && [ "$(gs_outputs)" = "allowed=false refused=false allowed=true " ]; then pass "guard step: the owner's exact sha allows a clean range too"; else fail "guard step: the owner's exact sha allows a clean range too"; echo "rc=$rc $(gs_outputs)"; cat "$root/gs.out"; fi
full_other=0123456789abcdef0123456789abcdef01234567
for v in "$full_other" "${sha:0:12}" "$(printf 'z%.0s' $(seq 1 40))" true; do
  gs_clean; rc=$(gs_run "$v")
  if [ "$rc" = 0 ] && [ "$(gs_outputs)" = "allowed=false refused=false " ]; then pass "guard step: a clean range with owner value '${v:0:12}' is not allowed and not refused"; else fail "guard step: a clean range with owner value '${v:0:12}' is not allowed and not refused"; echo "rc=$rc $(gs_outputs)"; fi
done
# Integration: the range guard passes, and the real result guard checks the approved merge tree.
for mode in exact none; do
  gs_clean; git checkout -q up; commit .github/workflows/ci.yml approved "approved workflow"; sha=$(git rev-parse up); git checkout -q fork; before=$(git rev-parse HEAD)
  if [ "$mode" = exact ]; then rc=$(gs_run "$sha"); else rc=$(gs_run ''); fi
  allowed=false; if grep -qx 'allowed=true' "$root/gs.gho"; then allowed=true; fi
  mrc=0; git checkout -q fork; GITHUB_OUTPUT="$root/mf.gho" FORK_STATE_DIR="$root" UPSTREAM_SHA=$sha GUARD_ALLOWED=$allowed bash "$here/merge-forward.sh" > "$root/mf.out" 2>&1 || mrc=$?
  if [ "$mode" = exact ]; then
    if [ "$rc" = 0 ] && [ "$allowed" = true ] && [ "$mrc" = 0 ] && git merge-base --is-ancestor up fork && [ "$(git rev-parse HEAD)" != "$before" ]; then
      pass "guard step + merge-forward: an exact sha keeps a merge the result guard would refuse"; else fail "guard step + merge-forward: an exact sha keeps a merge the result guard would refuse"; echo "rc=$rc allowed=$allowed mrc=$mrc"; cat "$root/mf.out"; fi
  else
    if [ "$rc" = 0 ] && [ "$allowed" = false ] && [ "$mrc" = 11 ] && [ "$(git rev-parse HEAD)" = "$before" ] && ! git merge-base --is-ancestor up fork; then
      pass "guard step + merge-forward: without the sha a merge the result guard refuses is reset"; else fail "guard step + merge-forward: without the sha a merge the result guard refuses is reset"; echo "rc=$rc allowed=$allowed mrc=$mrc"; cat "$root/mf.out"; fi
  fi
done
# A malformed value equal to the pin must not allow: a stub guard reaches the exit-0 arm with a pin that is not a sha.
gs_clean; rc=$(gs_stub_run 0 not-a-sha not-a-sha)
if [ "$rc" = 0 ] && [ "$(gs_outputs)" = "allowed=false refused=false " ]; then pass "guard step: a malformed owner value equal to the pin allows nothing on a clean range"; else fail "guard step: a malformed owner value equal to the pin allows nothing on a clean range"; echo "rc=$rc $(gs_outputs)"; fi
# Fail-closed arms under an exact owner sha.
gs_clean; sha=$(git rev-parse up)
rc=$(gs_stub_run 3 "$sha" "$sha")
if [ "$rc" = 0 ] && [ "$(gs_outputs)" = "allowed=false refused=true " ]; then pass "guard step: an exact sha does not release a refused range (exit 3)"; else fail "guard step: an exact sha does not release a refused range (exit 3)"; echo "rc=$rc $(gs_outputs)"; fi
rc=$(gs_stub_run 4 "$sha" "$sha")
if [ "$rc" = 0 ] && [ "$(gs_outputs)" = "allowed=false refused=false allowed=true " ]; then pass "guard step: an exact sha still releases a guarded range (exit 4)"; else fail "guard step: an exact sha still releases a guarded range (exit 4)"; echo "rc=$rc $(gs_outputs)"; fi
rc=$(gs_stub_run 4 "$sha" "$full_other")
if [ "$rc" = 4 ] && [ "$(gs_outputs)" = "allowed=false " ]; then pass "guard step: exit 4 with a mismatched full sha still fails the step"; else fail "guard step: exit 4 with a mismatched full sha still fails the step"; echo "rc=$rc $(gs_outputs)"; fi
rc=$(gs_stub_run 1 "$sha" "$sha")
if [ "$rc" = 1 ] && [ "$(gs_outputs)" = "allowed=false " ]; then pass "guard step: an unexpected guard failure under an exact sha fails the step"; else fail "guard step: an unexpected guard failure under an exact sha fails the step"; echo "rc=$rc $(gs_outputs)"; fi

# 33o. merge-forward.sh: a CR in git's merge output never reaches the log; the conflict list is sanitised.
guard_setup; commit $'docs/c\r::error::x' up "upstream adds it"; git checkout -q fork; mkdir -p docs; commit $'docs/c\r::error::x' fork "fork adds it too"
rc=$(mf_run false)
if [ "$rc" = 10 ] && ! grep -q $'\r' "$root/mf.out" && [ "$(grep -c . "$FORK_STATE_DIR/sync-conflicts")" = 1 ] && grep -q 'docs/c' "$FORK_STATE_DIR/sync-conflicts" &&
   ! grep -q $'\r' "$FORK_STATE_DIR/sync-conflicts" && ! grep -q '::' "$FORK_STATE_DIR/sync-conflicts"; then
  pass "merge-forward: no CR in the merge output, and the conflict list is sanitised"; else fail "merge-forward: no CR in the merge output, and the conflict list is sanitised"; echo "rc=$rc"; cat -v "$root/mf.out"; cat -v "$FORK_STATE_DIR/sync-conflicts"; fi

# 33p. list-new-tags.sh: new release names only, moved ones warned about, the fork's own names left out.
at_setup
git push -q origin "$b0:refs/tags/v1.0.0" "$b0:refs/tags/v1.0.1" "$b0:refs/tags/v1.0.4-mercurai.1"
for t in v1.0.0:$b0 v1.0.1:$r1 v1.0.2:$r1 v1.0.3-rc.1:$r1 v1.0.4-mercurai.1:$r1 main:$b0 v1:$b0; do git update-ref "refs/upstream-tags/${t%%:*}" "${t#*:}"; done
git update-ref -d refs/upstream-tags/v1.2.3; git update-ref -d refs/upstream-tags/v1.2.4
bash "$here/list-new-tags.sh" > "$root/at/out" 2>&1
if [ "$(tr '\n' ' ' < "$FORK_STATE_DIR/tags-new")" = "v1.0.2 v1.0.3-rc.1 " ] && [ "$(cat "$FORK_STATE_DIR/tags-moved")" = v1.0.1 ] &&
   grep -qxF '::warning::upstream moved tags the fork already holds; they are not mirrored: v1.0.1 ' "$root/at/out" && grep -qxF 'new tags: v1.0.2 v1.0.3-rc.1 ' "$root/at/out"; then
  pass "new tags: only new release names, the moved one warned about, the fork's own left out"; else fail "new tags: only new release names, the moved one warned about, the fork's own left out"; cat "$FORK_STATE_DIR/tags-new" "$root/at/out"; fi
at_setup; git update-ref -d refs/upstream-tags/v1.2.4
bash "$here/list-new-tags.sh" > "$root/at/out" 2>&1
if [ "$(cat "$FORK_STATE_DIR/tags-new")" = v1.2.3 ] && [ ! -s "$FORK_STATE_DIR/tags-moved" ]; then pass "new tags: an origin with no tags at all is fine"; else fail "new tags: an origin with no tags at all is fine"; cat "$root/at/out"; fi

# 33q. report-sync-issue.sh against a stub gh: the text of each stage, the lookups, and a report-only run.
rs_setup() {  # rs_setup: a fresh stub, and the state files the issue texts read
  at_setup; export STUB_DIR="$root/at/stub"; rm -rf "$STUB_DIR"; mkdir -p "$STUB_DIR"; echo the-bot > "$STUB_DIR/login"
  printf '.github/workflows/evil.yml\nconfig/mercurai/x.sh\n' > "$FORK_STATE_DIR/guarded"; printf 'base.txt\n' > "$FORK_STATE_DIR/sync-conflicts"
}
rs_run() {  # rs_run <stage> [PUSH]: prints the exit status
  local rc=0
  UPSTREAM_SHA="$r1" FORK_BRANCH=mercurai GH_REPO=o/r PUSH="${2:-true}" GH="$root/stub-gh" bash "$here/report-sync-issue.sh" "$1" > "$root/at/rs.out" 2>&1 || rc=$?
  echo "$rc"
}
rs_setup; rc=$(rs_run guard)
if [ "$rc" = 1 ] && grep -q "^issue create --label fork-sync --title fork-sync guard: upstream main $r1 changes guarded paths; nothing was pushed or merged into mercurai --body " "$STUB_DIR/calls.log" &&
   grep -qxF '.github/workflows/evil.yml' "$STUB_DIR/calls.log" && grep -q 'Nothing was pushed or merged: no main, no tags, no branches, no merge-forward' "$STUB_DIR/calls.log" &&
   grep -q "allow_guarded_merge_sha=$r1 " "$STUB_DIR/calls.log" && ! internal_names "$STUB_DIR/calls.log"; then
  pass "sync issue: a guard refusal files an issue saying nothing was pushed"; else fail "sync issue: a guard refusal files an issue saying nothing was pushed"; echo "rc=$rc"; cat "$STUB_DIR/calls.log"; fi
rs_setup; rc=$(rs_run merge)
if [ "$rc" = 1 ] && grep -q "^issue create --label fork-sync --title fork-sync guard: upstream main $r1: the merge into mercurai changed guarded paths and was reset --body " "$STUB_DIR/calls.log" &&
   grep -q 'so main, tags and branches were already mirrored from it' "$STUB_DIR/calls.log" && ! grep -q 'no main, no tags, no branches' "$STUB_DIR/calls.log" && grep -qxF '.github/workflows/evil.yml' "$STUB_DIR/calls.log" &&
   ! internal_names "$STUB_DIR/calls.log"; then
  pass "sync issue: a reset merge says main, tags and branches were already mirrored"; else fail "sync issue: a reset merge says main, tags and branches were already mirrored"; echo "rc=$rc"; cat "$STUB_DIR/calls.log"; fi
rs_setup; rc=$(rs_run conflict)
if [ "$rc" = 1 ] && grep -q "^issue create --label fork-sync --title fork-sync: mercurai does not merge with upstream main $r1 --body " "$STUB_DIR/calls.log" && grep -qxF 'base.txt' "$STUB_DIR/calls.log"; then
  pass "sync issue: a merge conflict files its own issue"; else fail "sync issue: a merge conflict files its own issue"; echo "rc=$rc"; cat "$STUB_DIR/calls.log"; fi
# Lookups page through every open issue; a refusal comments on an earlier refusal 35 issues down, never on a conflict issue.
rs_setup
{ for i in $(seq 1 34); do issue_line "$i" "unrelated $i" open the-bot x; done; issue_line 35 "fork-sync guard: upstream main 0000 changes guarded paths; nothing was pushed or merged into mercurai" open the-bot x; issue_line 36 "fork-sync: mercurai does not merge with upstream main 0000" open the-bot x; } > "$STUB_DIR/issues.ndjson"
rc=$(rs_run guard)
if grep -q '^issue comment 35 ' "$STUB_DIR/calls.log" && [ "$(ti_calls 'issue create')" = 0 ] && grep -q 'api --paginate repos/o/r/issues?state=open&labels=fork-sync&per_page=100' "$STUB_DIR/calls.log" && ! grep -q -- '--limit' "$STUB_DIR/calls.log"; then
  pass "sync issue: a guard refusal finds an earlier one far down the listing and comments on it"; else fail "sync issue: a guard refusal finds an earlier one far down the listing and comments on it"; cat "$STUB_DIR/calls.log"; fi
rc=$(rs_run conflict)
if grep -q '^issue comment 36 ' "$STUB_DIR/calls.log"; then pass "sync issue: a conflict comments on the earlier conflict issue"; else fail "sync issue: a conflict comments on the earlier conflict issue"; cat "$STUB_DIR/calls.log"; fi
rs_setup; issue_line 36 "fork-sync: mercurai does not merge with upstream main 0000" open the-bot x > "$STUB_DIR/issues.ndjson"; rc=$(rs_run guard)
if [ "$(ti_calls 'issue create')" = 1 ] && ! grep -q '^issue comment' "$STUB_DIR/calls.log"; then pass "sync issue: a refusal never lands on a conflict issue"; else fail "sync issue: a refusal never lands on a conflict issue"; cat "$STUB_DIR/calls.log"; fi
rs_setup; issue_line 35 "fork-sync guard: upstream main 0000 changes guarded paths; nothing was pushed or merged into mercurai" open the-bot x > "$STUB_DIR/issues.ndjson"; rc=$(rs_run conflict)
if [ "$(ti_calls 'issue create')" = 1 ] && ! grep -q '^issue comment' "$STUB_DIR/calls.log"; then pass "sync issue: a conflict never lands on a refusal issue"; else fail "sync issue: a conflict never lands on a refusal issue"; cat "$STUB_DIR/calls.log"; fi
# A report-only run prints the text and files nothing.
rs_setup; rc=$(rs_run guard false)
if [ "$rc" = 1 ] && [ ! -e "$STUB_DIR/calls.log" ] && grep -q '^fork-sync guard: upstream main' "$root/at/rs.out" && grep -qxF '.github/workflows/evil.yml' "$root/at/rs.out"; then
  pass "sync issue: a report-only run prints the issue and files nothing"; else fail "sync issue: a report-only run prints the issue and files nothing"; echo "rc=$rc"; cat "$root/at/rs.out"; fi
rs_setup; rc=$(rs_run nonsense)
if [ "$rc" = 2 ]; then pass "sync issue: an unknown stage is refused"; else fail "sync issue: an unknown stage is refused"; echo "rc=$rc"; fi

# 33r. merge-result-guard.sh: hostile path names are printed sanitised, and the list is bounded.
guard_setup; before=$(git rev-parse fork); git checkout -q up; commit $'.github/workflows/x\r::error::y`z' h "hostile"; mkdir -p config/mercurai/many
for i in $(seq 1 60); do echo "$i" > "config/mercurai/many/f$i"; done; git add config; git commit -qm "many"
git checkout -q fork; git merge -q --no-edit up
rc=0; bash "$here/merge-result-guard.sh" "$before" > "$root/guard.out" 2>&1 || rc=$?
if [ "$rc" = 3 ] && ! grep -q $'\r' "$root/guard.out" && ! grep -q '`' "$root/guard.out" && grep -qxF '.github/workflows/x???error??y?z' "$root/guard.out" &&
   [ "$(grep -c . "$root/guard.out")" = 51 ] && grep -qxF '... and 11 more' "$root/guard.out"; then
  pass "result guard: hostile names are sanitised and the list is bounded"; else fail "result guard: hostile names are sanitised and the list is bounded"; cat -v "$root/guard.out"; fi
# A rename inside the guarded paths lists both names, as the range guard does.
guard_setup; before=$(git rev-parse fork); git mv .github/workflows/ci.yml .github/workflows/renamed.yml; git commit -qm "rename"
git checkout -q fork; git merge -q --no-edit up
rc=0; bash "$here/merge-result-guard.sh" "$before" > "$root/guard.out" 2>&1 || rc=$?
if [ "$rc" = 3 ] && grep -qxF .github/workflows/ci.yml "$root/guard.out" && grep -qxF .github/workflows/renamed.yml "$root/guard.out"; then
  pass "result guard: a rename lists the old and the new name"; else fail "result guard: a rename lists the old and the new name"; cat "$root/guard.out"; fi

# 33s. merge-guard.sh fails closed: a ref it cannot resolve, or a tree it cannot read, is an error, never "nothing changed".
guard_setup; commit docs/up.md up "upstream docs"
rc=0; bash "$here/merge-guard.sh" fork up nosuchref > "$root/guard.out" 2>&1 || rc=$?
if [ "$rc" = 1 ] && ! grep -q 'no guarded path' "$root/guard.out"; then pass "guard: an unresolvable ref is an error"; else fail "guard: an unresolvable ref is an error"; echo "rc=$rc"; cat "$root/guard.out"; fi
guard_setup; commit .github/workflows/ci.yml A "upstream changes the workflow"
tree=$(git rev-parse up:.github); rm -f ".git/objects/${tree:0:2}/${tree:2}"
rc=0; bash "$here/merge-guard.sh" fork up > "$root/guard.out" 2>&1 || rc=$?
if [ "$rc" = 1 ] && ! grep -q 'no guarded path' "$root/guard.out"; then pass "guard: an unreadable tree is an error, not 'no guarded path'"; else fail "guard: an unreadable tree is an error, not 'no guarded path'"; echo "rc=$rc"; cat "$root/guard.out"; fi
# The union: the fork range's diff fails and a later range (empty, so it reads no tree) succeeds; the failure still counts.
rc=0; bash "$here/merge-guard.sh" fork up up > "$root/guard.out" 2>&1 || rc=$?
if [ "$rc" = 1 ] && ! grep -q 'no guarded path' "$root/guard.out"; then pass "guard: a failed diff in an earlier range of the union is an error"; else fail "guard: a failed diff in an earlier range of the union is an error"; echo "rc=$rc"; cat "$root/guard.out"; fi

# 34. The list is bounded.
guard_setup; mkdir -p config/mercurai/many; for i in $(seq 1 60); do echo "$i" > "config/mercurai/many/f$i"; done
git add config; git commit -qm "many"
guard_expect "guard: many guarded paths are refused" 3
if [ "$(grep -c . "$root/guard.out")" = 51 ] && grep -qxF "... and 10 more" "$root/guard.out"; then pass "guard: the list is bounded"; else fail "guard: the list is bounded"; cat "$root/guard.out"; fi
# A path list past the pipe buffer (about 110 KB) is bounded without a SIGPIPE failing the guard.
guard_setup; mkdir -p config/mercurai/long; long=$(printf 'x%.0s' $(seq 1 80))
for i in $(seq 1 1200); do echo "$i" > "config/mercurai/long/$long-$i"; done
git add config; git commit -qm "long names"
guard_expect "guard: a path list past the pipe buffer is refused" 3
if [ "$(grep -c . "$root/guard.out")" = 51 ] && grep -qxF "... and 1150 more" "$root/guard.out"; then pass "guard: a path list past the pipe buffer is bounded"; else fail "guard: a path list past the pipe buffer is bounded"; tail -3 "$root/guard.out"; fi

echo "$fails failure(s)"
[ "$fails" -eq 0 ]
