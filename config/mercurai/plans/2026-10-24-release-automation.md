---
owner: Mercurai Orca release owner (Codex /root, delegated by the user)
last-reviewed: 2026-10-27
stability: draft
status: source reconciliation and release-gate repairs in progress; release held
---

# Mercurai upstream integration and release automation

## Purpose and executive summary

Keep Mercurai current with official Orca main and stable releases while preserving verified fork enhancements.
First integrate and release the current changes, including the missed async fixture correction and a mandatory
publication gate. Then extend the existing GitHub workflows and Orca schedules with bounded agent coordination.
Persist candidate identity and evidence outside agent chats. Never publish solely because selected tests pass,
conflicts disappear, an agent reports completion, or a dropdown exists.

This is the authoritative implementation plan and implementation record. The completion audit reopened
Phase 1's qualification and publication gates: verification coverage, review authentication, run correlation,
and immutable monotonic publication remain incomplete. Production admission remains disabled; the proposed
controller enables the protected manual path only after exact-revision gates and default landing.
Phase 4's durable-state and coordinator code is proposed and CI-tested, without operational acceptance or
schedule enablement. Phase 2 has a corrected source candidate on a frozen upstream base; newer upstream
changes, full CI, packaging, installation, and runtime acceptance remain pending.
The coordinator now resolves and persists the stable tag's peeled commit SHA and queues a new target when the
trusted controller revision changes, preventing stale candidate evidence from being reused after workflow changes.
The operational source of truth remains [the release README](../README.md) and [patch manifest](../patches.yaml).
Update those documents with behavior during implementation; avoid maintaining another parallel runbook.

## Host execution admission

The 04:50 UTC `LEGS DONE` order lifted the 03:23 hold. Wrapped pushes resume in
the recorded lane order; local test admission is unchanged and remains CI-only for this lane.
Before every push or remote Git ref mutation, reconstruct active global HOLD and matching LIFT orders
from the current fleet ledger. Its final progress lines are insufficient; an individual LEG completion
is not the all-lane `LEGS DONE` lift. Under a push hold, keep changes local and perform only source edits,
review and explicitly permitted CI work. Do not route around the hold through another API or venue.
Recheck build/test admission separately; this lane remains CI-only for compilation and tests.

Valid from 2026-10-27. Provenance: self-detected missed 03:23 UTC no-push order in session
`01a1273e-01d1-7e12-8f0f-99a926abdd95`. The durable lesson is in `harness/orca/lessons-log.md`.
No global harness or runtime-owned settings were changed.

## Workspace, scope, and reuse

