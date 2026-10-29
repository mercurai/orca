---
owner: Mercurai release owner
last-reviewed: 2026-10-29
stability: draft
---

# Mercurai release based on Orca 1.4.242

Preparation only. No release suffix, qualification, published package, installation
or loaded runtime is claimed. Use the existing version allocator after freezing
the final inputs; preserve that identity through review, CI, tagging and publication.

## Source boundary

- Official main snapshot: `cbbaa2d7635297916ea257a0287cc4ec6c12af25`.
- Stable floor: `v1.4.242`, peeled `86ad9d95cac792f3d1359d886cef9fb9b0aadd47`.
- Remote candidate: `6e21f9861780a6dec1a55a20725a0e6cd284c503`, branch
  `patch/current-main-release-cbbaa`.
- Tree: `8b11466b1d58a66fb9ccf6e35c2130767c601f2b`; seven linear commits over main.
- Later observed main `7f4c8f606435d4ca90964e176e860626ffba918a` and stable244
  are queued after this freeze; report freshness as observed lag.

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
  and stale-registration removal now have independently reviewed narrow fixes after
  meaningful hosted RED. A stale stop preserves replacement status, wake intent and
  removal callbacks; the serialized store returns whether removal was accepted.
- Preserve full qualification, authenticated owner acceptance of independent review,
  immutable assembly and monotonic publication. No partial run authorizes release.
- Keep recurring automation disabled until the release and recovery rehearsals pass.

Independent review accepted the integration and WSL fix boundaries, including the
twelve semantic conflict resolutions. Hosted40844702585 reproduced four WSL failures
at94c7 with266persistence tests passing; Windows1360passed/16skipped, both cost jobs
and611contracts passed. Hosted40846970058 at6d57 passed all three targeted jobs after
the pairing fixture's native-DACL teardown isolation. Full controller CI then exposed
a1MiB changed-file output limit; real-Git regression40847371955 reproduced ENOBUFS
with613contracts passing/1failing. The reader now matches the existing64MiB tracked-file
bound without weakening scope. Hosted40847881117 at2ec5 passed all three targeted jobs.
Full controller CI then exposed five watcher-test ratchet findings. Native-event assertions
and wait bounds remain intact while `vi.waitFor` replaces manual polling; the model
explains its existing timeout without changing it or the1,000seeds. Fresh40849629838
at6e21 includes these suites and is pending. These partial checks do not qualify the release.

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
