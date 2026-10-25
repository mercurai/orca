---
owner: Mercurai Orca release owner (Codex /root, delegated by the user)
last-reviewed: 2026-10-25
stability: draft
status: implementation in progress; promotion/coordinator changes committed locally and not released
---

# Mercurai upstream integration and release automation

## Purpose and executive summary

Keep Mercurai current with official Orca main and stable releases while preserving verified fork enhancements.
First integrate and release the current changes, including the missed async fixture correction and a mandatory
publication gate. Then extend the existing GitHub workflows and Orca schedules with bounded agent coordination.
Persist candidate identity and evidence outside agent chats. Never publish solely because selected tests pass,
conflicts disappear, an agent reports completion, or a dropdown exists.

This is the authoritative implementation plan for this effort and its implementation record. Phase 1's
promotion gate and Phase 4's durable state, precheck, dispatch adapter, coordinator workflow, and contract
documentation are implemented and committed locally but remain independently reviewed, landed, and unreleased. Phase 2 product
integration, protected CI, packaging, installation, and automation enablement are still pending.
The qualification workflow binds the reviewer identity to the candidate and controller, but the independent
fleet receipt is still owner-supplied input; P1.5 must validate that intake through the established review route
before any real publication.
The coordinator now resolves and persists the stable tag's peeled commit SHA and queues a new target when the
trusted controller revision changes, preventing stale candidate evidence from being reused after workflow changes.
The operational source of truth remains [the release README](../README.md) and [patch manifest](../patches.yaml).
Update those documents with behavior during implementation; avoid maintaining another parallel runbook.

## Workspace, scope, and reuse

Planning workspace: `C:/Users/svere/orca/worktrees/release-registration-20261023`.
Branch: `codex/release-registration-20261023`, implementation commit `f81c19fbb5`.
Owner: this release session. Purpose: implementation and release handoff. Related implementation PR: none;
prior registration PR #72 merged.
State: promotion/coordinator implementation committed locally; no branch landing, CI dispatch, release tag,
package publication, installation, or runtime verification performed.
Use this existing isolated workspace for the plan. Do not resume implementation on its stale branch without a reuse
and current-base check. Controller work follows live `mercurai`; product work follows the frozen main base.
No worktree or branch deletion is authorized. Retirement must preserve open comparison PR heads and bases.

`docs/plans/` is ignored in this checkout. This plan lives beside tracked fork tooling instead.
The parent orca-config session routing points to `harness/orca/sessions` in the vault; it governs session records,
not this repository-owned design. Any later vault session record must use Obsidian CLI and link this plan.

Reuse check performed before choosing the workspace:

| Existing capability | Decision |
| --- | --- |
| Hourly `fork-sync-upstream.yml` and protected-path guards | Extend detection and deduplication; retain guards. |
| Rebase workflow, series script, atomic leased push | Reuse patch preparation and conflict evidence. |
| `fork-assemble-release.yml`, `assemble-release.sh` | Preserve frozen-main assembly; qualify an immutable commit. |
| `fork-release-win-build.yml` and orcad template validation | Reuse secretless packaging and separate publication. |
| Orca schedules and supervised orchestration | Reuse bounded runs, isolated worktrees, tasks, dispatches, and gates. |

PR #70 hardened sync and PR #72 registered the previous release; both are merged. PR #71 is comparison CI, not a
competing coordinator. No competing automation PR was found in the open/recent PR scan. Preserve historical PRs.
Vault research through Obsidian found prior release ownership, protected-token boundaries, and fork integration
procedures in the October 12 and 13 handoffs; no existing release-automation plan matched the focused search.
CodeGraph was not available. Existing source, workflow, PR, and documentation inspection supplied the reuse evidence.
No new library, external agent service, always-running chat, or product UI is needed.

## Verified baseline and known defect

These are observations, not a frozen next-release target. Revalidate them before implementation.

| Item | Observed value |
| --- | --- |
| Official stable release | `v1.4.239`, published October 24, 2026 |
| Latest public Mercurai release | `v1.4.237-mercurai.2`, published October 23, 2026 |
| Official main during planning | `d58849a7d8d68929bd0e686571678d85e70740af` |
| Controller default branch | `mercurai@c5f11af2b2dae111070cc3938a9be20267e23e48` |
| Previous release upstream base | `54e8ee5e961c1b3a5972322e2f20cbeb7ff0da40` |

