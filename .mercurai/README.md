# mercurai fork management

How `mercurai/orca` stays in sync with `stablyai/orca` without hands, and how a mercurai
release is chosen and assembled. Owner: harness. Last reviewed: 2026-10-08.

## Branches

| Branch | Content | Who writes it |
|---|---|---|
| `main` | exact mirror of `upstream/main`, fast-forward only | `fork-sync-upstream` (hourly) |
| `mercurai` (default) | `main` + this directory and the `fork-*` workflows, merged forward | `fork-sync-upstream`, reviewed PRs |
| `patch/<slug>` | one patch of the series, rebased onto the manifest `base:` tag | lanes, `fork-rebase-patches` |
| `release/mercurai` | assembled: an upstream release tag + the active patches, never hand-edited | `fork-assemble-release` |
| `upstream/*` | optional mirror of upstream branches (off by default) | `fork-sync-upstream` with `mirror_branches=true` |

Tags: upstream's tags are mirrored as they are; mercurai releases are `v<upstream>-mercurai.N`.

## The series: `.mercurai/patches.yaml`

One entry per patch branch. `status` is the only field the jobs branch on:

- `planned`: documented, not yet a branch; jobs skip it.
- `upstream-open`: a branch with an open upstream PR; rebased on every tag, included in releases.
- `ours-only`: a branch we keep without upstreaming; needs a reason in `notes`; rebased and included.
- `merged-upstream`: upstream carries every commit (`git cherry` shows none); dropped from the next
  release automatically; delete the entry when the tag that contains it is the base.

`tests` lists the Vitest files that prove the patch; the rebase and assembly jobs run them.

Adding a patch: branch `patch/<slug>` from the manifest `base:` tag, open the upstream PR from it,
add the entry with `status: upstream-open`, merge the manifest change into `mercurai` by PR.

## Workflows (all in the fork only, never sent upstream)

- `fork-sync-upstream`: hourly. Fast-forwards `main` to `upstream/main` (a non-fast-forward push
  fails the run; `main` never carries fork commits), mirrors tags (a moved tag is rejected, not
  forced), merges `main` into `mercurai` (a conflict opens a `fork-sync` issue and fails), then
  dispatches `fork-rebase-patches` for every new `vX.Y.Z` or `vX.Y.Z-rc.N` tag.
- `fork-rebase-patches`: with `tag`, rebases every active patch from its recorded base onto the
  tag, runs its tests, pushes with `--force-with-lease` (patch branches are the only branches where
  force is allowed), records the base in the manifest and marks patches upstream already merged.
  Daily without a tag it dry-rebases onto `upstream/main` and reports; a conflict opens or updates a
  `patch-conflict` issue naming the files. `rerere` is on, so a resolution done once in a lane
  replays.
- `fork-assemble-release`: manual. Checks the manifest base equals the tag, builds
  `release/mercurai` = tag + cherry-picked patches, runs the series tests, tags
  `v<upstream>-mercurai.N` and pushes both (`dry_run=true` pushes nothing). Building the installer
  and publishing it to the mercurai update channel is the next increment
  (mercurai/claude-code-config#1088).

## One-time setup

1. Actions on the fork: scheduled workflows in a fork are disabled until enabled once in the
   Actions tab ("Enable workflow" on each `fork-*` workflow), or via
   `gh api -X PUT repos/mercurai/orca/actions/workflows/<id>/enable`.
2. Upstream's own workflows also run in the fork on pushes to `main` and `mercurai`; disable the
   ones that need upstream secrets or runners (`gh api -X PUT repos/mercurai/orca/actions/workflows/<id>/disable`).
3. Optional `FORK_BOT_TOKEN` repository secret (fine-grained, contents and issues write on this
   repo): without it the jobs use `GITHUB_TOKEN`, which pushes and dispatches fine but whose pushes
   trigger no other workflow.
4. Branch protection: `main` and `mercurai` accept pushes only from the bot and reviewed PRs;
   `patch/*` branches may be force-pushed by the bot and the lane that owns them.

## Rules

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
