---
owner: Mercurai release owner
last-reviewed: 2026-10-18
stability: draft
---

# Mercurai release based on Orca 1.4.229

Draft publication text. Replace the candidate pin with the final passing revision and complete
installation, runtime and rollback acceptance before using this text as release evidence.

## Source and provenance

- Official source boundary: `613c5986e3e2671c8603b503bbf171692487f866`.
- Official release floor: `v1.4.229`, commit `a0cd1644f320f1327f7495650a816111b495f3cd`.
- Provisional consolidated candidate: `19e2b167e7064a3ee76cd3d7356ec05e925f1874`.
- Candidate tree: `1ca2f603c21bfe130006e9b910a22acbad976c5b`, identical to source `bf3417557c`.
- Registration, full CI and release acceptance remain pending.
- Release candidate: [product PR57](https://github.com/mercurai/orca/pull/57).
- Original integration history: [superseded PR47](https://github.com/mercurai/orca/pull/47).
- Protected assembly support: [management PR48](https://github.com/mercurai/orca/pull/48).

Later official main commits belong to the following cut. This release does not claim to contain
commits beyond its recorded source boundary.

## Included fork work

The candidate combines the Mercurai update channel, event-loop diagnostics, username and worktree
scan optimizations, worker-based process launching, asynchronous secure writes, and their integration
corrections. It also includes remote-runtime packaging for `linux-x64-glibc` and the native plugin command bridge.
Other execution-host targets require explicit compatibility verification; this draft does not claim support.
Plugin workflows remain inactive; remote-listing cache work remains deferred.

Codex speed selection preserves advertised request IDs and separates next-turn intent, host-applied
settings and actual processing evidence. Catalog failures and unavailable selections require explicit
recovery. Legacy Fast preferences and independently updated execution hosts retain compatibility.
These are intended behaviors; publish only after the final candidate's required verification passes.

The integration corrections add durable first-device admission, independent healthy-session catalog
refresh, serialized environment/journal mutations and WSL cancellation cleanup. Concurrency and
async-persistence fixtures cover these paths. Source review accepted the candidate; full CI and
installed-app acceptance are still pending, so these are not claims of a verified deployed fix.

## Verification and update acceptance

Record the exact candidate SHA/tree, full PR aggregate, registered tests, package digest and release
workflow run before publication. Deterministic cost checks do not establish installed-app latency,
CPU or memory performance. Requested Ultrafast does not establish actual server processing.

Before updating, preserve active sessions and the operational profile. Verify the installed package
and loaded executable separately. Record rollback or forward-repair evidence and any required user
restart action. These acceptance receipts are outstanding while this document remains a draft.

## Candidate acceptance record

Source landed, package installed and runtime loaded are separate gates. None is complete yet.

| Gate | Evidence required | Current state |
| --- | --- | --- |
| Candidate | Immutable commit/tree and consolidated patch registration | Pending |
| Review and CI | Independent review and full PR aggregate at that exact commit | Pending |
| Packaging | Protected dry runs, installer digest and packaged remote-worker/template inspection | Pending |
| Live update | Installed package plus running executable/version and preserved active work | Not run |
| Recovery | Native speed request evidence, local/SSH checks and rollback or forward repair | Not run |

Publication must replace these pending states with evidence. A picker selection alone is not proof
of outgoing request selection or actual Ultrafast processing. If upstream catalog metadata prevents
live Ultrafast acceptance, report that limitation separately from deterministic catalog coverage.