Earlier investigation at main `4e7c3538e506b7eebb069911be9269ac834c3356` counted 296 intervening commits and 199
overlapping upstream/fork paths. Those counts do not apply automatically to the newer planning snapshot.
Overlapping paths are review candidates, not demonstrated merge conflicts or proof that upstream replaced our behavior.

Previous candidate `fea33f5c8944a2dbd4cc29b0cd048e4ed47a5006` had successful targeted assembly/package checks,
but full CI run `39916170172` failed: one test file and 12 tests failed, with the aggregate check also failing.
`src/main/runtime/runtime-rpc/runtime-rpc-pairing.ts` changed `createPairingOffer` to async, while
`tests/e2e/paired-cli-agent-launch.unit.test.ts` inspected its Promise without awaiting it.
Correct that caller and examine callers affected by the same async conversion. Do not classify it as baseline noise.
This finding does not by itself demonstrate a runtime pairing defect.

The published `.2` commit was `8dc0af619f622f719be8c16818693f662a92cadd`; its tree matched the reviewed candidate.
Tree equality is useful provenance but does not justify claiming CI ran at a different commit.
The next pipeline must materialize, qualify, and tag one exact candidate commit.

### Current integration probe (2026-10-25)

The current upstream refs were revalidated in an isolated worktree: the earlier official `main` snapshot
`870038cfc646fd654a146f82d64f6019456319b6` advanced during this work to `d58849a7d8d68929bd0e686571678d85e70740af`;
stable `v1.4.239` resolves to peeled commit `47f77cf7018ebc0d046b82c6dde31cf704909162`; the fork controller remains
`c5f11af2b2dae111070cc3938a9be20267e23e48`. The active patch branch has eight commits from base
`54e8ee5e961c1b3a5972322e2f20cbeb7ff0da40`; its first retention commit changes 665 files.
The refreshed current-main merge probe reported 81 conflicts (79 content and two modify/delete; the stable-tag
probe remains 76). Conflicts include Codex service-tier/session options and turn start, runtime/persistence,
process/file async paths, package manifests, workflows, and renderer/session-wire code. An isolated review
scaffold at `codex/orca-upstream-reconcile-20261025` records merge commit `8f2fb7dc6d`; it used `-X ours` only
to expose the full tree and is not a release candidate. The two modify/delete cases were deliberately accepted:
upstream removed the unreachable hook IPC and replaced the old conversation-stop test with provider-specific
suites. The initial 79 content conflicts required bounded semantic reconciliation; no publication may
use the scaffold until each skipped upstream hunk has a disposition and exact-candidate CI passes.
The controller now records this evidence through `release-conflict-inventory.mjs`; its precheck refuses a
candidate with unresolved paths rather than dispatching an agent against an unreviewed merge.
It also derives `release-conflict-task-plan.mjs` packages with deterministic family ownership, bounded path counts,
and explicit writable paths; those packages remain blocked work until an isolated integrator resolves and reviews them.
The scaffold has since incorporated reviewed Codex turn-receipt handling (`305e97cc91`), process-host/Git capture
compatibility (`0d69ba4e3a`), and native catalog/session-wire allocation and intent fixes (`a066562e97`). A fresh
merge-tree probe against the new scaffold head reports 78 remaining conflict records; these changes reduce the
review surface but do not make the scaffold releasable.
The bounded follow-up lanes then recorded workflow/dependency reconciliation (`c61cb34a88`), runtime pairing
coverage (`96edfe2c5e`), SSH pairing and WSL journal fixes (`9319079fb6`), native mutation lifecycle and hook
cleanup (`eb0ef241dd`), and managed-runtime async persistence/host-restart compatibility (`a14c625a9c`). Their
combined diff was materialized as one candidate commit `3f330defd4410b4e51c31b66de02235113b29e6b` on the exact
official-main parent `870038cfc646fd654a146f82d64f6019456319b6`; merge-tree against that parent is clean and
the candidate is still local, unqualified, and unreleased. Independent review then found the known async pairing
fixture omission; candidate commit `2ad742a69b57027b04c8bfac8e3808502a4b43df` adds the required await. A second
review found structured-clone loss of `stderrBytes`; candidate commit `d3def6cf25c347d3629c97b462f238c31389181c`
restores both byte fields and adds invalid-UTF8/WSL-marker coverage. The current candidate is the three-commit
range from `870038cfc6` ending at `d3def6cf25`.
Independent review of `d3def6cf25` returned `accept` for the scoped integration corrections; this is a source-review
verdict only. Exact-candidate CI, package qualification, installation/runtime acceptance, and protected publication
remain open.
The latest-main refresh is a separate candidate merge commit `3c7d22012cfae09aa32ed03c41a306b201922e74` whose
upstream parent is `d58849a7d8`; it supersedes the three-commit `870038cfc6` candidate. Because the release assembler
cherry-picks linear patch branches, the identical tree was materialized as linear patch commit
`5ce0aead4533980294b8c26989a173501361ee27` on `patch/current-main-release-d58849a7d8`, followed by
`a06bff3b3578b1abf1abc73a5cce15a21bc02a1b` to replace a removed stop-test path with upstream's split coverage.
The current tree is `73fbf286056a9106df8acd1a947dda7c8f59263a`. Independent source review of the merge returned `accept`; exact-SHA
CI, package qualification, installation/runtime acceptance, protected publication, and remote branch registration
remain open.

