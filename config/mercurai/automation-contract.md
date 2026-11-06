# Mercurai release automation contract

Owner: Mercurai release owner. Last reviewed: 2026-11-03.

This contract describes the durable handoff between GitHub and a local Orca
runtime. It is an interface contract, not permission to publish a release.
The release state branch and immutable workflow receipts remain authoritative;
agent chats, issue prose, and terminal availability are not release evidence.

Status: the coordinator layer (state, gate, dispatch, audit, rehearsal) is
implemented in the controller branch and covered by `fork-scripts-test`. The
native CLI boundaries that were open on 2026-10-27 are addressed where the
sections below say so; the remaining open items are listed at the end.

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

## Durability invariants

Five rules every piece of this pipeline follows. They are not style: each one
is the difference between a resumed run and a duplicate side effect.

1. **Durable acceptance.** Persist the intent (generation, task key, spec
digest, request id, writable paths) before the first mutation, and return
`accepted` before any model work starts. A caller that times out must be able
to ask what happened.
2. **Identity is the caller's, never the attempt's.** `sync:<host>:<slot>`,
`coord:<host>:<slot>`, `triage:<host>:<slot>` where the slot is the clock
floored to the period, plus one `--retry-request` per mutation
(`<slot>:run`, `<slot>:task`, `<slot>:worker`). Two fires in one slot are one
unit of work; a retry replays that exact request.
3. **A receipt is not a result.** `evidence.dispatchReceipt` records that a
dispatch was accepted; the worker's output is a separate artifact; the
transcript is neither. Pruning one must not invalidate the others.
4. **One writer per store.** Only the trusted reducer writes
`automation/release-state`, and it refuses a `schemaVersion` it does not
understand rather than guessing. The local agent reads that branch and writes
nothing else.
5. **Nothing unclassified runs twice.** Every step is `safe` or `never` (below).

## Effect classes

| Step | Class | On a crash or an unknown result |
| --- | --- | --- |
| Read state, run the gate, compute a digest | `safe` | Re-run |
| Fetch upstream, compute a conflict inventory | `safe` | Re-run |
| Create a run, a task | `safe` (request id) | Replay the same request id |
| Start a worker | `safe` (request id) | Replay, then reconcile with `worker-show` |
| Rebase a `patch/*` branch | `safe` (`--force-with-lease`) | Re-derive from the pinned tag |
| Push `main` / mirror a tag | `never` | Inspect the ref; adopt it if it already matches |
| Allocate a release version | `never` | Reuse the recorded tag, never allocate a second |
| Tag a candidate | `never` | Reuse the immutable tag and resume its build |
| Publish to the channel | `never` | `reconcilePublication`: adopt, or upload only if absent |
| Approve a guarded range or a tag | `never`, owner only | Read the memo; a changed range is a new question |

## Admission and dispatch

The adapter enforces admission itself, even when a manual run omits the
scheduler precheck. It binds the pinned executable, original runtime and
caller route before invoking Orca with structured argv and `--json`:

1. `orca orchestration run-create --objective <text> --retry-request <slot>:run --json`
2. `orca orchestration task-create --run <runId> --spec <task text> --task-title <text> --retry-request <slot>:task --json`
3. `orca orchestration worker-start --task <taskId> --run <runId> --worktree new-child --name <text> --agent <id> --setup run --retry-request <slot>:worker --json`

Each mutation has its own persisted request id and exact canonical parameters.
The adapter validates task contents and writable scopes, refuses a spec that
still contains a placeholder token, and refuses an invalid request id; native
`--spec` accepts task text and does not enforce an adapter-owned schema.

Parse the actual RPC envelope: `result.run.id`, `result.task.id` and
`result.dispatchId`. Parse structured stdout before treating a nonzero exit as
failure: `worker-start` sets exit 1 whenever `result.state` is not `ready`, and
still prints the receipt. `release-agent-dispatch.mjs` therefore accepts that
receipt (`evidence.dispatchReceipt.acceptedOnNonzeroExit`) and raises
`DispatchUnknownError` only when no receipt arrived at all, keeping the run and
task ids so the retry replays the worker request instead of starting another.
Store only non-secret IDs, digests and authority references with the candidate
generation.

Use native `worker-show`/`worker-list` projections for `live`, `unverifiable`
and `exited`. A local connected/process boolean is insufficient. No shell
string or publisher credential belongs in a worker launch.

### Completion audit and native request recovery

These requirements remain open after the first qualified release:

- ~~The current adapter omits required `--spec`, expects flattened IDs and drops
  nonzero structured receipts.~~ Addressed 2026-11-03: `--spec` is required and
  validated, the real envelope is parsed, and a nonzero exit with a receipt is
  accepted. The argv shape is pinned by tokenless fixtures; a live run remains
  an owner step.
