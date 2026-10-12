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
  mkdir -p .github/workflows config/mercurai config/mercurai-docs src docs
  commit base.txt one "base"; commit .github/workflows/ci.yml ci "ci"; commit config/mercurai/keep.md keep "keep"; commit src/a.txt a "a"
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

# 33d. merge-forward.sh: the merge, the result check and the reset, as the workflow runs them (the push stays outside).
mf_run() {  # mf_run <GUARD_ALLOWED>: merges `up` into `fork`; prints the exit status
  local rc=0; git checkout -q fork
  UPSTREAM_SHA=$(git rev-parse up) GUARD_ALLOWED=$1 bash "$here/merge-forward.sh" > "$root/mf.out" 2>&1 || rc=$?
  echo "$rc"
}
guard_setup; commit docs/up.md up "upstream docs"
rc=$(mf_run false)
if [ "$rc" = 0 ] && [ -f docs/up.md ] && git merge-base --is-ancestor up fork; then pass "merge-forward: a clean range merges"; else fail "merge-forward: a clean range merges"; cat "$root/mf.out"; fi
guard_setup; commit .github/workflows/evil.yml evil "upstream workflow"
git checkout -q fork; before=$(git rev-parse HEAD)
rc=$(mf_run false)
if [ "$rc" = 11 ] && [ "$(git rev-parse HEAD)" = "$before" ] && [ ! -e .github/workflows/evil.yml ] && grep -qxF .github/workflows/evil.yml "$FORK_STATE_DIR/guarded"; then
  pass "merge-forward: an unallowed guarded result is reset and exits 11"; else fail "merge-forward: an unallowed guarded result is reset and exits 11"; cat "$root/mf.out"; fi
git checkout -q up; rc=$(mf_run true)
if [ "$rc" = 0 ] && [ -f .github/workflows/evil.yml ]; then pass "merge-forward: an allowed guarded commit merges"; else fail "merge-forward: an allowed guarded commit merges"; cat "$root/mf.out"; fi
guard_setup; commit base.txt upside "upstream edits base"; git checkout -q fork; commit base.txt forkside "fork edits base"
before=$(git rev-parse HEAD); rc=$(mf_run false)
if [ "$rc" = 10 ] && [ "$(git rev-parse HEAD)" = "$before" ] && ! git rev-parse -q --verify MERGE_HEAD >/dev/null && grep -qxF base.txt "$FORK_STATE_DIR/sync-conflicts"; then
  pass "merge-forward: a conflict is aborted and exits 10"; else fail "merge-forward: a conflict is aborted and exits 10"; cat "$root/mf.out"; fi
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
    if [ "$1" = - ]; then env -u GUARD_REFUSED UPSTREAM_SHA="$u2" bash "$here/sync-push.sh" "$k" > "$root/sp/out.$k" 2>&1 || rc=$?
    else GUARD_REFUSED=$1 UPSTREAM_SHA="$u2" bash "$here/sync-push.sh" "$k" > "$root/sp/out.$k" 2>&1 || rc=$?; fi
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
   [ "$(cat "$FORK_STATE_DIR/rebase-tag")" = v1.0.0 ] && [ "$(wc -l < "$root/sp/pushes")" = 3 ]; then
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

# 34. The list is bounded.
guard_setup; mkdir -p config/mercurai/many; for i in $(seq 1 60); do echo "$i" > "config/mercurai/many/f$i"; done
git add config; git commit -qm "many"
guard_expect "guard: many guarded paths are refused" 3
if [ "$(grep -c . "$root/guard.out")" = 51 ] && grep -qxF "... and 10 more" "$root/guard.out"; then pass "guard: the list is bounded"; else fail "guard: the list is bounded"; cat "$root/guard.out"; fi

echo "$fails failure(s)"
[ "$fails" -eq 0 ]