### Upstream refresh probe (2026-10-25)

Official `main` advanced again to `695fc0081c373e3f83664e242b39490d71038b37`; stable `v1.4.239` remains
`47f77cf7018ebc0d046b82c6dde31cf704909162`. A read-only merge-tree replay of the registered candidate
`a06bff3b3578b1abf1abc73a5cce15a21bc02a1b` against the new main exits `1` with exactly three content conflicts:
`config/e2e-typecheck-baseline.txt`,
`src/renderer/src/components/native-chat/use-structured-agent-session-sends.ts`, and
`tests/e2e/cross-version-wire/cross-version-web-device-key.unit.test.ts`.
The deterministic conflict planner assigns the first and third paths to one bounded `other` task and the renderer
path to one `renderer` task. The current manifest remains pinned to the reviewed `d58849a7d8` candidate until these
three paths are reconciled semantically; no automatic ours/theirs resolution is authorized.

## Requirements and acceptance criteria

### Release completeness

- [ ] R1: Freeze an official main SHA, stable version floor, controller SHA, and ordered patch heads per candidate.
  Include current stable product changes; explicitly reconcile release-only tag differences. Queue later arrivals.
- [ ] R2: Inventory every active fork enhancement and disposition it as retained, upstream-equivalent, reconciled,
  or blocked. Require behavioral evidence before removing a patch. Never omit an enhancement silently.
- [ ] R3: Preserve async process/file work, bounded memory behavior, Codex speed selection, account/home/resume
  changes actually present in the active patch, remote compatibility, and release branding/channel behavior.
  Mark earlier proposed work absent from the patch as unimplemented; do not invent shipped scope.
- [ ] R4: Fix the missed async fixture, pass required full CI plus targeted regression checks at the candidate,
  and obtain independent review bound to that candidate and controller policy revision.
- [ ] R5: Publish a monotonic Mercurai version through existing protected packaging; report source, package,
  installation, and loaded runtime separately, preserving active user sessions and runtime-owned configuration.

### Recurring integration

- [ ] R6: Detect both main and stable release changes hourly, deduplicate them, and retain a durable queue when the
  desktop is unavailable. One active release owns the selected target; newer upstream work does not reset it.
- [ ] R7: Run agents only for eligible work in isolated owned worktrees, with bounded retries and explicit writable
  paths. Independent review and protected publication remain separate from implementation-agent completion.
- [ ] R8: Recover from controller, desktop, agent, and workflow interruption without duplicate publication, stale
  dispatch acceptance, overlapping release ownership, lost patches, or premature worker replacement.
- [ ] R9: Enforce promotion on manual and automatic entry points. Fail closed on stale or missing evidence,
  unexpected skips, guarded changes without authorization, altered tags, or unverified artifact provenance.
- [ ] R10: Document operator intervention, rollback limits, queue age, current blocker, release receipts, and
  automation pause/resume. Enable the recurring workflow only after rehearsal and the first qualified release.

## Design and tradeoffs

