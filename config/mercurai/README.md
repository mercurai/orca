# mercurai fork management

How `mercurai/orca` stays in sync with `stablyai/orca` without hands, and how a mercurai
release is chosen and assembled. Owner: harness. Last reviewed: 2026-10-12.

## Branches

| Branch | Content | Who writes it |
|---|---|---|
| `main` | exact mirror of `upstream/main`, fast-forward only | `fork-sync-upstream` (hourly) |
| `mercurai` (default) | `main` + this directory and the `fork-*` workflows, merged forward | `fork-sync-upstream`, reviewed PRs |
| `patch/<slug>` | one patch of the series, rebased onto the manifest `base:` tag | lanes, `fork-rebase-patches` |
| `release/mercurai` | assembled: an upstream release tag + the active patches, never hand-edited | `fork-assemble-release` |
| `upstream/*` | optional mirror of upstream branches (off by default) | `fork-sync-upstream` with `mirror_branches=true` |

Tags: upstream's tags are mirrored as they are; mercurai releases are `v<upstream>-mercurai.N`.
Upstream cuts its tags on release branches, not on `main`, so "merged upstream" is always judged
against the tag being rebased onto, never against `main`.

## The series: `config/mercurai/patches.yaml`

One entry per patch branch. `status` is the only field the jobs branch on:

- `planned`: documented, not yet a branch; jobs skip it.
- `upstream-open`: a branch with an open upstream PR; rebased on every tag, included in releases.
- `ours-only`: a branch we keep without upstreaming; needs a reason in `notes`; rebased and included.
- `merged-upstream`: the tag carries every commit (nothing left after the rebase); dropped from the
  next release automatically; delete the entry when the tag that contains it is the base.

`base` is recorded per patch and at the top level, only after every active patch rebased onto a
tag; assembly refuses a series whose per-patch bases do not all equal the tag. `tests` lists the
Vitest files that prove the patch; the rebase and assembly jobs run them on the rebased code with
dependencies installed from that code's lockfile.

Adding a patch: branch `patch/<slug>` from the manifest `base:` tag, open the upstream PR from it,
add the entry with `status: upstream-open`, merge the manifest change into `mercurai` by PR.
A patch upstream squash-merges does not rebase cleanly (the squashed commit has a different
patch-id); it shows up as a `patch-conflict` issue and a human marks it `merged-upstream`.

`patch/fork-canary` is a permanent `ours-only` patch adding one file (`config/mercurai/CANARY.md`);
every rebase and assembly exercises it, and a mercurai build without that file did not get the
series.

## Workflows (all in the fork only, never sent upstream)

- `fork-sync-upstream`: hourly. Fast-forwards `main` to `upstream/main` (a non-fast-forward push
  fails the run; `main` never carries fork commits), mirrors new upstream release tags
  (`vX.Y.Z` and `vX.Y.Z-rc.N` names only; a tag the fork holds is never moved, a moved one warns), dispatches `fork-rebase-patches` for the newest new tag (a stable `vX.Y.Z` wins over an
  `-rc.N`; one dispatch per run), then merges `main` into `mercurai` (a conflict opens a
  `fork-sync` issue and fails the run; the tags were already handed on).
- `fork-rebase-patches`: with `tag`, rebases every active patch from its recorded base onto the
  tag, runs its tests, then a token-free test job's result is re-derived and pushed in one atomic
  `--force-with-lease` push of every branch and the manifest, all or nothing (patch branches are the only branches where
  force is allowed), and when every patch rebased, records the base and marks patches the tag
  already carries. Daily without a tag it dry-rebases onto `upstream/main` and reports; a conflict
  opens or updates a `patch-conflict` issue naming the files. `rerere` is on, so a resolution done
  once in a lane replays.
- `fork-assemble-release`: manual. Checks every active patch is recorded on the tag and contains
  it, builds `release/mercurai` = tag + cherry-picked patches (a patch with no commits beyond the
  tag is skipped with a warning), runs the series tests, tags `v<upstream>-mercurai.N` and pushes
  both, then dispatches `fork-release-win-build` with the new tag.
- `fork-release-win-build`: builds the Windows installer for a `v<upstream>-mercurai.N` tag and
  publishes it to the release channel (below). Dispatchable by hand with `-f tag=...` to rebuild
  or retry a tag.
