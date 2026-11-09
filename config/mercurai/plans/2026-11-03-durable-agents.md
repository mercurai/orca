---
owner: Mercurai release owner
last-reviewed: 2026-11-03
stability: draft
status: implemented in the controller branch; owner actions outstanding
---

# Durable agents for upstream sync and issue/PR flow

Two always-on jobs: (A) detect upstream `stablyai/orca` movement, integrate, release; (B) triage fork issues and
pull requests and dispatch bounded implementation. This plan is the controller-layer half. It composes the
existing GitHub coordinator (PR #80) and the Orca execution host; it adds no new runtime, scheduler, or credential.

Companion documents: [automation contract](../automation-contract.md), [fork README](../README.md),
[release automation plan](./2026-10-24-release-automation.md).

## Why, with the numbers that started it

- `fork-sync-upstream`: 300/300 consecutive hourly failures; no success since 2026-10-10.
- Fork `main` mirror frozen at `de5470a9` (2026-10-12): 5,129 commits behind upstream, 1,100 of them touching
  guarded paths.
- Newest fork release `v1.4.237-mercurai.2` against upstream `v1.4.247`; 23 tag approvals parked with no owner.
- Zero issue/PR automation; 8 competing integration pull requests; 14 stale `ci-only/*` drafts.

The failure was never missing machinery. The guard refuses any range touching a guarded path, `main` never
advances, so the range keeps containing the same guarded commits. One approval per range breaks it — but an
approval was a dispatch input that evaporated, and upstream moves every few minutes.

## Requirements

| Id | Requirement | Acceptance |
| --- | --- | --- |
| R1 | Zero-cost no-op hour | Two runs with unchanged upstream identity ⇒ the second makes no model call |
| R2 | Slot-keyed identity | Two fires in one slot are one unit of work; a retry returns the first outcome |
| R3 | Durable acceptance | Intent and ids persisted before execution; a crash resumes the same attempt |
| R4 | Approval memo, never self-approval | One approval authorises exactly one reviewed range and one approver |
| R5 | Parked work, backlog keeps moving | 23 parked approvals do not stop the eligible candidate |
| R6 | Self-audit gate | A missing receipt blocks promotion and is named |
| R7 | Recovery proof in CI | Kill at the two dangerous boundaries ⇒ one tag, one build, no re-allocation |
| R8 | Bounded, isolated workers | At most 2 implementers + 1 reviewer; identity is `(generation, taskKey)` |
| R9 | One session per issue/PR | Two runs cannot work the same pull request |
| R10 | Triage with evidence | A label without a quoted line is `needs-decision`, not `actionable` |
| R11 | Retention | An unchanged range writes no comment and no new issue |
| R12 | No new runtime or credential | GitHub stays the store, Orca the executor, the publisher token reaches no agent |
| R13 | Windows-host correctness | Structured argv and `node` entry points; no shell strings |
| R14 | Operator surface | status, pause/resume, one current blocker with its age |

## What was built

| Piece | File | Requirement |
| --- | --- | --- |
| Candidate identity digest | `scripts/release-state.mjs` (`computeTargetDigest`) | R1, R2 |
| Wake gate | `scripts/release-precheck.mjs` (`evaluateGate`) | R1 |
| Evaluation counter, parked items, approval memo, queue summary | `scripts/release-state.mjs` | R4, R5, R14 |
| Schema refusal | `scripts/release-state.mjs` (`assertStateSchema`) | R3 |
| Durable acceptance, real envelope, accepted-on-nonzero | `scripts/release-agent-dispatch.mjs` | R3, R8 |
| Receipt audit and promotion refusal | `scripts/release-audit.mjs` | R6 |
| Publication reconciliation (adopt/upload/refuse) | `scripts/release-audit.mjs` | R6, R7 |
| Version reuse after a crash | `scripts/release-version.mjs` | R7 |
| Parked tag approvals, evaluation, audit evidence | `.github/workflows/fork-release-coordinate.yml` | R5, R6, R14 |
| Slot id and prompt-file automation spec | `scripts/release-automation-spec.mjs` | R1, R2 |
| Triage, task specs, triage automation | `scripts/issue-pr-triage.mjs`, `workflows/issue-pr-triage.js` | R9, R10 |
| Comment retention | `scripts/report-sync-issue.sh` | R11 |
| Recovery proof | `scripts/release-state-recovery.test.mjs` | R7 |
| Tokenless rehearsal | `scripts/release-rehearsal.mjs` | R6, R7 |
| Agent instructions | `automation/release-coordinator.md`, `automation/issue-pr-triage.md` | all |

## Phases

### Phase 0 — owner actions (outstanding)

- [ ] **P0.1** Decide whether the guard/tag approval becomes a durable memo (R4). The code supports it; the policy
      in [README](../README.md) still says the approval is dispatched by the owner or an independent reviewer.
- [ ] **P0.2** Land the ingestion boundary (PR #88 or an equivalent reviewed main-only mode).
- [ ] **P0.3** One owner dispatch of `fork-sync-upstream` with `allow_guarded_merge_sha=<current upstream main sha>`
      after the independent security read; record the range digest so the first memo exists.
- [x] **P0.4** Retired 17 `ci-only/*` drafts (the lane they exercised is superseded; branches left untouched, each closed with a reason).

### Phase 1 — change gate and state extensions

- [x] **P1.1** State tests for schema refusal, parked items, approval memo, skip counter, digest-gated enqueue.
- [x] **P1.2** `release-state.mjs` extended; `schemaVersion` stays 1 and the new fields are optional on read.
- [x] **P1.3** `release-precheck.mjs` returns `{decision, changed, digest, eligible, skipped, reason}` and exits
      non-zero unless the decision is `run`.
- [x] **P1.4** Covered by `fork-scripts-test` (`node --test "config/mercurai/scripts/*.test.mjs"`).

### Phase 2 — durable acceptance in the dispatcher

- [x] **P2.1** Tests: intent persisted before spawn, `--retry-request` per mutation, real envelope parsed,
      nonzero-with-receipt accepted, retry reuses the worker request, missing `--spec` refused.
- [x] **P2.2** `release-agent-dispatch.mjs` rewritten; `DispatchUnknownError` keeps run/task ids for reconciliation.
- [x] **P2.3** Refusal path: a spec with a placeholder token is refused before any mutation.
- [x] **P2.4** Tokenless fixtures exercise the argv shape and the `{code, stdout}` boundary.

### Phase 3 — audit and recovery proof

- [x] **P3.1** `release-audit.mjs` derives expected steps from the reached state and names every miss.
- [x] **P3.2** `release-state-recovery.test.mjs` covers the worker boundary, the tag boundary, and the publish
      boundary with effect counts.
- [x] **P3.3** Audit evidence recorded by the coordinator; `verifyPromotion` refuses on a recorded miss.

### Phase 4 — coordinator and automation registration

- [x] **P4.1** Slot id, digest-gated evaluation, parked tag approvals read from the owner-review issues, audit
      evidence, no issue writes.
- [x] **P4.2** `release-automation-spec.mjs`: provider `pi`, prompt file, `--spec-file` dispatch, still `--disabled`.
- [x] **P4.3** Contract updated with the five invariants, the `safe`/`never` table, the audit gate, retention.
- [x] **P4.4** Agent instructions live in `config/mercurai/automation/`, so changing the agent is a PR.

### Phase 5 — issue/PR agent

- [x] **P5.1** `issue-pr-triage.mjs`: five labels with quoted evidence, `issue:<n>` / `pr:<n>` keys, task specs.
- [x] **P5.2** `workflows/issue-pr-triage.js`: command-call triage, then bounded `isolation: worktree` workers.
- [x] **P5.3** Triage automation spec and argv (disabled).
- [ ] **P5.4** Stale-PR closer enabled as the first live action (propose-then-close only) — needs P0.4 first.

### Phase 6 — rehearse, enable, observe

- [x] **P6.1** `release-rehearsal.mjs`: clean, guarded, conflict, parked, killed, unknown, unchanged, publish.
- [ ] **P6.2** Enable the coordinator (`MERCURAI_RELEASE_COORDINATOR_ENABLED=true`) and register the automation
      enabled, after P0.3 has landed a real release.
- [ ] **P6.3** Observe one genuine cycle: lag, skipped count, parked count, dispatch ids, recovery receipts.
- [x] **P6.4** Rollback drill, offline: pause refuses admission while keeping the queue and receipts; resume promotes the queued target to a new generation with no inherited dispatch.

## Verification

- `node --test "config/mercurai/scripts/*.test.mjs"`: 465 pass, 8 fail. The 8 are the publication-workflow fixture
  on a Windows host (`yq` and a `:`-joined PATH inside the fixture); the same 8 fail on the branch this started
  from. Baseline: 404 pass, 8 fail.
- `oxlint@1.89.0 -c .oxlintrc.json config/mercurai`: 0 warnings, 0 errors.
- `node config/mercurai/scripts/release-rehearsal.mjs`: 9/9 scenarios.
- `test-fork-series-scripts.sh` reaches 60 passes locally and then stops on a hostile-filename fixture that cannot
  exist on Windows (a CR in a path); CI runs it on ubuntu-latest. The `report-sync-issue.sh` section was run in
  isolation: 11/11, including the two new retention cases.

## Registration (2026-11-06)

Neither automation is registered in the runtime yet, deliberately. The emitted argv for both is checked against the
installed `orca automations create --help`: every flag is supported, and both specs carry `--disabled` by
construction, so neither can enable itself.

Registration is deferred for three reasons:

1. P6.2 gates it on a qualified release, and nothing has been released from this branch.
2. `--repo` creates a new worktree per run. On this repository that is roughly 40,000 files every hour, and the
   choice between `--repo` and a long-lived `--workspace` depends on which checkout carries the controller branch —
   unknown until #80 and #97 land.
3. A disabled automation pointed at the wrong base is noise with no benefit.

When it is registered, the repository id is `id:9c88eb0e-f665-44c6-9d38-c5d7a306762b` (`orca` at
`C:/Users/svere/orca/projects/orca-config/orca`), and the first run after enabling must be report-only.


## Not claimed

No release, tag, channel publication, installed-runtime verification, or enabled schedule results from this
work. Phases 0 and 6 need the owner.