Use a thin coordinator over the existing workflows. GitHub detects changes and stores release state; Orca provides
bounded agent execution. A durable agent chat is optional convenience, never the source of release truth.
An entirely manual runbook cannot meet recurring freshness. A new standalone agent service duplicates existing Orca
scheduling, increases credential exposure, and is unnecessary. Blind conflict resolution with ours/theirs can silently
discard performance and compatibility fixes, so it is not an acceptable automation strategy.

### Candidate identity and evidence

Candidate identity includes repository, immutable upstream commit, stable tag and resolved commit, controller commit,
manifest digest, ordered patch commits, policy digest, assembled commit and tree, and allocated release version.
Validate full commit IDs and repository identity; tags and branch names alone are not candidate identity.
The stable tag is the naming/version floor. Review its product ancestry and differences instead of merging a release
version-only commit into main mechanically. Use the existing version allocator; do not preassign the next suffix here.
Reserve the version before materializing the final candidate, including any source version metadata.
The initial input freeze pins upstream and the patch inventory; integration produces new patch heads in a new
candidate generation. Final qualification binds the complete identity. Never mutate an already-qualified identity.

Materialize one candidate commit on a candidate branch before full CI and review. Preserve it for tagging.
A protected verifier independently recomposes expected content from the frozen inputs using trusted controller code.
It checks content, ordered patch pins, parent/base provenance, and exact candidate identity before promotion.
If existing PR CI tests a synthetic merge commit, record the actual checkout SHA/tree and run a qualification workflow
at the materialized candidate SHA; do not mislabel a PR head field as the tested revision.

A qualification receipt records CI workflow ID/path, trusted workflow revision, run ID, attempt, actual checkout SHA,
matrix coverage, conclusions, independent reviewer identity/verdict/reviewed SHA, controller policy digest, and URLs.
Required job identities come from reviewed controller policy, not candidate-supplied names or an arbitrary green check.
Use complete API pagination; an incomplete or truncated response is not approval. The latest relevant attempt must
finish successfully. Pending, cancelled, failed, missing, and unexpected skipped jobs block promotion.
Conditional skips need explicit policy predicates and evidence; selected-test mode never substitutes for full CI.

Review receipts may come from real fleet reviewers, but only the owner-controlled intake can authenticate and accept
them. An agent-written issue comment, label, JSON boolean, or self-review cannot authorize release.
Changing candidate content, patch order, controller policy, or reviewed inputs invalidates corresponding receipts.
Require qualification both before tag creation and before channel publication; direct build dispatch cannot bypass it.

### Durable state and serialization

Proposed state storage: one small JSON record on a dedicated `automation/release-state` branch, plus immutable Action
artifacts for receipts and one human-readable tracking issue per candidate. This avoids treating editable issue prose
as authority and avoids adding a database service. The trusted controller is the sole writer; agents submit evidence.
Create this branch only during implementation rollout. It contains state, not workflow files or conversation text.

Each transition reads the expected state commit, writes a child commit, and pushes fast-forward only. A concurrent
update fails and must reread/revalidate. Candidate ID, generation, owner, task/dispatch IDs, retries, active operation,
queued target, heartbeat, error code, and evidence links persist.
Do not store credentials, account data, or transcripts.
Keep one latest pending target plus the active candidate and bounded history; intermediate detections need no agents.

States: detected -> frozen -> integrating -> qualifying -> qualified -> tagged -> packaged -> published.
Record installed and runtime-verified as separate observations. blocked and failed preserve the resumable prior stage.
Only the trusted reducer may transition state after verifying the required evidence for that transition.
One active candidate owns source registration, tag allocation, and channel promotion. Agents may write only their
assigned isolated branches; shared manifest and controller landing remain release-owner operations.

Use a shared short mutation concurrency group for protected state/ref/channel mutations and compare-and-swap state.
Do not hold that group while waiting for a child workflow that needs it. Each privileged operation revalidates its
candidate generation and receipt immediately before mutation. Existing per-workflow groups remain for local overlap.
An expired heartbeat requests reconciliation; it does not prove an agent or remote process exited.
Record active run IDs before dispatch where possible and deduplicate dispatch with operation identity on recovery.
If a crash occurs after tag push, reuse that immutable tag and resume its build rather than allocate another version.
If publication status is uncertain, inspect channel assets and provenance before retrying. Never overwrite different
artifacts under an existing version or let an old rerun move the latest channel backwards.