- `fork-orcad-template`: builds the orcad deployment template for a ref. From upstream v1.4.224
  every SSH host runs a managed Orca server (orcad), which the desktop deploys from a template
  packaged inside the app; a build without it installs and then fails every SSH host. The fork
  builds `linux-x64-glibc` only (it covers `serverone`); upstream builds eight targets on six
  runners. `fork-release-win-build` calls it for the tag, downloads the template, packages with
  `ORCA_REQUIRE_ORCAD_TEMPLATE=1` and `ORCA_ORCAD_TEMPLATE_TARGETS=<the same list>` (the second
  comes from `patch/orca-partial-orcad-template`), and then checks the template inside the
  unpacked app with `config/mercurai/scripts/check-orcad-template.mjs`. A ref ships the template
  exactly when it carries `patch/orca-partial-orcad-template`: the v1.4.223 line does not and
  builds as before (upstream's template scripts exist there, but that line was always released
  without one), and a ref at v1.4.224 or later without the patch fails the build. To add a
  target: add its build lane to `fork-orcad-template` first, then widen the list; a host on a
  target outside the list gets no managed server and falls back to the legacy relay. A widened
  list ships only with a new app version: the desktop keys its unsupported-host record by version.
- `fork-release-win-build` jobs and what each holds: `preflight` (vets the dispatch; no secret,
  no repository code), `orcad-template` and `build-win` (build and package the ref's code; no
  secret), `publish` (the only job given `FORK_BOT_TOKEN`; runs no repository code, only uploads
  the three files `build-win` made). The owner's app updates itself from the channel repo, so
  the code being built never shares a job with the token that publishes it. `publish` exists
  only for a real build dispatched from the default branch; its condition reads the dispatch
  inputs and ref, which no build step can change.
  `config/mercurai/scripts/release-workflow-token-scope.test.mjs` pins all of this.
- `fork-release-win-build` dry run: `-f dry_run=true` builds, packages and checks the installer
  and keeps it as a run artifact; the run has no publish job. The artifact holds the installer
  alone, renamed `orca-windows-setup-DRY-RUN-<tag>.exe`, with no `latest.yml` and no blockmap,
  so nothing in it can be served as an update. `-f ref=<branch>` (dry run only) builds that ref
  under the tag's version. A dispatch from a branch other than the default branch is always a
  dry run.
- `fork-scripts-test`: on a push or PR that touches `config/mercurai/`, runs the fork scripts'
  own tests (`test-fork-series-scripts.sh`, `node --test "config/mercurai/scripts/*.test.mjs"`).

Report-only runs: `dry_run=true`, or any dispatch from a branch other than the default branch,
fetches, rebases or assembles and reports, but pushes nothing and opens no issue. That is how a
change to these workflows is tested from its PR branch.

## Release channel

