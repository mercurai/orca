---
owner: Mercurai Orca release owner (Codex /root, delegated by the user)
last-reviewed: 2026-10-29
stability: draft
status: current-main integration and regression repair; release held
---

# Mercurai upstream integration and release automation

## Outcome and current state

Release official Orca242 plus the frozen main snapshot and verified Mercurai changes first.
Then complete durable worker recovery, rehearse, register the local automation disabled and
enable reviewed hourly wakeups. This is the authoritative plan. Operational contracts remain
in the [README](../README.md), [manifest](../patches.yaml) and
[automation contract](../automation-contract.md).

No default landing, final qualification, version reservation, tag, publication, installation,
loaded-runtime acceptance or recurring activation is complete. Published Mercurai remains
v1.4.237-mercurai.2. Controller PR80 is ready for review and full CI; recovery PR82
remains draft. Complete the exact final matrix before promotion.

## Target, workspaces and evidence

| Input                      | Current record                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Frozen stable floor        | v1.4.242, published2026-10-27T00:09:03Z                                                                           |
| Tag object / peeled commit | 0360ad49840ab10d6493aa6c26c7d066d641eb95 / 86ad9d95cac792f3d1359d886cef9fb9b0aadd47                               |
| Frozen main                | cbbaa2d7635297916ea257a0287cc4ec6c12af25;115commits/2738changedfiles beyond823ca687                               |
| Source repair input        | 8218bf9d2151b448cc1f1eaa97fc28662d64890f, tree3658a8b6077f446c1a99bb69131a7457141fd9d0;14linearcommits after823ca |
| Controller                 | remote64cd4a9969ca61403452ebe8b89924d7a50598d9;local manifest registers 6e21f986                                  |

Owner for all three workspaces is this session, designated release owner by the user.

- Active integration: C:/Users/svere/orca/worktrees/orca-upstream-integration-cbbaa-20261027,
  branch patch/current-main-release-cbbaa. Remote6e21f9861780a6dec1a55a20725a0e6cd284c503,
  tree8b11466b1d58a66fb9ccf6e35c2130767c601f2b; seven linear commits include reviewed
  WSL fixes, pairing fixture isolation and the large-diff ratchet repair after real RED.
  Fresh GREEN and full qualification remain pending. Related recovery preparationPR82.
- Recovery source: C:/Users/svere/orca/worktrees/orca-upstream-integration-823ca-20261026,
  branch patch/current-main-release-823ca. Its241floor is repair input, not publishing target.
- Controller: C:/Users/svere/orca/worktrees/release-registration-20261023,
  branch codex/release-registration-20261023, PR80. Preserve earlier unlanded recovery refs.

Stable-only CI commit37331ade00 is classified: the macOS updater workflow is byte-identical
in242/main/candidate; all three removed browser-route refs are absent from main/candidate.
Use ORCA_MERCURAI_BUILD_VERSION for release package metadata; preserve main dependencies.
No suffix is reserved. Later arrivals stay queued after this freeze; report observed lag.
Latest observed official main7f4c8f606435d4ca90964e176e860626ffba918a andstablev1.4.244
(published2026-10-29T03:55:29Z) supersede the previously queued observations aftercbbaa.
Finish the frozen revision's verification before admitting another integration generation.
The manifest registers258unique existing tests; no full qualification is claimed.

| Revision / hosted run           | Observed result                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| ad46260 /40469222124            | Windows1349passed/16skipped; costs and610contracts passed; persistence128passed/15failed                           |
| 8218bf9 /40472710805            | All3jobs passed: Windows99files/1351tests/16skip; costs237Linux,232Win/5skip;610contracts;143persistence tests     |
| 9bd7897 /40470764646            | Controller412Node tests and9template checks passed,0failures/skips                                                 |
| 94c7a48 /40844702585            | Windows1360passed/16skip; both cost jobs and611contracts passed; persistence266passed/4meaningful WSL failures     |
| 6c04784 /40844758383            | Controller412Node tests and9template checks passed,0failures/skips                                                 |
| 487142e /40845602179            | WSL persistence270passed; Windows pairing teardown3failed/1357passed/16skip; cost jobs passed                      |
| 6d57e1e /40846970058            | All3jobs passed after fixture-only isolation; Windows1360passed/16skip, costs and270persistence passed             |
| 27b82a5 /40847371955            | Real-Git large-diff test reproduced ENOBUFS; contracts613passed/1failed; persistence270passed                      |
| 930c7e2 /40845860124            | Controller412Node tests and9template checks passed; full40845916357 failed the large-diff ratchet before typecheck |
| 2ec508d /40847881117            | All3targeted jobs passed: Windows1360/16skip, costs,614contracts,270persistence                                    |
| 64cd4a9 /40848487591            | Controller412Node tests plus9templates passed; full40848487769 found5watcher ratchet violations before typecheck   |
| 6e21f98 /40849629838            | Reviewed watcher test corrections; fresh targeted hosted verification includes both suites and is pending          |
| eba9 /40453877833               | Earlier full matrix had29unit assertion failures plus fake-WSL E2E failure; not qualified                          |
| d839+controller196 /40451794792 | Predecessor dry packaging passed; publish skipped; provisional241label unreserved                                  |

