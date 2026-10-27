---
owner: Mercurai Orca release owner (Codex /root, delegated by the user)
last-reviewed: 2026-10-26
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
and immutable monotonic publication remain incomplete. Admission is disabled in the proposed controller.
Phase 4's durable-state and coordinator code is proposed and CI-tested, without operational acceptance or
schedule enablement. Phase 2 has a corrected source candidate on a frozen upstream base; newer upstream
changes, full CI, packaging, installation, and runtime acceptance remain pending.
The coordinator now resolves and persists the stable tag's peeled commit SHA and queues a new target when the
trusted controller revision changes, preventing stale candidate evidence from being reused after workflow changes.
The operational source of truth remains [the release README](../README.md) and [patch manifest](../patches.yaml).
Update those documents with behavior during implementation; avoid maintaining another parallel runbook.

## Workspace, scope, and reuse

Planning workspace: `C:/Users/svere/orca/worktrees/release-registration-20261023`.
Branch: `codex/release-registration-20261023`, containment implementation commit `ba18ca1c2c`.
Owner: this release session, designated release owner by the user. Purpose: implementation and release handoff.
Product draft PR: [#79](https://github.com/mercurai/orca/pull/79); prior registration PR #72 merged.
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

## Current candidate and completion audit

Evidence below records the last completed inspections and hosted runs, rather than claiming a fresh live
GitHub read during the fleet quiet order. No source or controller landing, tag, package publication,
installation, runtime acceptance, or schedule activation is complete.

| Item                                             | Last verified identity or status                                                                                                                                                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Official main, inspected 2026-10-26 23:30:54 UTC | `823ca6870fd46bc979ee073ee0731516a0607daa`                                                                                                                                                                                              |
| Official stable                                  | `v1.4.241`, published 2026-10-26; peeled commit `041baf356b368d773f333e76375ce860fba2481b`                                                                                                                                              |
| Existing public Mercurai release                 | `v1.4.237-mercurai.2`; installed runtime must be independently checked                                                                                                                                                                  |
| Old source preparation                           | `patch/current-main-release-98690@23fdb7e094814974722570e1ac696de6837bb78d`, PR [#79](https://github.com/mercurai/orca/pull/79)                                                                                                         |
| New linear candidate                             | `patch/current-main-release-823ca@c777bcfcfdfb463cd2b6b337c3e3de1eb18955db`, draft [#82](https://github.com/mercurai/orca/pull/82); targeted run [40429242854](https://github.com/mercurai/orca/actions/runs/40429242854) completed RED |
| Controller preparation                           | `codex/release-registration-20261023@5651284ad6`, PR [#80](https://github.com/mercurai/orca/pull/80); further edits uncommitted                                                                                                         |
| Admission                                        | Proposed `promotionEnabled: false`; recurring coordinator activation remains off                                                                                                                                                        |

Official main adds 91 commits beyond `98690db2ab1d53d7e67eae296dc061c000c2ea2f`.
The new merge produced 21 content conflicts. All conflict contents are resolved and committed as
`e4095165f1ba45b638c9c45aec3bce3ce22d5b68`. The identical tree
`5a1e6e854f002888994691a5fbf2cb458cd2bf53` is materialized as linear
`c777bcfcfdfb463cd2b6b337c3e3de1eb18955db` directly on the frozen official parent.
Both candidate and comparison refs are remote; the provisional manifest matches the candidate.
Runtime/renderer defects remain intentionally unfixed for hosted RED, so this is not qualified.

Stable `041baf35` is not an ancestor of main. Its sole stable-only change is `package.json` version
`1.4.214` to `1.4.241`; its functional parent is already in the old official base. Explicitly reconcile the
stable version floor with the controlled Mercurai package-version injection and record that evidence.
Do not claim stable-commit ancestry or omit the version change silently.

### Source audit

The earlier audit disproved broad completion claims: relocated imports and async fixtures were broken,
canonical speed precedence was inconsistent, and a rejected overlapping turn could erase newer choices.
The repaired old source has targeted hosted evidence, not installed-app acceptance:

| Exact source / hosted run                                                                                            | Observed evidence and limit                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `423176798d119980771fcfddd8a60797c99040b4`, [40401238493](https://github.com/mercurai/orca/actions/runs/40401238493) | 93 Windows files: 1,232 passed, 16 skipped; Linux/Windows deterministic cost jobs passed                                                                                            |
| `b31ced0216480a4f1dceeb11d21a918865234164`, [40405108355](https://github.com/mercurai/orca/actions/runs/40405108355) | Typecheck and lint passed; ast-grep found nine flaky-test violations in eight retained files                                                                                        |
| `23fdb7e094814974722570e1ac696de6837bb78d`, [40419856282](https://github.com/mercurai/orca/actions/runs/40419856282) | Windows 1,232 passed, 16 skipped; expanded cost suites Linux 237 passed, Windows 232 passed and five skipped; new full-qualification contracts 10 passed, 10 failed as intended RED |

The new upstream merge preserves conversation-backed catalog ownership, live-record fences, launch
`explicitLaunchOptions`/`optionsMode`, awaited VM retirement, and WSL no-boot recovery alongside fork tiers
and async persistence. Independent source review accepted only the bounded catalog merge.
Runtime review found a new wake race: a reachability await can reconnect after disable or removal.
Three deferred-probe regressions now await hosted RED; production remains unfixed.
Renderer review also found newer held legacy Fast choices losing to saved canonical speed; its regression
cases await hosted RED before correction. New upstream `wsl-host-early-wake.ts` adds synchronous focus-path
I/O; migrate it with existing async secure persistence and revocation ordering before claiming preserved
async responsiveness. None of these findings establishes an installed-app throughput or memory measurement.

The follow-up renderer audit found another HIGH: model-less explicit speed options can be overwritten
by the seeded tier in first-message construction and option presentation. Explicit Standard over a saved
nonstandard tier must never become a paid request. Six tier-only cases are authored: modern create and picker/send regressions in both directions,
plus legacy transport controls. They are unrun and production remains unchanged. The WSL revocation gap also affects passive runtime calls, including an
`available` verdict arriving after disable; four additional deferred-probe cases cover that path.
Seven early-wake cases now cover async focus I/O, complete-operation quit draining, latest intent,
disable/removal, unrelated pending intent, profile isolation and normalized-list deduplication.
The larger service test was split into service lifecycle and wake/reconnect suites to preserve the
existing size limit. Production remains unchanged until hosted RED.

Hosted run [40429242854](https://github.com/mercurai/orca/actions/runs/40429242854)
completed at `c777bcfc`: 97 Windows files, 1,282 passed, 21 failed, 16 skipped.
Twenty failures confirm the intended product regressions; one missing reset import came from test
extraction and is being corrected. Linux deterministic costs passed 237 tests; Windows passed 232
with five skipped. All 25 full-qualification contracts passed on Linux, establishing the shared-matrix
RED-to-GREEN correction at this source revision, not full matrix or runtime acceptance.
Speed and WSL corrections now have separate writable owners and independent review before fresh CI.
Controller lint exposed an oversized prepared-candidate test module; it is split into general assembly,
prepared promotion and shared fixture files with a real independent source review. Controller lint
now passes, while authenticated intake, preparation and final publication behavior still need hosted CI.

The next source head is `918ee0ca3148358d43f2cadb86ad259a6d298886`, tree
`913420edb70c9ca8b2e451ad2d2e6e25550bfbc7`, with two linear commits after the
frozen base. WSL and speed repairs passed scoped independent review; an additional unlisted-seed
model binding defect is explicitly tested in [40432803045](https://github.com/mercurai/orca/actions/runs/40432803045),
currently running. Source formatting, scoped lint and whitespace checks passed before this push.
The active provisional manifest now records this head and 229 existing test paths.

Controller baseline `042e72b22366db2151ae39162d16e378db771ab8` passed lint and
series checks in [40431480557](https://github.com/mercurai/orca/actions/runs/40431480557).
Its Node run completed 379 tests: 360 passed and 19 failed. Sixteen failures prove the missing final
publication freshness guard, one proves stale accepted evidence after refetch failure, and two expose
stale structural test assumptions. All are corrected in working files with scoped independent review;
hosted GREEN is still required. A read-only merge probe against current default `c5f11af2` reports
one manifest conflict; retain the new frozen pin and planned entries while preserving other default
changes before final controller qualification.

### Release-gate audit

Four HIGH findings reopened Phase 1: partial qualification labeled full, unauthenticated reviewer text,
incorrect qualification-run selection, and mutable/non-monotonic channel publication.

| Gate                                         | Implementation / verification status                                                                                                                                                                                                          |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact qualification correlation              | Independent review accepted the split trusted verification and token jobs; controller [40404591475](https://github.com/mercurai/orca/actions/runs/40404591475) passed 222 Node and nine template-integration tests                            |
| Authenticated review                         | Hosted [40418219241](https://github.com/mercurai/orca/actions/runs/40418219241) rejected the new owner-auth test as expected: 222 passed, one failed; owner-intake validator/workflow and caller wiring now under source review               |
| Prepared immutable candidate and publication | Hosted [40418899486](https://github.com/mercurai/orca/actions/runs/40418899486) yielded 223 passed and 15 intended failures; exact prepared SHA/reserved version and immutable monotonic publisher repairs are local, awaiting complete GREEN |
| Full matrix                                  | Source [40419856282](https://github.com/mercurai/orca/actions/runs/40419856282) provides RED; shared PR workflow/full unit planning/cache bypass and actual matrix receipt are being wired                                                    |

Owner acceptance binds full candidate/tree/controller/manifest/policy/version/ordered series/upstream identity
to an authenticated GitHub workflow actor and triggering actor, current run attempt, artifact identity and
ZIP digest. Reviewer text alone cannot authorize promotion. This authenticates account-controlled acceptance
of an independent review; it does not prove a human click or an AI model's cryptographic identity.

Assembly now requires the prepared candidate, reserved tag and accepted-review run before canonical branch
mutation, then refetches review evidence after qualification. Publisher preflight also verifies external
candidate identity and fresh owner context. These are uncommitted source edits, not accepted live gates.
The fetch helper's reused-destination stale-context regression remains deliberately RED pending hosted
execution and correction. Publication still needs a final fresh review/qualification recheck after the
long build, immediately before channel mutation.

Independent review of the new shared matrix found a source-identity defect: the planner inherited
`GITHUB_SHA` from the controller rather than the source checkout. Both PR and standalone planners now
derive `ORCA_SHARD_SOURCE_SHA` from actual `HEAD`, with a mismatched-controller/candidate fixture.
The correction remains unrun. The new verifier binds job evidence to an exact run-attempt endpoint,
preserving genuine optional per-job attempt fields instead of inventing API fields. If a failed-only
rerun cannot provide complete current-attempt evidence, dispatch fresh full qualification; ordinary
source-PR retry behavior remains unchanged.

Independent review accepted the bounded shared-matrix and schema-2 qualifier source, with hosted
verification still required. The release owner copied 24 reviewed workflow/action/planner paths into
the isolated controller. Actual API evidence requires all 14 logical successes and every planned
unit/layout shard, complete pagination and the exact attempt endpoint; optional API row attempt fields
remain optional and are never fabricated. A positive fixture covers nested reusable job names.
Linux D7 is required by the existing layout call; Windows D7 remains advisory and is not claimed passed.
The current [release-note draft](../release-notes-v1.4.241.md) distinguishes intended behavior, remaining
regressions, publication and installed-runtime acceptance. No candidate suffix has been reserved yet.

Publication now has source-only RED cases for 14 stale controller/review/qualification/artifact
conditions, authorization API refusal before empty-channel bootstrap, and a review rerun during draft
upload. The actual publisher Bash runs against the isolated GitHub boundary; healthy publish/retry
controls remain. Additional null-digest controls distinguish byte comparison from metadata rejection.
The boundary fixture lives in `publication-github-fixture.mjs` to preserve file size and responsibility.
These cases are unrun and the final freshness guard remains unimplemented pending hosted RED.

The fleet posted `BOX SMOKE DONE` at 2026-10-27 00:33 UTC, lifting the quiet order and slot hold.
Git/GitHub operations and hosted CI resumed. Local build/test admission for this lane remains CI-only;
no local tests, builds, installs or app launches are authorized by that change. Earlier green runs never satisfy the new
candidate/controller revisions. Historical preparation artifacts remain available in Git history; do not
reuse their verdicts for the current generation.

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

Current implementation evidence: verifier tests 8/8, qualification/publisher contract tests 13/13,
state/dispatch/precheck/coordinator tests 15/15, and release token-scope tests 22/22 passed through the
shared runner before the latest candidate registration. The latest linear candidate's parent, tree, and
manifest pins were checked with Git; `git diff --check` passed. The fixture assembly suite is not locally
runnable because `yq` is absent; CI must run it. No product build, CI dispatch, release tag, package
publication, installation, runtime verification, or schedule enablement has occurred. The next action is
independent review of the exact registration diff, followed by CI at the controller and candidate SHAs.