### Agent ownership and conflict handling

| Role | Writable ownership | Output |
| --- | --- | --- |
| Release owner | Manifest, workflow landing, runbook, accepted state | Frozen inputs and promotion decisions |
| Product integrator | Assigned product/tests on isolated patch branch | Patch head and behavior evidence |
| Promotion worker | Verifier/schema/tests; assembly/build workflows | Qualification contract |
| Coordinator worker | Detector, reducer, precheck, task contract; sync/rebase workflows | Bounded orchestration |
| Independent reviewer | No implementation files | Candidate-bound verdict and blockers |

Promotion and coordinator workers must not concurrently edit shared schema or workflow files. Freeze the interface
after the promotion phase; assign later changes to one owner. Split product lanes only after enumerating actual
overlapping files. The release owner integrates their outputs and validates the combined candidate.

Start with at most two implementation workers plus one independent reviewer, subject to current fleet limits.
Local builds/tests remain prohibited without applicable host admission; use CI. No dependency on serverone is required.
Conflict agents get explicit upstream/base/patch pins, writable paths, behavior obligations, and acceptance tests.
Allow one initial attempt and at most two evidence-driven correction attempts per task. On repeated failure, persist
an actionable blocker and stop that task; do not loop, blindly resolve conflicts, or expand ownership.
Bound infrastructure retries separately. Product/test failures require a changed fix or diagnosis.

Orca adapters use existing automation and orchestration commands from the checked-in CLI specs. Persist run, task,
and dispatch IDs. A completion from an older dispatch does not satisfy the current attempt. Check active workers
before replacing them, and honor `release_pending`/`release_unknown` rather than broadly closing terminals.
Use a repository-targeted automation for new isolated worktrees, not a shared primary checkout.
`--reuse-session` depends on a live terminal and must never be needed for recovery.

The precheck exits nonzero for an empty or ineligible queue. Empty `gh ... --jq` output alone is insufficient.
Manual Orca runs bypass scheduled prechecks; the controller always rechecks eligibility, ownership, and release gates.
When the runtime is offline, GitHub retains pending work and reports its age. Resume by reconciling, not mass-spawning.

### Security, deployment, and rollback

Keep existing protected-path guards for `.github/`, `config/mercurai/`, and `config/scripts/`.
Scope authorization to the reviewed exact revision; never auto-authorize all future guarded changes.
Upstream source, PR text, and agent messages are inputs, not permission to weaken gates or execute arbitrary commands.
Agents and candidate tests receive no publisher token. Execute verifier code from a pinned trusted controller without
write secrets. Privileged jobs run no candidate repository code and consume only independently verified artifacts.
Preserve secretless uncached release builds and existing environment restrictions. Verify permissions by names/scopes,
not secret-value reads. Do not assume environment existence proves token configuration is complete.

Build and smoke the package in isolated CI. Retained profile, native picker/request, remote resume, and long-window
memory evidence are separate from an isolated 30-second launch. Record what was observed and what remains unverified.
Use existing performance contracts and deterministic scale fixtures; preserve prior limits and identify comparison
conditions before measuring. Do not invent quantitative improvement claims or run unrelated inference benchmarks.
Actual Ultrafast execution requires server-reported evidence; missing catalog metadata is an upstream limitation.

Do not restart the user's active app or replace runtime-owned settings automatically. Stage an update and report the
required user restart/resume action. Verify loaded executable path, version, and runtime identity after installation.
For native UI validation use the repository's Electron/CDP instructions; unavailable tooling blocks that evidence,
not source investigation. Do not replace it with an unapproved UI driver or claim the runtime was verified.

Rollback has two parts: disable new coordinator admission while preserving queue/evidence, then restore the prior
qualified publisher/controller path if needed. Prefer a forward repair for product regressions. An old installer is
not proof that the user's migrated profile can be downgraded. Qualify profile/schema compatibility before proposing
a downgrade, preserve active work, and record the exact known-good artifact and digest.

## Phased implementation plan

### Phase 1: freeze inputs and establish the minimum release gate

Dependencies: explicit implementation instruction; current repository/fleet orders; CI availability.
Parallelism: owner inventory and promotion worker may proceed independently; shared workflow edits have one owner.