## Immediate release work

Independent review accepted source8218 connector/CAS repairs after hosted RED: bounded
coalesced durable async outbox writes, owner barrier before EVENTS POST, retained retry/error
state and clear/account/hello fences; atomic revision checks and one accepted port retirement.
The lost-steer fixture warms with matching explicit options, preserving production next-turn
semantics. All seven reviewed GREEN blobs are byte-exact in the new generation.

Twelve textual conflicts are resolved with reviewed semantic unions. Preserve official
pending-stop/kept-host/GUID-holder behavior alongside serialized async writes and captured
connector/generation checks after awaits. Four new official session/account fixtures await
those APIs. Focused cache/connect/pending-stop extractions meet existing line limits, preserve
exports and timing, and introduce no framework. The intentional upstream dispositions suite
deletion is retained; genuine move-projection tests remain explicitly selected.

Hosted RED at94c7 reproduced both UNC aliases plus helper and service stale-removal
failures. The independently reviewed4871 fix excludes UNC fingerprint reads, returns the
serialized accepted-removal boolean and fences wake/status/retire effects around awaits.
Helper and service assertions are unchanged. The pairing IPC fixture now reuses the
existing fake native addon with real files, preserving production/native ACL tests while
avoiding directory teardown races. All three targeted jobs passed at6d57.

Full controller CI at930c7e exposed a1MiB buffer overflow in the changed-file reader.
An isolated real-Git7000-path test reproduced ENOBUFS at27b8; the reviewed one-line
64MiB allowance matches the existing tracked-file reader without changing ratchet scope.
The test and fix are ported byte-exact into this controller; all three targeted jobs
passed at2ec5. Full controller64 CI then identified five watcher-test ratchet findings.
The two upstream tests now use condition waiting and explain the model timeout;
native assertions, wait bounds, seeds and timeout remain unchanged. Both files are
ported byte-exact; fresh6e21 hosted verification includes them and is pending;
then complete exact-candidate full CI/review and publish through the protected
release mechanism and verify installed/runtime identity. No performance, installed
picker/request or actual Ultrafast execution claim is made.

## Durable automation completion

P4.3/P4.4 remain reopened. Existing scripts are source-only, disabled and unregistered.
Precheck blocks all conflicts; separately admit bounded isolated conflict work while keeping
publication blocked. Dispatcher local version/lease checks and optional local persistence do
not establish authoritative remote claims or crash recovery.

Finish one trusted state writer with expected-parent updates, unconditional candidate/task/
lease admission, exact writable scopes and intent before external CLI mutations. Reconcile
actual run/task/dispatch receipts; ambiguous workers are unverifiable and never duplicated.
new-child is supported. Native caller-scoped mutation replay and atomic accepted
Dispatch receipts already exist; prove first-call UUID preallocation in fixtures.
Repair actual RPC-envelope parsing, required task specs and nonzero receipt handling.
The inline trusted writer still lacks adapter claim/intent/receipt inputs. Reuse
these existing primitives; durability requires state and receipts, not an open chat.

After release, rehearse clean/conflict/offline/crash/duplicate recovery without publisher
credentials, register the repository-targeted Orca automation disabled through its owner CLI,
inspect host/account bindings without secrets, then enable both reviewed hourly wakeups.
Observe a genuine eligible cycle and record pause, alerts, queue age and recovery receipts.

## Host admission and ownership

Reconstruct all current global HOLD/LIFT orders before every push/ref mutation; the04:50
LEGS DONE lifted the03:23hold, but later orders and named queue priority remain authoritative.
Each push uses the shared foreground test-slot runner. BUSY before ACQUIRED means Git did
not run. Local tests/builds/typechecks remain CI-only; no waiters, hook bypass or serverone.
The October27 memory hold was explicitly lifted at21:22 and the October28 restart queue
reopened at22:28. On October29 both prepared branches and the reviewed fix pushed through
the shared runner with ACQUIRED/exit0; no local tests/builds/typecheck ran. The later
geekmode-rust dev landing freeze does not waive Orca's independent release gates.

Use at most two bounded implementers plus one independent reviewer. Parent alone stages the
shared index, updates manifest/controller and owns release/rollout. No app restart, provider
inference, throughput benchmark, secret reads or runtime-owned configuration edits occurred.
Native acceptance uses approved hidden Electron/CDP tooling and preserves active work.

Lessons in harness/orca/lessons-log.md use Obsidian CLI: reconstruct hold/lift history, verify
each named job's terminal result and verify exact candidate paths before registering selectors.
Never store raw transcripts or credentials in parity, reports or durable automation state.

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

- [ ] P2.1 Integrator: port the registered patch onto the frozen official main in an owned isolated branch.
      Prior823ca materialization is complete as recovery input; the newcbbaa generation is in progress.
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