A `v<upstream>-mercurai.N` tag becomes an installer on the `mercurai` update channel: the public
repo `mercurai/orca-mercurai`, Windows only. The channel code is the `orca-release-channel` patch
(`ours-only`, upstream will not take a fork channel): version scheme `1.4.222-mercurai.1`, repo
`mercurai/orca-mercurai`, unsigned Windows build like upstream's `adhoc` channel. `fork-release-win-build`
checks out the tag, builds, and publishes the installer, blockmap and `latest.yml` as a normal
release named by the tag (not a prerelease, so the channel's `/releases/latest` resolves).

Trust boundary:

- The channel is unsigned: no `publisherName`, `verifyUpdateCodeSignature` is false, so the app
  installs whatever `latest.yml` on that repo points at. Whoever can write to `orca-mercurai` can ship
  code to the host.
- Assets come from CI only: the one writer is the `publish` job of `fork-release-win-build`, the only
  job in that workflow given `FORK_BOT_TOKEN`; it runs no repository code. Nobody uploads by hand,
  and no write-scoped personal token is placed in a shell.
- What the workflow text cannot stop: anyone who can push a branch and dispatch a workflow can edit
  that branch's copy of the workflow and drop the guard, and the run then gets repository secrets.
  Branch protection on `mercurai` and `main` does not cover other branches. The platform fix is a
  GitHub environment restricted to `mercurai` holding the channel token (an open issue).
- `fork-assemble-release` and `fork-rebase-patches` run patch code only in a `test` job with no
  secret and no cache. Their `push` job holds `FORK_BOT_TOKEN`, runs no repository code, and derives
  the branch or series again with git alone. It pushes only trees the tests ran on. No release job
  restores an Actions cache, so a cache entry written by code under test reaches no job that holds
  the token. `release-workflow-token-scope.test.mjs` and `series-workflow-token-scope.test.mjs` pin
  this. A separate channel-only token for `publish` would also narrow what a leaked bot token can do
  (an open issue).
- First install is by hand: a signed upstream install verifies update signatures against upstream's
  publisher and refuses an unsigned update, so run the first `orca-windows-setup.exe` yourself. From
  then on routine update checks of a mercurai build read the channel repo (not upstream stable, which
  sorts above `X.Y.Z-mercurai.N`), so the next `-mercurai.N+1` arrives in-app. The channel picker's
  pinned-build check (`checkForPinnedBuild`) jumps back to upstream stable when wanted.

## One-time setup

1. `FORK_BOT_TOKEN` repository secret, required: a fine-grained token (or GitHub App installation
   token) for `mercurai/orca` with Contents, Workflows, Issues and Actions write. `GITHUB_TOKEN`
   is not enough: it cannot push commits that touch `.github/workflows`, and upstream changes those
   in most releases, so the hourly merge-forward would fail; its pushes also trigger no workflow.
   Only the jobs that write (the push and publish jobs, and the sync) use it, and they fail while
   it is missing.
2. Scheduled workflows in a fork are disabled until enabled once in the Actions tab ("Enable
   workflow" on each `fork-*` workflow), or via
   `gh api -X PUT repos/mercurai/orca/actions/workflows/<id>/enable`.
3. Upstream's own workflows also run in the fork on pushes to `main` and `mercurai`; disable the
   ones that need upstream secrets or runners (`gh api -X PUT repos/mercurai/orca/actions/workflows/<id>/disable`).
4. Release channel: add `mercurai/orca-mercurai` to the repositories of the `FORK_BOT_TOKEN`
   fine-grained token with Contents read and write; the token also needs Actions read and write on
   `mercurai/orca` so `fork-assemble-release` can dispatch the build. The publish job fails with an `::error::` naming
   this step when the upload is denied. The job also gives an empty channel repo its first commit.
5. Branch protection: `main` and `mercurai` accept pushes only from the bot and reviewed PRs;
   `patch/*` branches may be force-pushed by the bot and the lane that owns them.

## Rules

- Every patch stands on the bare tag by itself: its branch starts from the tag and touches files no other
  active patch touches. Stacking one patch on another is not supported: replaying the earlier patch's commits
  on the release branch conflicts once later commits of that patch changed the same files (seen on
  2026-10-09, run 37969444055). A lane that develops on top of another patch rebases its own commits onto the
  tag before the patch is recorded (`git rebase --onto <tag> origin/patch/<other>`).
- Patch CI: open a draft PR from the patch branch (unchanged) against `ci-base/<tag>`, a branch equal to the
  manifest base tag that `fork-rebase-patches` publishes per tag; upstream's `pr.yml` then runs on the tag plus
  the patch. Never merge the default branch into a patch for CI: it conflicts and stages upstream files.

- Upstream first: every `upstream-open` patch has an open PR on `stablyai/orca`; an `ours-only`
  patch has a one-line reason and should be a plugin, config key or env flag before it is a fork
  edit.
- Keep the series under ten patches; a patch with no upstream PR after 30 days gets a reason or is
  dropped.
- A rebase conflict or failing test never blocks the machine: the previous assembled release stays
  installed; the lane fixes the patch and reruns `fork-rebase-patches` with the tag.
- Never force-push `main` or `mercurai`; never rewrite mirrored tags.
- Local clones track `origin/main` with `git pull --ff-only`; lanes branch from the mirrored tags.

## Rollback

`main` and tags are a mirror: re-run `fork-sync-upstream`. A bad patch: set its `status` to
`planned` (or delete the entry), rerun `fork-assemble-release`, install the previous
`v<upstream>-mercurai.N-1`. A bad merge into `mercurai`: revert the merge commit by PR.