- Native mutation handling persists caller-scoped UUID receipts. The same
  authenticated caller, UUID, method and canonical parameters replay the result;
  changed parameters refuse `request_mismatch`. Persist intent and exact public
  runtime/caller references before mutation. Prove first-call UUID preallocation
  with `--retry-request` in fixtures before relying on that retry flag.
- `request-show --request <uuid> --json` reports completed, pending or absent.
  Absent and restart `operation_unknown` are ambiguous. Worker acceptance stores
  its task/Dispatch receipt atomically; recover that exact attempt instead of
  allocating a fresh UUID or relying on titles, pane presence or timeout.
- The trusted writer is inline in `fork-release-coordinate.yml`; it currently
  exposes detection only, with no adapter claim/intent/receipt inputs. Extend
  that writer with expected-parent and fresh-lease checks. Do not invent a
  second coordinator or treat optional local JSON persistence as authority.
- No public worker account-selection flag exists. Native launch/account-home
  authorities retain that routing. The concrete runtime/account owner handle
  remains unresolved in this lane; registration must resolve and retain that
  owner-controlled binding. Never persist `accountEnv`, home contents or secrets.

Source contracts: [CLI formatting](../../src/cli/format.ts),
[mutation replay](../../src/main/runtime/rpc/orchestration-mutation-executor.ts),
[atomic worker acceptance](../../src/main/runtime/orchestration/db/worker-dispatch/worker-dispatch-start.ts),
[native worker liveness](../../src/shared/orchestration-fleet-worker-projection.ts)
and [account-home authority](../../src/main/runtime/structured-agent-account-home.ts).
Older execution hosts need capability checks; unsupported recovery fails closed.

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

## Audit, retention, and the operator surface

`release-audit.mjs` derives the expected steps from the stage the candidate
actually reached and diffs them against the receipts it holds. Every miss is
named (`evidence.audit.missing`) and `verifyPromotion` refuses on any miss. A
green workflow is not evidence; a receipt is.

Retention is part of the contract, not housekeeping: an unchanged upstream
range writes no comment and opens no issue (`report-sync-issue.sh` compares the
last comment against the pinned commit), parked items are refreshed in place by
identity, and state history stays bounded.

`summarizeQueue` is the operator surface: generation, state, eligibility,
parked items with their reasons, the skip counter, the live lease owner, and
the queued digest. `release-rehearsal.mjs` is the tokenless proof: eight
scenarios, no network, no model, no credential.

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
Enabled-policy controller `9bd7897cb7` subsequently passed 412 Node tests and nine
template checks in [40470764646](https://github.com/mercurai/orca/actions/runs/40470764646).
Full current-controller qualification, publication and hosted end-to-end assembly
rehearsal remain pending.

The local intake and validators now bind authenticated owner and rerun actors to
complete candidate/controller/upstream identity and an exact artifact digest.
The qualifier uses the shared required matrix, full unit discovery and paginated
job evidence. Operational acceptance of the final correlated qualification,
refetch and post-build freshness paths remains open; unit tests do not establish
that a release passed these gates.
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

Two checked-in spec builders emit disabled-by-default specs and structured argv
for the local Orca runtime. From the release worktree, inspect them with:

```bash
node config/mercurai/scripts/release-automation-spec.mjs
node -e "import('./config/mercurai/scripts/issue-pr-triage.mjs').then(m => console.log(JSON.stringify(m.buildTriageAutomationArgs({ repo: 'mercurai/orca' }))))"
```

Both use provider `pi`, an hourly (release) or two-hourly (triage) trigger, and a
precheck that is the change gate: an unchanged hour exits non-zero and the
scheduler records a skipped run without starting a model turn. The prompt names
`config/mercurai/automation/<agent>.md`, so what the agent does is reviewed in
the repository rather than edited in runtime-owned automation state.

An owner may pass the emitted argv to `orca` without a shell string, inspect
`orca automations show <id> --json`, and run one nonpublishing rehearsal. The
spec cannot enable itself; enabling the schedule remains a separate owner action
after a qualified release and a passing `release-rehearsal.mjs`.

## Open items after 2026-11-03

- First-call UUID preallocation (`--retry-request` before the mutation) is proven
  in fixtures, not against a live runtime.
- `request-show` reconciliation of an `operation_unknown` dispatch has no live
  rehearsal yet; the adapter keeps the ids so a human can reconcile.
- Provider choice for the automation (`pi`) is a default, not a verified
  capability of the installed runtime; `codex` is the documented fallback.
- The scheduler's own liveness (a run whose terminal disappears) is not yet
  covered by a companion wake.

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