Planning workspace: `C:/Users/svere/orca/worktrees/release-registration-20261023`.
Branch: `codex/release-registration-20261023`, containment implementation commit `ba18ca1c2c`.
Owner: this release session, designated release owner by the user. Purpose: implementation and release handoff.
Product draft PR: [#82](https://github.com/mercurai/orca/pull/82); historical #79 preserved; registration #72 merged.
State: controller and product branches pushed for hosted CI; no source landing, release tag, package publication,
installation, or runtime verification performed during this audit. Controller work follows `mercurai`;
product work follows the frozen main base. Preserve all current unlanded worktrees and comparison PRs.
Completed-work cleanup requires exact landing and ownership evidence under the user's standing instructions.

`docs/plans/` is ignored in this checkout. This plan lives beside tracked fork tooling instead.
The parent orca-config session routing points to `harness/orca/sessions` in the vault; it governs session records,
not this repository-owned design. Any later vault session record must use Obsidian CLI and link this plan.

Reuse check performed before choosing the workspace:

| Existing capability                                        | Decision                                                              |
| ---------------------------------------------------------- | --------------------------------------------------------------------- |
| Hourly `fork-sync-upstream.yml` and protected-path guards  | Extend detection and deduplication; retain guards.                    |
| Rebase workflow, series script, atomic leased push         | Reuse patch preparation and conflict evidence.                        |
| `fork-assemble-release.yml`, `assemble-release.sh`         | Preserve frozen-main assembly; qualify an immutable commit.           |
| `fork-release-win-build.yml` and orcad template validation | Reuse secretless packaging and separate publication.                  |
| Orca schedules and supervised orchestration                | Reuse bounded runs, isolated worktrees, tasks, dispatches, and gates. |

PR #70 hardened sync and PR #72 registered the previous release; both are merged. PR #71 is comparison CI, not a
competing coordinator. No competing automation PR was found in the open/recent PR scan. Preserve historical PRs.
Vault research through Obsidian found prior release ownership, protected-token boundaries, and fork integration
procedures in the October 12 and 13 handoffs; no existing release-automation plan matched the focused search.
CodeGraph was not available. Existing source, workflow, PR, and documentation inspection supplied the reuse evidence.
No new library, external agent service, always-running chat, or product UI is needed.

## Next release target and durable-controller audit

Owner update, 2026-10-27: official `v1.4.242` is published. The next publishing
candidate must include that release and the selected current-main snapshot while
retaining the reviewed Mercurai changes. Preserve the active 241 worktrees as
repair/recovery sources; finish their atomic regression boundary before creating
an isolated new candidate generation. Keep later arrivals queued after that freeze.

| Input                      | Recorded next target                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| Stable release             | `v1.4.242`, published 2026-10-27 00:09:03 UTC                                            |
| Annotated tag object       | `0360ad49840ab10d6493aa6c26c7d066d641eb95`                                               |
| Peeled stable commit       | `86ad9d95cac792f3d1359d886cef9fb9b0aadd47`                                               |
| Observed official main     | `cbbaa2d7635297916ea257a0287cc4ec6c12af25`                                               |
| Published Mercurai channel | `v1.4.237-mercurai.2`; no newer published/prerelease/draft entry in the 12-record census |

The earlier `217f9355` observation was 109 commits ahead of the active `823ca687` base. Main
advanced again to `cbbaa2d7` on the fresh read; it is queued, not a frozen candidate. Its API changed-file
list hit the 300-file cap, so a complete Git diff is required before classification.
Stable 242 diverges from that base: its two unique commits affect `package.json`,
`.github/workflows/pr.yml` and `.github/workflows/macos-updater-tests.yml`.
Classify those release-branch changes explicitly; do not assume version-only
variance or discard them with an ours/theirs selection. This is an owner-recorded
queue entry, not a claim that the disabled automation state branch was updated.
No new release suffix is allocated; use the existing allocator after freezing inputs.

The complete object-based Git diff to `cbbaa2d7` now counts 2,738 changed files and
115 upstream commits after `823ca687`; this replaces the capped API inventory.
A virtual merge of reviewed `cd3e51b6c3` with that main snapshot reports 12
conflicts: six WSL/store/test conflicts and six filesystem, host-dispatch,
worktree-cache, delivery-loop and secure-file test conflicts. The WSL dispositions
test was deleted upstream; trace its replacement instead of restoring an obsolete
inventory mechanically. No source files, index or branch changed during this
inspection. Bounded read-only workers classified the contracts while hosted
regression CI ran; actual integration remains a separate owned generation.

Resolution must preserve official pending-stop/kept-record semantics alongside
Mercurai serialized async store mutations and connector/generation fences.
New `setWslHostPendingStop` and removal/admission callers need explicit async
propagation; pending stop must be rechecked after reachability/withdrawal awaits.
Keep both raw-UNC admission and fingerprint caching, excluding unresolved WSL
UNC paths before fingerprint I/O. Combine official delivery-loop ownership guards
with actionable speed failures. Host removal must return awaited typed stop
receipts, preserving `kept:true`. Accept the intentional upstream dispositions
suite deletion while retaining real move/projection/journal behavior coverage.
Secure-file async/ACL tests need the retained security fixture import. Do not
resolve these contracts by selecting an entire side of the merge.

The current full source run `40453877833` exposed 29 failing assertions across
five unit shards, plus persistence cleanup errors and Vitest failure-stack errors.
Real WSL, Windows/Linux packaging and compatibility checks passed at `eba9`.
Independent reviews accepted the first CI-contract repairs, later CI fixture
updates and a deterministic port-repair regression. Further real-file connector
persistence/publication regressions are committed for hosted RED before
production changes. Source regression boundary `cd3e51b6c3` is now reviewed, lint-clean and pushed;
controller registration includes the current CI repairs locally. Neither tip is
qualified, landed or published. Shared push admission remains required.

The durable pipeline is source-only and unregistered. Reopen P4.3: the dispatcher
currently validates a local version and lease owner, but does not independently
enforce candidate/task eligibility, lease freshness, conflict-task scope or
remote state-commit authority. Its optional local persistence is not a complete
durable claim/settlement path. The precheck currently refuses conflicts, so it
cannot by itself admit bounded conflict-resolution work. Keep publication blocked
on unresolved conflicts while separately admitting approved, isolated resolution
work. Verify actual native CLI semantics before choosing retry/reconciliation IDs.

Complete that wiring with one trusted state writer, expected-parent updates,
intent checkpoints before external mutations, actual run/task/dispatch receipt
reconciliation, and fail-closed handling of ambiguous worker outcomes. Then run
tokenless crash/duplicate/conflict rehearsals, register the repository-targeted
Orca automation disabled, inspect its owner/host/account bindings, and enable the
hourly GitHub/local wakeups only after the release and operational gates pass.
Durability comes from recorded state and receipts; worker sessions remain bounded.

## Current candidate and completion audit

Audited 2026-10-27. No default landing, version reservation, final qualification, release tag,
publication, installation, loaded-runtime acceptance or recurring activation is complete.
Later upstream arrivals belong to a subsequent queued target; do not chase moving main during qualification.

| Input or lane        | Current record                                                                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frozen official main | `823ca6870fd46bc979ee073ee0731516a0607daa`                                                                                                                                              |
| Stable floor         | `v1.4.241`, peeled `041baf356b368d773f333e76375ce860fba2481b`                                                                                                                           |
| Product source       | `patch/current-main-release-823ca@ad46260b3da8929d0c1e13c49fd6d7a8577172a6`, [#82](https://github.com/mercurai/orca/pull/82)                                                            |
| Controller           | `codex/release-registration-20261023`, [#80](https://github.com/mercurai/orca/pull/80), ready for review; manual-admission policy correction over tested `bbb2c308ad` requires fresh CI |
| Admission            | Candidate sets `promotionEnabled: true` for protected manual admission after CI/review-gated landing; recurring coordinator remains off                                                 |

Pushed source `cd3e51b6c3` has eleven linear commits after the frozen base, tree
`72a486cbb6c1961ec708b16d13f82c4f1f48b1cf`. Local `ad46260b3d` adds the twelfth commit,
tree `4449d00fc7c51ffb00a733fbb57850f3f67091f6`, and awaits shared push admission. The manifest registers 248 unique existing tests, including the retained runtime WebSocket regressions.
Stable is not an ancestor of main: its sole stable-only change is package version metadata. Its functional
parent is already included. The canonical release build binds `ORCA_MERCURAI_BUILD_VERSION` to the
reserved tag while preserving source identity; verify packaged and loaded versions separately.
Historical source PR #79 and comparison/recovery refs remain unlanded recovery evidence.

### Source audit

The audit disproved completion claims around speed precedence, unlisted saved-model binding, WSL wake
revocation and newly async journal writes. Corrections preserve upstream conversation/catalog ownership,
explicit launch intent and no-boot recovery alongside exact tiers, async persistence and host fences.

| Source / hosted run                                                                     | Observed evidence and limit                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `c777bcfc` / [40429242854](https://github.com/mercurai/orca/actions/runs/40429242854)   | Windows 1,282 passed, 21 failed, 16 skipped; reproduced reviewed defects and one extraction error.                                                                                                          |
| `03094fa753` / [40439842064](https://github.com/mercurai/orca/actions/runs/40439842064) | 99 files: 1,340 passed, eight failed, 16 skipped; six journal regressions and two existing idempotency failures.                                                                                            |
| `065d0b6103` / [40442414377](https://github.com/mercurai/orca/actions/runs/40442414377) | All 99 Windows files passed: 1,349 passed, 16 skipped. Both cost jobs and 25 qualification contracts passed.                                                                                                |
| `6941c6cd4a` / [40445267648](https://github.com/mercurai/orca/actions/runs/40445267648) | Full PR RED at duplicate-import gate; dependency isolation/typecheck, lint, format, ratchet, mobile bundle and real WSL checks passed. Changed-code gates and full unit/package matrix remained incomplete. |

Independent reviews accepted speed/model, WSL, journal and structural/type repairs. The latest source
combines the two catalog-discovery imports without changing bindings. Pinned formatter and normal/native
scoped lint passed for that file. Earlier full format checks passed 38,530 source files with two threads.
At `d83942ea1a`, targeted [40447857538](https://github.com/mercurai/orca/actions/runs/40447857538)
passed 1,349 Windows tests (16 skipped), both cost jobs and 25 contracts. Full PR
[40447857412](https://github.com/mercurai/orca/actions/runs/40447857412) failed on two
runtime-test type assertions. Independently reviewed `eba9a02316` replaces them with
Zod response validation and a direct property-absence assertion; scoped formatting passed.
After shared-slot admission, exact `eba9a02316` targeted
[40453877785](https://github.com/mercurai/orca/actions/runs/40453877785) passed all 99 Windows files:
1,349 passed, 16 skipped; both cost jobs and 25 contracts passed. Full source
[40453877833](https://github.com/mercurai/orca/actions/runs/40453877833) passed static analysis/typecheck,
changed-code quality, dependency isolation, mobile bundle, compatibility, real WSL and Windows packaging.
All five unit shards later failed, with 29 failing assertions; fake-WSL E2E also failed.
Reviewed source `cd3e51b6c3` adds real-file connector/port-race coverage, awaited fixtures,
current native-session expectations and Actions-expression contracts. All 23 paths were
reviewed, including the six-test CI extraction; scoped lint and diff checks were clean.
Production connector and port-CAS repairs remain unchanged until hosted RED.
Targeted [40466899243](https://github.com/mercurai/orca/actions/runs/40466899243) and full
[40466899212](https://github.com/mercurai/orca/actions/runs/40466899212) were queued;
terminal results are recorded below. No full qualification receipt exists.
At `cd3e51`, full run40466899212 stopped at repository guard122064384798: its required-context
checker still pins the old PR-only condition, incompatible with the reviewed workflow-call admission.
Independent review accepted the exact-condition correction and real-verifier regressions.
Targeted Linux job122064383542 passed237cost tests, then failed99contract tests (98missing-input
fixture errors and one real-child observer identity failure); the later persistence step was skipped.
Keep that step cancellation-aware and independent so earlier failure cannot hide its RED evidence.
Targeted Windows job122064383986 passed all99files:1349tests passed,16skipped.
Reviewed `ad46260b3d` repairs the guard, synthetic inputs and concrete CommonJS observer leaf;
scoped formatting/lint and diff checks passed. Its wrapped push returned `TEST_SLOT=BUSY`
before Git ran; remote remains `cd3e51`. Controller registers the local revision provisionally;
push source first after admission, then controller. No runtime-CAS/connector fix is admitted yet.
No prior receipt qualifies it. Wait for draft-sync runs before marking ready to avoid stale event cancellation.

A bounded audit covered 37 explicit async conversions and 16 Promise-returning store/journal APIs against
new upstream callers. Only the two corrected journal omissions surfaced. This is not whole-program proof
or a measured UI/memory improvement. Startup reads and immediate revocation retain bounded synchronous I/O.
Installed picker/request evidence and server-reported processing remain separate, unperformed gates.

### Release-gate audit

The audit reopened four HIGH gaps: partial qualification, unauthenticated review text, incorrect run
correlation and mutable/non-monotonic publication. Independent source reviews accepted the schema-2
matrix/intake/assembly/fetch/publisher repairs; no real release has passed their operational gates yet.

Controller `38eb9af8b1` coherently merges frozen official `823ca` with parent `92cb523b68`.
All 12 tooling conflicts retain reviewed blobs; src/mobile/package/lock exactly match official `823ca`.
This replaces copying modern workflows into an older tree, which omitted 15 direct scripts and a
49-file source-equivalent dependency closure. The 26 reviewed tooling files and protected policy/token
logic were preserved. Dedicated [40443210863](https://github.com/mercurai/orca/actions/runs/40443210863)
passed 387 Node tests and nine modern-template checks, zero failures/skips. Whole-controller static
formatting passed 38,447 files with two threads at the next test baseline; local builds/tests remain CI-only.

Assembly requires the stable floor tag mirrored in the fork; it is currently absent.
Existing approved-tag mirroring also rebases patches, which would omit frozen-main changes.
The bounded tag-only correction reproduced 15 new mode/routing failures at `1963269057`
in [40447259196](https://github.com/mercurai/orca/actions/runs/40447259196) and
[40447276087](https://github.com/mercurai/orca/actions/runs/40447276087): 397 passed, 15 failed.
Independent review accepted the production workflow and preserved structural guards.
Exact `bbb2c308ad` then passed all 412 Node tests plus nine modern-template checks in
[40453921765](https://github.com/mercurai/orca/actions/runs/40453921765), with zero failures/skips.
PR #80 was marked ready only after that GREEN and its draft synchronization run settled.

The current branch correction enables `promotionEnabled` for the protected manual path,
because a disabled policy also blocks final qualification. This is an unlanded candidate
configuration change, not production admission or a qualification waiver. Independent
pre-change review confirmed all owner, exact-receipt, immutable composition and publisher
gates remain mandatory; fresh exact-head review/CI must pass before default landing.
The policy hash changes, so create owner intake only against the final landed controller
and policy; reuse no earlier receipt. GitHub's coordinator opt-in is absent (404), and the
local automation definition remains disabled. No recurring rollout is included in this switch.

Owner intake authenticates account-controlled acceptance of an independent review, binding candidate,
controller, manifest, policy, version and upstream/series identity to both GitHub actors, current attempt,
artifact identity and ZIP digest. It does not prove a human click or cryptographic AI identity. The fetched
context fails closed and removes stale acceptance. Prepared composition preserves the exact reviewed SHA.
Token-bearing jobs execute fixed Git/Bash operations, independently of candidate code.

Full qualification requires all 14 logical jobs and every planned unit/layout shard, full unit discovery,
cache bypass, exact source checkout and complete paginated attempt-specific jobs. Both planners derive
source identity from actual HEAD. Optional API attempt fields remain optional. A partial failed-only retry
cannot replace complete qualification evidence. Linux D7 is required; Windows D7 remains advisory.

Publisher freshness is re-read before the first channel mutation and immediately before public edit.
Exact asset digests/provenance, numeric monotonic versions, safe draft resume and read-only public retry
remain mandatory. Dry packaging [40451794792](https://github.com/mercurai/orca/actions/runs/40451794792)
builds already-pushed `d83942ea1a` through controller `1963269057` with provisional
label `v1.4.241-mercurai.1`. Preflight, Linux template and Windows packaging passed; publication was skipped.
Build logs verified the Mercurai channel/version and generated update manifest.
Artifact `12711056716` is a dry-run installer ZIP (194,244,233 bytes), SHA-256
`f524a5368655fefa67ab8db78dd3d8071dfd39472f101616a7a7562bfb284738`.
The label is not reserved, and dry admission is not full qualification.
Real publication and installed-runtime evidence are unperformed.
Manual promotion is enabled only in the unlanded controller candidate; all release gates remain required.
Recurring activation remains off. No Mercurai version suffix is reserved.
See the [release-note draft](../release-notes-v1.4.241.md) for remaining native/account/server evidence.

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

### Stable-tag mirroring without changing the frozen patch basis

The fork currently has no `v1.4.241` tag; assembly requires the reviewed upstream tag to exist in the fork.
The existing owner-approved tag mirror also dispatches stable-tag patch rebasing. That is unsafe for the
current main-snapshot manifest: rebasing `823ca..patch` onto the stable release would omit upstream main.
Do not invoke that coupled operation or manually create a release tag as a workaround.

Add an explicit manual `mirror_tag_only` input to the existing sync workflow, default false. Require an
owner-reviewed `allow_tag` pin and reject contradictory branch/guarded-merge inputs. In this mode only the
existing pinned-tag mirror may write: skip main/bulk-tag/branch/default merges, both rebase dispatches and
issue-writing side effects. Preserve schedule, dry-run, protected-default-branch and token boundaries;
normal mode retains existing behavior. Test actual workflow routing plus invalid-mode refusal in hosted
RED/GREEN, independently review, and update the existing runbook. This is a prerequisite for this release's
stable floor, not activation of the recurring coordinator. Production promotion remains disabled until reviewed, CI-gated default landing.

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

| Role                 | Writable ownership                                                | Output                                |
| -------------------- | ----------------------------------------------------------------- | ------------------------------------- |
| Release owner        | Manifest, workflow landing, runbook, accepted state               | Frozen inputs and promotion decisions |
| Product integrator   | Assigned product/tests on isolated patch branch                   | Patch head and behavior evidence      |
| Promotion worker     | Verifier/schema/tests; assembly/build workflows                   | Qualification contract                |
| Coordinator worker   | Detector, reducer, precheck, task contract; sync/rebase workflows | Bounded orchestration                 |
| Independent reviewer | No implementation files                                           | Candidate-bound verdict and blockers  |

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
- [ ] P1.2 Promotion worker: specify then test a small verifier and receipt schema in proposed
      `config/mercurai/scripts/verify-promotion.mjs`, `verify-promotion.test.mjs`, and
      `config/mercurai/release-policy.json`. Add deterministic failure fixtures before implementing checks.
      Verify failed full CI with passing targeted checks, forged checks, stale review, latest-attempt failure, truncated
      API data, and wrong-SHA/same-tree cases all refuse promotion. Use the existing fork-scripts CI workflow.
- [ ] P1.3 Promotion worker: extend `assemble-release.sh` and `.github/workflows/fork-assemble-release.yml` to
      materialize the candidate without tagging, qualify its exact commit, and independently verify recomposed inputs.
      Add `.github/workflows/fork-qualify-release.yml` as a trusted full-CI entry point reusing the PR test matrix.
      Extract a reusable workflow if needed; do not copy a divergent suite or rely on implicit PR event coverage.
      Pin required job/matrix identities and justified conditional skips in the reviewed release policy.
      Verify candidate ref movement, changed manifest/controller, and selected-unit mode cannot satisfy qualification.
- [ ] P1.4 Promotion worker: enforce the same receipt in `fork-release-win-build.yml` before publication, including
      manual dispatch. Extend `release-workflow-token-scope.test.mjs` and related existing workflow contract tests.
      Verify direct publish bypass, unexpected skips, changed tag, altered artifact, and stale version all fail closed.
- [ ] P1.5 Owner: independently review and land the minimal gate through the established owner route, with full
      required controller CI at its exact revision. Update the README qualification section and remove stale assumptions
      only where supported by evidence. Do not enable recurring agent automation yet.

### Phase 2: integrate current upstream and preserve fork behavior

Dependencies: P1.1; product work can overlap P1.2-P1.4. Promotion requires all of Phase 1.
Parallelism: assign non-overlapping product paths only after inspecting the pinned upstream/fork diff.

- [x] P2.1 Integrator: port the registered patch onto the frozen official main in an owned isolated branch.
      New `823ca687` linear pin `c777bcfc` has the same tree as its preserved reconciliation merge.
      This completes materialization only; product corrections, full CI and release acceptance remain open.
      Reuse `rebase-series.sh` and existing patch conventions. Resolve conflicts by required behavior, not ours/theirs.
      Record upstream-equivalence evidence before dropping any hunk; leave proposed-but-unshipped features clearly marked.
      Completed locally as `patch/current-main-release-98690` at
      `5fb6766ff1576b6e5d58d76241e54f5246ae7669`; publication, registration, and qualification remain owner gates.
- [ ] P2.2 Integrator: first reproduce the missed-await failure in CI, then correct
      `tests/e2e/paired-cli-agent-launch.unit.test.ts` and audit relevant `createPairingOffer` callers for awaited cleanup.
      Verify all 12 previous failing cases pass and no background async operation survives fixture teardown.
- [ ] P2.3 Integrator: preserve async/process, memory bounds, account/resume, local/SSH, and provider behavior.
      Reuse manifest tests and existing performance contracts; add tests only for unresolved changes and actual gaps.
      Compare upstream and candidate under matching deterministic fixtures, retaining required prior regression budgets.
- [ ] P2.4 Owner: register reviewed patch heads and test paths in `patches.yaml`; reconcile stale preparation notes.
      Reserve the version, bind the canonical build-version override and repository release notes, then freeze patch order.
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
- [ ] P4.3 Coordinator worker: add proposed `config/mercurai/scripts/release-precheck.mjs`,
      `config/mercurai/scripts/release-agent-dispatch.mjs`, and `config/mercurai/automation-contract.md`.
      Use the existing Orca CLI interfaces to reconcile and launch bounded workers from the local scheduled run.
      GitHub coordinates durable state and protected operations; it does not assume access to the user's Orca runtime.
      Claim the current generation through the trusted coordinator, invoke CLI commands with structured argv,
      persist returned run/task/dispatch IDs through that coordinator, and submit evidence without publisher credentials.
      Reconcile execution-host status as `live`, `unverifiable`, or `exited`; loss of contact never proves exit.
      Add behavioral tests for the adapter and precheck, including recovery between worker start and receipt persistence.
      Define bounded work/review tasks, precise writable paths, task/dispatch binding, and unconditional admission checks.
      Test empty queue, manual precheck bypass, offline host, stale completion, and worker release uncertainty.
- [ ] P4.4 Owner: extend `config/mercurai/README.md` with lifecycle, required evidence, roles, blocker handling,
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

| Area                  | Validation method                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------- |
| Controller scripts    | `node --test --test-concurrency=2 config/mercurai/scripts/*.test.mjs` in fork-scripts CI |
| Series/ref safety     | `bash config/mercurai/scripts/test-fork-series-scripts.sh`; guard/token-scope tests      |
| Async fixture         | `pnpm test tests/e2e/paired-cli-agent-launch.unit.test.ts` in CI with runner limits      |
| Product qualification | Full PR matrix, actual checkout SHA, typecheck/lint/compatibility and targeted tests     |
| Release/runtime       | Package/install smoke, artifact digests, channel proof, then retained-profile evidence   |

The plan is complete when documented and independently checked; implementation completion requires R1-R10 evidence.
Independent plan review: `/root/spec_plan_checker` accepted this plan on October 24 after the version/notes ordering,
qualification workflow, and dispatch adapter corrections. This is not implementation approval or release readiness.
Controller coverage must test behavior and bypass attempts, not only search YAML strings or assert mock call counts.
Test identity boundaries at the privileged edge. Treat missing native UI or live-account evidence as a named gap.
Required live evidence cannot be converted into a passed gate merely because CI or an isolated smoke succeeded.

## Risks, dependencies, and stop conditions

| Risk or dependency                   | Mitigation or explicit stop condition                                             |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| Upstream moves during integration    | Freeze one candidate; queue next target; never rebase qualified work silently.    |
| Overlapping performance changes      | Review behavior and tests; preserve budgets; require equivalence evidence.        |
| CI budget, rate limits, missing runs | Persist blocker; bound retries; never treat absent checks as green.               |
| State or artifact tampering          | Trusted writer, expected-parent updates, identity checks at promotion boundaries. |
| Native or rollback evidence absent   | Keep acceptance pending; preserve user profile and active sessions.               |

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

The completion audit above records exact hosted evidence. Historical passing runs qualify only their
own revisions. Full source CI and fresh complete controller CI at the manual-admission revision remain outstanding. No release tag,
package publication, installation, loaded-runtime acceptance or schedule enablement has occurred.
Next complete those exact-head checks, then land the reviewed controller through PR #80 and continue
immutable candidate/version/intake/full-qualification/release gates.
