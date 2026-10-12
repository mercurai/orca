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
# separate repo with its own tags. The scripts keep their state in /tmp and read GITHUB_OUTPUT.
export GITHUB_OUTPUT="$root/out"
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
  printf '%s\n' "${@:2}" > /tmp/active
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
git push -q origin v1.0.1:refs/tags/v1.0.1-mercurai.2 v1.0.1:refs/tags/v1.0.1-mercurai.10
git push -q "$root/up.git" v1.0.1:refs/tags/v1.0.1-mercurai.50
fx_manifest v1.0.1 release/mercurai patch/a=v1.0.1
if run_assemble v1.0.1 && [ "$(out_of release_tag)" = v1.0.1-mercurai.11 ]; then
  pass "assemble numbers from the fork's tags and ignores upstream-only names"; else fail "assemble numbers from the fork's tags and ignores upstream-only names"; cat "$root/log"; fi

# 18. assemble: a release tag only upstream holds is not one the fork can build.
fx_setup; fx_patch a v1.0.1
git push -q "$root/up.git" fork:refs/tags/v1.0.2
fx_manifest v1.0.2 release/mercurai patch/a=v1.0.2
if run_assemble v1.0.2; then fail "assemble refuses a tag the fork does not hold"
elif [ ! -s "$GITHUB_OUTPUT" ] && ! git -C "$root/work" rev-parse -q --verify refs/heads/release/mercurai >/dev/null; then
  pass "assemble refuses a tag the fork does not hold"; else fail "assemble refuses a tag the fork does not hold"; fi

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
if run_rebase v1.0.1 patch/a patch/b && [ "$(grep -c . /tmp/rebased)" = 2 ] && [ ! -s /tmp/conflicted ] && [ ! -s /tmp/merged ] && [ "$(awk '$1 == "patch/a" {print $2}' /tmp/rebased)" = "$a0" ]; then
  while read -r _branch before after; do
    if [ "$before" = "$after" ] || ! git -C "$root/work" merge-base --is-ancestor v1.0.1 "$after"; then ok=0; fi
  done < /tmp/rebased
else ok=0; fi
if [ "$ok" = 1 ]; then pass "rebase-series rebases every patch onto the base"; else fail "rebase-series rebases every patch onto the base"; cat "$root/log"; fi

# 21. rebase-series: a conflicting patch is recorded and aborted; the others still rebase and no rebase is left running.
fx_setup; fx_patch a v1.0.0; fx_patch c v1.0.0 base.txt; fx_patch b v1.0.0
fx_manifest v1.0.0 release/mercurai patch/a patch/c patch/b
if run_rebase v1.0.1 patch/a patch/c patch/b && [ "$(cat /tmp/conflicted)" = "patch/c v1.0.0" ] &&
   grep -qx base.txt /tmp/conflicts/patch__c && [ "$(awk '{print $1}' /tmp/rebased | tr '\n' ' ')" = "patch/a patch/b " ] &&
   [ ! -d "$root/work/.git/rebase-merge" ] && [ ! -d "$root/work/.git/rebase-apply" ]; then
  pass "rebase-series records a conflict and carries on"; else fail "rebase-series records a conflict and carries on"; cat "$root/log"; fi

# 22. rebase-series: a branch outside patch/ is refused before any rebase.
fx_setup; fx_patch a v1.0.0
fx_manifest v1.0.0 release/mercurai patch/a
for bad in mercurai 'patch/../x'; do
  if run_rebase v1.0.1 patch/a "$bad"; then fail "rebase-series refuses '$bad'"
  elif grep -qF "patch branch '$bad' is not patch/<name>" "$root/log" && [ ! -s /tmp/rebased ]; then
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
else pass "fetch-rebase-inputs refuses a tag the fork does not hold"; fi


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

echo "$fails failure(s)"
[ "$fails" -eq 0 ]
