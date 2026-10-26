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

The proposed controller's `release-policy.json` sets `promotionEnabled: false`.
Assembly checks the boolean before release-ref mutation, qualification refuses
to issue a receipt, and the trusted publisher verifier rejects promotion while
that policy remains disabled. This contains the current audit findings; it does
not resolve the incomplete verification matrix, review authentication,
qualification correlation, or immutable monotonic publication requirements.
Those gates need implementation, independent review, and CI before admission
can be enabled. Older controller revisions are outside this proposed guard.

The proposed exact-run correction separates assembly into test, credentialed
push/dispatch, read-only qualification verification, and credentialed tagging.
An assembly-specific dispatch ID identifies the qualification run. Complete
paginated discovery refuses ambiguous or incomplete results. Before tagging,
the read-only job compares the downloaded receipt against external candidate,
tree, controller, manifest, policy, version, ordered series, and dispatch IDs.
The tag job rechecks refs and the successful run attempt, then explicitly tags
the verified candidate commit. Neither credentialed job executes Node or
candidate code. This correction requires independent review and hosted CI.

The receipt's reviewer text remains unauthenticated; authenticated review intake
is pending. The qualification checks also omit required PR verification lanes.
`fork-release-win-build.yml` verifies a receipt with the trusted controller
before packaging or publication. Direct build dispatch without a receipt is
dry-run-only. These mechanisms do not yet satisfy the promotion boundary.

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