- [ ] P1.1 Owner: revalidate open PRs, release/main refs, relevant ownership orders, and current default controller.
  Freeze the next candidate record and stable tag relationship. Inspect complete paginated deltas; record guarded
  paths and per-enhancement dispositions. Files: existing `config/mercurai/patches.yaml` plus candidate evidence.
  Verify every active patch has one disposition and every input has a resolved immutable ID.
- [x] P1.2 Promotion worker: specify then test a small verifier and receipt schema in proposed
  `config/mercurai/scripts/verify-promotion.mjs`, `verify-promotion.test.mjs`, and
  `config/mercurai/release-policy.json`. Add deterministic failure fixtures before implementing checks.
  Verify failed full CI with passing targeted checks, forged checks, stale review, latest-attempt failure, truncated
  API data, and wrong-SHA/same-tree cases all refuse promotion. Use the existing fork-scripts CI workflow.
- [x] P1.3 Promotion worker: extend `assemble-release.sh` and `.github/workflows/fork-assemble-release.yml` to
  materialize the candidate without tagging, qualify its exact commit, and independently verify recomposed inputs.
  Add `.github/workflows/fork-qualify-release.yml` as a trusted full-CI entry point reusing the PR test matrix.
  Extract a reusable workflow if needed; do not copy a divergent suite or rely on implicit PR event coverage.
  Pin required job/matrix identities and justified conditional skips in the reviewed release policy.
  Verify candidate ref movement, changed manifest/controller, and selected-unit mode cannot satisfy qualification.
- [x] P1.4 Promotion worker: enforce the same receipt in `fork-release-win-build.yml` before publication, including
  manual dispatch. Extend `release-workflow-token-scope.test.mjs` and related existing workflow contract tests.
  Verify direct publish bypass, unexpected skips, changed tag, altered artifact, and stale version all fail closed.
- [ ] P1.5 Owner: independently review and land the minimal gate through the established owner route, with full
  required controller CI at its exact revision. Update the README qualification section and remove stale assumptions
  only where supported by evidence. Do not enable recurring agent automation yet.

### Phase 2: integrate current upstream and preserve fork behavior

Dependencies: P1.1; product work can overlap P1.2-P1.4. Promotion requires all of Phase 1.
Parallelism: assign non-overlapping product paths only after inspecting the pinned upstream/fork diff.

- [ ] P2.1 Integrator: port the registered patch onto the frozen official main in an owned isolated branch.
  Reuse `rebase-series.sh` and existing patch conventions. Resolve conflicts by required behavior, not ours/theirs.
  Record upstream-equivalence evidence before dropping any hunk; leave proposed-but-unshipped features clearly marked.
- [ ] P2.2 Integrator: first reproduce the missed-await failure in CI, then correct
  `tests/e2e/paired-cli-agent-launch.unit.test.ts` and audit relevant `createPairingOffer` callers for awaited cleanup.
  Verify all 12 previous failing cases pass and no background async operation survives fixture teardown.
- [ ] P2.3 Integrator: preserve async/process, memory bounds, account/resume, local/SSH, and provider behavior.
  Reuse manifest tests and existing performance contracts; add tests only for unresolved changes and actual gaps.
  Compare upstream and candidate under matching deterministic fixtures, retaining required prior regression budgets.
- [ ] P2.4 Owner: register reviewed patch heads and test paths in `patches.yaml`; reconcile stale preparation notes.
  Reserve the version, update source version metadata and repository release notes, then freeze final patch order.
  Assemble one immutable candidate and obtain independent combined review plus
  full CI, targeted tests, typecheck, lint, compatibility, and packaging checks at the required exact revisions.
  Any corrective source change restarts affected qualification and review; do not waive the known async failures.

### Phase 3: publish and verify the next Mercurai release

Dependencies: Phases 1 and 2. This release precedes rollout of the complete recurring coordinator.
Parallelism: owner-controlled serial promotion; no competing release candidate.

- [ ] P3.1 Owner: confirm the reserved version remains unused; tag the qualified candidate SHA only.
  A collision blocks promotion; any changed version metadata requires a new candidate and qualification.
  Run protected Windows packaging and matching orcad template checks. Record installer/blockmap/update-manifest
  digests, build run and attempt, source/controller identities, and publication receipt.
