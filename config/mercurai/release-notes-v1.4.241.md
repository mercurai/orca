---
owner: Mercurai release owner
last-reviewed: 2026-10-27
stability: draft
---

# Mercurai release based on Orca 1.4.241

Draft only. No version suffix, qualified candidate, published package or loaded
runtime is claimed. The release owner must reserve an unused `mercurai.N` version
before final independent review and preserve it through qualification and tagging.

## Source boundary

- Frozen official main: `823ca6870fd46bc979ee073ee0731516a0607daa`.
- Stable floor: `v1.4.241`, peeled commit
  `041baf356b368d773f333e76375ce860fba2481b`.
- Provisional linear candidate: `6941c6cd4abe5c73cdd2a024c6d6aeb0c71aec49`,
  draft [#82](https://github.com/mercurai/orca/pull/82).
- Tree: `c9da81a8a8146706a15448b59b4c6c6ba5621f0a`; final review and qualification pending.

The frozen main adds 91 commits beyond the previous `98690db2` preparation.
Stable's sole commit absent from main changes package version metadata. Its
functional parent is already included; controlled package-version injection
must reconcile the stable floor explicitly before packaging.

## Intended behavior

- Include the frozen upstream changes while retaining Mercurai's catalog-backed
  Codex speed selection, exact advertised request IDs and next-turn application.
- Preserve conversations, legacy settings, account isolation, resume and
  mixed-version local/SSH execution. Actual processing tier remains unknown
  when the server does not report it.
- Preserve async process/file persistence, bounded capture and host revocation
  fences. The new WSL focus path uses serialized async persistence and guarded
  reconnects; targeted CI cleared the reproduced wake/revocation regressions.
  This draft makes no measured responsiveness or memory improvement claim.
- Admit publication through the complete required PR matrix, authenticated
  owner acceptance of independent review, and immutable monotonic publication.
  These controller repairs remain unqualified and disabled.

## Release evidence required

1. Verify the independently reviewed saved-model binding correction in fresh CI.
   Source3dd passed 1,317 targeted tests with16skipped, but full CI reopened type/lint
   errors. Source065d includes those repairs and durable migration journal corrections.
   Targeted run40442414377 and full PR CI remain pending. Source registration and
   independent source review alone do not qualify the release.
2. Pass targeted behavioral checks and the complete required matrix at the exact
   candidate, including every planned unit/layout shard. Record advisory results
   separately; Windows D7 is outside the required layout call.
3. Accept independent review of the final candidate/controller through the owner
   intake. Preserve exact commit, tree, upstream inputs, manifest, policy,
   ordered patch pins and reserved version through assembly and tagging.
4. Package and publish through the existing protected Windows release mechanism.
   Record installer/update-manifest digests, provenance, freshness and latest
   channel verification; never overwrite a different published artifact.
5. Verify installation and the running executable/version while preserving active
   work and runtime-owned configuration. Verify the installed picker and outgoing
   next-turn request before declaring the Codex feature delivered.

Missing advertised Ultrafast metadata remains an upstream limitation, not proof
of absent entitlement. Claim actual Ultrafast execution only with server-reported
evidence. No throughput benchmark or unrelated inference workload is required.

## Rollback and recurring automation

Retain the previous qualified installer, release receipt and profile compatibility
evidence. Pause coordinator admission before recovery, preserve active work and
candidate evidence, and prefer a forward repair over an unverified profile downgrade.
Source landing, package publication, installation and loaded runtime are separate
states. Recurring automation remains disabled until the release and a nonpublishing
rehearsal are accepted. See the [authoritative plan](plans/2026-10-24-release-automation.md).
