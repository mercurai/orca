# Issue and pull-request triage runbook (agent instructions)

You keep the Mercurai fork's backlog moving: classify, park, and dispatch. You do not implement and you do not
merge. An implementation task you create is run by a separate worker in its own worktree.

Owner: Mercurai release owner. Contract: `config/mercurai/automation-contract.md`.

## Every run, in order

1. `node config/mercurai/scripts/issue-pr-triage.mjs --repo mercurai/orca --explain` prints one line per item with its label, its reason and the quoted evidence. Read it before anything else.
   the classification before anything is written.
2. Drop the same command without `--dry-run` to persist the queue into the state file. It writes `parked[]`
   entries and one task spec per actionable item, and it never comments on or closes anything.
3. For each `actionable` item with no live dispatch, dispatch one bounded worker through
   `release-agent-dispatch.mjs --spec-file <the task spec path> --slot triage:<host>:<slot>`.
4. Report: `actionable=<n> parked=<n> dispatched=<n> stale=<n> blocker=<one line>`.

## Classification (one label per item, with the evidence quoted)

| Label | Means | Next action |
| --- | --- | --- |
| `actionable` | A concrete defect or request with a reproduction or a named file | Create a task spec |
| `needs-decision` | Needs an owner choice (scope, product behaviour, policy) | Park with the exact question |
| `stale` | No activity past the threshold, or a draft whose branch no longer applies | Park as `stale`; propose closure |
| `duplicate` | The same change or defect is already tracked | Park pointing at the canonical item |
| `superseded` | A newer item or a merged commit already does this | Park pointing at the successor |

## Hard rules

- **Never close, merge, label, or comment on anything.** You produce state and task specs. A human or a
  reviewed workflow acts.
- **One session per item.** The task key is `issue:<number>` or `pr:<number>`. Two runs can never work the same
  pull request.
- **No triage by title alone.** Quote the line of the body or the check result that justifies the label. If you
  cannot quote evidence, the label is `needs-decision`, not `actionable`.
- **Stale is a proposal.** A stale draft is parked with its age; closing it is a separate reviewed action.
- **The backlog never stops for one item.** A parked item must not block the rest of the run.
- **Bounded work.** At most one dispatch per item per slot, and at most two implementers plus one reviewer live
  at any time.
- **Nothing secret in state.** No tokens, account data, or transcripts.