- [ ] P3.2 Owner: publish the already-qualified release notes and append channel evidence for actual validation
  and remaining upstream limits. Correct the previous full-CI claim without rewriting old receipts.
  Confirm both release metadata and channel assets identify the new version and candidate.
- [ ] P3.3 Owner: stage the normal app update while preserving active work; report installation and loaded-runtime
  evidence separately. Verify retained conversations and applicable native behavior through approved tooling.
  Keep live gaps explicit; record any required user restart/resume action and tested rollback/forward-repair route.

### Phase 4: add recurring detection and bounded agent coordination

Dependencies: Phase 3; reuse the landed qualification interface. No extra product feature changes.
Parallelism: coordinator worker owns new scripts and sync/rebase workflows; owner owns README and task contracts.

- [x] P4.1 Coordinator worker: add proposed `config/mercurai/scripts/release-state.mjs` and its tests for validated
  transitions, expected-state commits, active generation, pending-target coalescing, retries, and evidence references.
  Exercise duplicate coordinators, stale workers, restart, uncertain publication, and crash after tag-before-build.
- [x] P4.2 Coordinator worker: extend `fork-sync-upstream.yml`, `report-sync-issue.sh`, and
  `fork-rebase-patches.yml` to record actionable candidates and deduplicate blockers by target/reason.
  Add one thin trusted `.github/workflows/fork-release-coordinate.yml` entry point for state transitions and dispatch.
  Preserve exact protected-range authorization and atomic series pushes; do not silently enable inherited workflows.
  The coordinator now records a deterministic bounded task plan for every conflict inventory; no task plan bypasses
  the unresolved-conflict admission block.
- [x] P4.3 Coordinator worker: add proposed `config/mercurai/scripts/release-precheck.mjs`,
  `config/mercurai/scripts/release-agent-dispatch.mjs`, and `config/mercurai/automation-contract.md`.
  Use the existing Orca CLI interfaces to reconcile and launch bounded workers from the local scheduled run.
  GitHub coordinates durable state and protected operations; it does not assume access to the user's Orca runtime.
  Claim the current generation through the trusted coordinator, invoke CLI commands with structured argv,
  persist returned run/task/dispatch IDs through that coordinator, and submit evidence without publisher credentials.
  Reconcile execution-host status as `live`, `unverifiable`, or `exited`; loss of contact never proves exit.
  Add behavioral tests for the adapter and precheck, including recovery between worker start and receipt persistence.
  Define bounded work/review tasks, precise writable paths, task/dispatch binding, and unconditional admission checks.
  Test empty queue, manual precheck bypass, offline host, stale completion, and worker release uncertainty.
- [x] P4.4 Owner: extend `config/mercurai/README.md` with lifecycle, required evidence, roles, blocker handling,
  recovery, pause/resume, publication versus runtime status, and rollback limits. Link this plan and CLI docs.
  Add queue age and blocker-change alerts without hourly duplicate comments. Record freshness as observed lag, not
  a promise that a release is always identical to a continuously moving main branch.

### Phase 5: rehearse, enable, and observe automation

Dependencies: Phase 4 reviewed and exact-revision CI passing; applicable runtime/tooling available.
Parallelism: independent reviewer checks security/recovery; owner alone registers and enables the schedule.

- [ ] P5.1 Run tokenless rehearsals against synthetic repositories and recorded non-sensitive CI metadata for clean
  updates, conflicts, guarded changes, incomplete comparisons, rate limits, CI failure, lost workers, and crashes.
  Verify dry-run cannot tag, publish, mutate the channel, enable an automation, or access production credentials.
- [ ] P5.2 Register an Orca automation disabled through the owning runtime's CLI; inspect its provider, repository,
  schedule, precheck, and task contract. Do not edit runtime-owned config directly. Run an explicit nonpublishing
  rehearsal whose controller guard executes even though manual runs omit the scheduler precheck. Use the checked-in
  `scripts/release-automation-spec.mjs` to produce the disabled registration argv; do not enable it in source.
- [ ] P5.3 Enable the verified hourly schedule through the existing CLI and record its automation ID and controller
  revision. Verify no-op cycles launch no workers and restart recovery resumes one existing candidate only.
  If the desktop is unavailable, verify the GitHub queue retains work and recovery does not duplicate agents.
