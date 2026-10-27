# Mercurai release automation contract

Owner: Mercurai release owner. Last reviewed: 2026-10-26.

This contract describes the durable handoff between GitHub and a local Orca
runtime. It is an interface contract, not permission to publish a release.
The release state branch and immutable workflow receipts remain authoritative;
agent chats, issue prose, and terminal availability are not release evidence.

## Durable state

`automation/release-state` contains one small `release-state.json` record. It
contains the candidate identity, one active generation, one coalesced queued
target, a compare-and-swap version, an optional lease, dispatch identifiers,
and non-secret evidence. It must never contain credentials, account data, or
conversation text.
Candidate identity includes the official `main` SHA, stable version tag and
peeled stable-tag commit SHA, trusted controller SHA, and ordered patch heads.
Changing any of those inputs queues a new target or generation; old
qualification evidence is never reused for the changed identity.

The trusted reducer in `scripts/release-state.mjs` permits only these forward
states:

`detected -> frozen -> integrating -> qualifying -> qualified -> tagged -> packaged -> published`

`blocked` and `failed` retain the evidence and require a new owner decision.
Every state mutation supplies the expected version. A stale writer fails with
`StateConflictError`; it must reread and revalidate rather than overwrite.
Only one owner may hold a live lease for a generation. An expired lease is a
reconciliation signal, not proof that the previous worker exited.

## Admission and dispatch

`scripts/release-precheck.mjs` refuses an empty, terminal, or actively leased
candidate. The local adapter in `scripts/release-agent-dispatch.mjs` then
invokes Orca with structured argv and `--json`:

1. `orca orchestration run-create --objective <text> --json`
2. `orca orchestration task-create --run <runId> --task-title <text> --json`
3. `orca orchestration worker-start --task <taskId> --worktree new-child --name <text> --agent codex --setup run --json`

The adapter records `runId`, `taskId`, and `dispatchId` with the candidate
generation. It never uses a shell string and never passes a publisher
credential. Worker status is classified as `live`, `unverifiable`, or
`exited`; loss of contact alone is `unverifiable` and cannot trigger a
replacement worker.

GitHub Actions cannot reach a user's local Orca runtime. The scheduled
`fork-release-coordinate.yml` workflow therefore detects upstream movement,
coalesces one pending target, and persists state only. A local scheduled run
must consume that state through the precheck and adapter. Registering or
enabling that local schedule is a separate owner-controlled rollout step.
Patch-head changes are part of target identity. When the current candidate is
terminal, the reducer promotes the newest queued target to a new generation;
while it is active, newer targets remain queued and cannot reset it.
The coordinator also runs the trusted `release-conflict-inventory.mjs` probe
against each pinned patch head. A conflict inventory is stored in state evidence
and blocks admission with the exact paths; the coordinator does not attempt an
ours/theirs resolution. A changed patch head creates a new candidate identity
and therefore a fresh inventory. `release-conflict-task-plan.mjs` derives a
deterministic, bounded set of non-overlapping work packages from those paths;
the plan is evidence for the next isolated integrator task, not permission to
merge or publish. Each package has an owner, an explicit writable-path list,
and an attempt limit, so a resumed agent cannot silently expand its scope.

## Promotion boundary

The reviewed controller candidate sets `promotionEnabled: true` to admit the
owner-controlled qualification and promotion path after default-branch landing.
This switch removes the audit containment veto; it does not replace authenticated
independent-review acceptance, complete exact-candidate qualification, immutable
composition, or monotonic publication. Fresh exact-head CI and independent review
remain required before this controller lands. No candidate is qualified or released
by enabling this switch. Owner intake must be created against the final landed
controller and policy hash; records from the disabled policy cannot be reused.
Recurring GitHub coordination and local Orca automation remain separately disabled.
Older controller revisions are outside this proposed guard.

The proposed assembly separates five jobs: candidate tests, read-only owner-review
admission, credentialed push/dispatch, read-only qualification verification, and
credentialed tagging. Promotion reuses the exact prepared commit and reserved
version; deterministic tree equality alone cannot replace its identity.
An assembly-specific dispatch ID identifies the qualification run. Complete
paginated discovery refuses ambiguous or incomplete results. Before tagging,
the read-only job compares the downloaded receipt against external candidate,
tree, controller, manifest, policy, version, ordered series, and dispatch IDs.
The tag job rechecks refs and the successful run attempt, then explicitly tags
the verified candidate commit. Neither credentialed job executes Node or
candidate code. Independent review accepted these boundaries. Before the manual-admission change,
controller `bbb2c308ad` passed all 412 Node tests and nine modern-template checks
in [40453921765](https://github.com/mercurai/orca/actions/runs/40453921765).
The enabled-policy revision requires fresh CI; full qualification, publication and
a hosted end-to-end assembly rehearsal remain pending.

The local intake and validators now bind authenticated owner and rerun actors to
complete candidate/controller/upstream identity and an exact artifact digest.
The qualifier is being wired to the shared required matrix, full unit discovery
and actual paginated job evidence. These edits are not accepted live gates.
The stale-refetch regression and final post-build publication freshness check
remain open, alongside complete hosted verification and rehearsal.
`fork-release-win-build.yml` refetches owner evidence and verifies externally
bound candidate identity before packaging. Direct build dispatch without a
valid receipt remains dry-run-only. No proposed mechanism enables admission
until its own final revision is independently reviewed and verified.

The recurring coordinator is intentionally disabled until the first qualified
release and a nonpublishing rehearsal have been reviewed. To pause it, disable
the schedule while preserving the state branch and receipts; do not delete the
queue. Resume by reconciling the current state and upstream target, not by
creating duplicate workers.
Scheduled GitHub reconciliation additionally requires the repository variable
`MERCURAI_RELEASE_COORDINATOR_ENABLED=true`; an unset variable keeps it off.
Manual reconciliation still requires an explicit dispatch from the default branch.

## Local automation registration

The checked-in `scripts/release-automation-spec.mjs` emits a disabled-by-default
spec and structured argv for the local Orca runtime. From the release worktree,
inspect it with:

```bash
node config/mercurai/scripts/release-automation-spec.mjs
```

An owner may pass the emitted argv to `orca` without a shell string, inspect
`orca automations show <id> --json`, and run one nonpublishing rehearsal. The
spec cannot enable itself; enabling the hourly schedule remains a separate owner
action after a qualified release and rehearsal.

## Recovery and rollback

- If a worker disappears, reconcile its dispatch IDs and lease before retrying.
- If qualification fails, keep the candidate and evidence; corrective changes
  create a new candidate identity and require fresh qualification.
- If a tag exists but packaging status is unknown, inspect the tag, workflow
  receipt, and channel assets before retrying; never allocate a second version
  for the same candidate.
- A release rollback is a forward owner decision: pause admission, retain the
  known-good qualified artifact, and verify profile/schema compatibility before
  asking users to install an older build.
