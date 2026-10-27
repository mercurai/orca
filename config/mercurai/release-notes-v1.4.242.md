---
owner: Mercurai release owner
last-reviewed: 2026-10-27
stability: draft
---

# Mercurai release based on Orca 1.4.242

Preparation only. No release suffix, qualification, published package, installation
or loaded runtime is claimed. Use the existing version allocator after freezing
the final inputs; preserve that identity through review, CI, tagging and publication.

## Source boundary

- Official main snapshot: `cbbaa2d7635297916ea257a0287cc4ec6c12af25`.
- Stable floor: `v1.4.242`, peeled `86ad9d95cac792f3d1359d886cef9fb9b0aadd47`.
- Local candidate: `94c7a483d3a318c09cbea0b8d58126503f2aab46`, branch
  `patch/current-main-release-cbbaa`.
- Tree: `3d5970f8fce1d2b99be3c738a0f737702b71ec63`; two linear commits over main.
- Later observed main `53e6a7d4a948ff7c9bed422c975807b113fbe63a` is queued
  after this freeze; report freshness as observed lag.

This snapshot adds 115 official commits and 2,738 changed files beyond the previous
823ca preparation. Stable242's CI changes are already represented in this main
snapshot. Preserve its newer dependency manifest and inject the allocated Mercurai
version through the canonical packaging override.

## Retained behavior and open regressions

- Preserve catalog-backed Codex speed choices, exact request IDs, next-turn
  application, existing conversations, legacy migration and local/SSH compatibility.
- Keep process/file work asynchronous and bounded. Outbox publication waits for
  durable state, preserves dirty failures for retry and fences clear/account/hello
  changes. Concurrent port repair retires transports only for the accepted revision.
- Combine official WSL pending-stop, kept-host and holder semantics with async
  persistence and current-owner checks after awaits. Raw UNC fingerprint access
  and stale-registration removal have explicit regressions before their extra fixes.
  Service-level coverage requires a stale stop to preserve replacement status,
  wake intent and removal callbacks; helper-only success is insufficient.
- Preserve full qualification, authenticated owner acceptance of independent review,
  immutable assembly and monotonic publication. No partial run authorizes release.
- Keep recurring automation disabled until the release and recovery rehearsals pass.

Independent review accepted the integration/RED boundary, including its twelve
semantic conflict resolutions. It remains deliberately unqualified while the new
WSL regressions are reproduced and repaired.

The recovery source `8218bf9d21` passed hosted
[40472710805](https://github.com/mercurai/orca/actions/runs/40472710805): 1,351 Windows
tests passed, 16 skipped; both cost suites, 610 qualification contracts and 143
persistence tests passed. Seven reviewed repair blobs are byte-identical in this
candidate. Those results do not qualify the new combined revision.

## Evidence required before publication

1. Reproduce the new WSL cases in hosted CI, apply narrow fixes and pass fresh
   targeted checks without weakening the regression assertions.
2. Complete every required unit/layout shard and platform gate at the exact final
   source and controller revisions; record advisory results separately.
3. Allocate an unused version and accept independent final review through the
   authenticated intake, binding source/tree/controller/policy/manifest/ordered pins.
4. Build and publish through the protected release workflows; retain installer,
   manifest, provenance, freshness and immutable channel receipts.
5. Verify installation and actual executable/version while preserving active work;
   verify the installed picker and next outgoing request. State any user restart
   action. Keep actual processing unknown unless the server reports it.

Do not infer missing subscription entitlement from catalog omissions or claim
Ultrafast execution without server evidence. No throughput benchmark is required.

## Recovery and durable automation

Preserve the previous qualified installer and receipts. Pause admission before
recovery and prefer a forward repair when profile downgrade compatibility is
unproven. Source landing, publication, installation and runtime loading are separate
states. See the [authoritative plan](plans/2026-10-24-release-automation.md) for
remaining worker recovery, rehearsal, registration and schedule-enablement gates.