- [ ] P5.4 Observe one complete upstream-to-release cycle using genuine eligible work after enabling; preserve all
  receipts. If no new upstream work exists yet, mark this acceptance pending rather than creating a production change.
  Confirm the pause mechanism, blocker alerts, monotonic channel behavior, and installation/runtime status reporting.

## Validation instructions and completion evidence

Before every local test, reread the host's `BUILD-FREEZE.md` and `TEST-SLOT-ROLLOUT.md` and use the shared
test-slot runner. A local build remains unperformed; CI is required for the full product qualification.
The following are CI commands/methods, not permission to bypass admission:

| Area | Validation method |
| --- | --- |
| Controller scripts | `node --test --test-concurrency=2 config/mercurai/scripts/*.test.mjs` in fork-scripts CI |
| Series/ref safety | `bash config/mercurai/scripts/test-fork-series-scripts.sh`; guard/token-scope tests |
| Async fixture | `pnpm test tests/e2e/paired-cli-agent-launch.unit.test.ts` in CI with runner limits |
| Product qualification | Full PR matrix, actual checkout SHA, typecheck/lint/compatibility and targeted tests |
| Release/runtime | Package/install smoke, artifact digests, channel proof, then retained-profile evidence |

The plan is complete when documented and independently checked; implementation completion requires R1-R10 evidence.
Independent plan review: `/root/spec_plan_checker` accepted this plan on October 24 after the version/notes ordering,
qualification workflow, and dispatch adapter corrections. This is not implementation approval or release readiness.
Controller coverage must test behavior and bypass attempts, not only search YAML strings or assert mock call counts.
Test identity boundaries at the privileged edge. Treat missing native UI or live-account evidence as a named gap.
Required live evidence cannot be converted into a passed gate merely because CI or an isolated smoke succeeded.

## Risks, dependencies, and stop conditions

| Risk or dependency | Mitigation or explicit stop condition |
| --- | --- |
| Upstream moves during integration | Freeze one candidate; queue next target; never rebase qualified work silently. |
| Overlapping performance changes | Review behavior and tests; preserve budgets; require equivalence evidence. |
| CI budget, rate limits, missing runs | Persist blocker; bound retries; never treat absent checks as green. |
| State or artifact tampering | Trusted writer, expected-parent updates, identity checks at promotion boundaries. |
| Native or rollback evidence absent | Keep acceptance pending; preserve user profile and active sessions. |

Do not resurrect historical unrelated fleet assignments from vault notes. Revalidate applicable owner routing at
implementation start; the user has delegated Orca release ownership to this session. Preserve test admission and
existing protected release mechanisms. Exact guarded-range and publisher authority remain mandatory.

Estimated work is dominated by the new upstream merge and its CI failures; do not promise a release time from the
earlier overlap count. Tasks are bounded per session, and the first release does not wait for Phases 4-5.

## Evidence references

- [Official v1.4.239](https://github.com/stablyai/orca/releases/tag/v1.4.239)
- [Published Mercurai .2](https://github.com/mercurai/orca-mercurai/releases/tag/v1.4.237-mercurai.2)
- [Existing comparison PR #71](https://github.com/mercurai/orca/pull/71)
- [Failed full-CI run](https://github.com/mercurai/orca/actions/runs/39916170172)
- [Sync hardening #70](https://github.com/mercurai/orca/pull/70)
- [Release registration #72](https://github.com/mercurai/orca/pull/72)
- Native CLI references: `docs/site/content/docs/cli/automations.mdx` and `orchestration.mdx`.
- Native implementation references: `src/cli/specs/automations.ts`, `src/cli/specs/orchestration-worker-specs.ts`,
  and `src/main/automations/headless-dispatch-runner.ts`.

Current implementation evidence: verifier tests 8/8, qualification/publisher contract tests 13/13,
state/dispatch/precheck/coordinator tests 15/15, and release token-scope tests 22/22 passed through the
shared runner before the latest candidate registration. The latest linear candidate's parent, tree, and
manifest pins were checked with Git; `git diff --check` passed. The fixture assembly suite is not locally
runnable because `yq` is absent; CI must run it. No product build, CI dispatch, release tag, package
publication, installation, runtime verification, or schedule enablement has occurred. The next action is
independent review of the exact registration diff, followed by CI at the controller and candidate SHAs.
