---
owner: Mercurai release owner
last-reviewed: 2026-10-23
stability: draft
---

# Mercurai release based on Orca 1.4.237

Purpose: record the frozen source boundary, retained fork behavior and release gates.
This draft describes a candidate, not a published or verified installed update.

## Source boundary

Official main is frozen at `54e8ee5e961c1b3a5972322e2f20cbeb7ff0da40`.
The version floor is `v1.4.237`, release commit `071747853f5995ee233b36751613f09a60007c2b`.
The release commit differs from main ancestor `a04b2ebc33efebe6c24a7ef2eeb1ec9f1de8238d`
only by package version. Main therefore supplies the released product code and later main changes.
Later official changes require another explicitly frozen cut.

Product candidate: source merge `66107c52ca703f9ef27d5ba0bb1b2bd593315f8d` and linear patch
`406ae7b0f8b41efe3eb7f64844952230cfbf20eb`, with tree
`b4b6fdfa143f1d2812ebf24fd966e7a9b30cd6a0`. The patch branch is pushed; candidate verification remains pending.
The local manifest is provisional; production defaults remain on the previous released candidate.

## Integration behavior

Adopt upstream scoped, independent model-catalog discovery and session option records.
Retain explicit Codex speed intent, exact advertised request IDs, unknown/loading/unavailable states,
and refusal of unavailable paid tiers. Pending legacy Fast survives reported Standard state;
unavailable saved tiers do not advertise a false Standard compatibility setting to older clients.
The final upstream commit relocates provider retry transcript rules and their regression tests.

Retain the Mercurai updater channel, scan and username/signature reuse, diagnostic probes,
spawn worker routing, asynchronous secure writes and native plugin bridge. Plugin workflows stay inactive.
SSH maintenance and WSL ready persistence use pairing revision guards against queued stale writes.
WSL Add checks connection identity and preserves a replacement connection and its holder during cleanup.
Retained SSH-source reconciliation awaits journal durability and rechecks current catalog rows,
target generation/fence and journal head before changing visibility. Remote SSH watcher events
refresh the host renderer without publishing a host-blind local catalog event.
Launch creation retains permission admission, cancellation and the captured per-message selection.
A selection made while launch is pending remains available for the next turn.
These are source integration claims; full behavioral and cost verification remains required.

Home/harness synchronization and manual resume across account homes remain separate investigations.
No universal home synchronization fix is claimed in this release.

## Verification and rollout

Previous candidates failed CI. Reviewed discovery, launch, lifecycle and queued-owner corrections
are included; current-head CI is newly submitted. The previous full product suite failed;
reviewed async/fixture corrections and strict speed-refusal assertions address those failures.
Ubuntu WSL setup timed out twice before Orca acceptance; phase diagnostics are included,
on preceding candidates. Diagnostics located the stall in rootfs
download, before import. Windows attempts timed out after180seconds at about164MB
of392MB. The pinned Ubuntu image now downloads on Linux, verifies SHA256, transfers
through a same-run artifact and verifies SHA256 again on Windows before unchanged
plain/systemd imports. This transport passed both Ubuntu modes on the preceding candidate.
Its qualification test now requires the Ubuntu rootfs producer alongside the existing prerequisites;
the preceding full suite found exactly this stale expectation. Fresh exact-candidate checks remain required.
Windows launcher fixtures handle the platform suffix.
Retained-row calculations moved unchanged to a focused module to preserve the file-size gate.
The docs site pins Next.js16.4.1 to address blocking GHSA-2464-fhr4-w9xw and
GHSA-p3m5-59mp-jv5r findings. Updater-veto tests mock the current direct module boundaries
without changing their assertions or timeout. Fresh docs/security/updater checks remain required. Earlier passing checks do not approve this revision.
Desktop and mobile resolve DOMPurify3.4.17 to address critical GHSA-cg2g-xh64-v4q7
and high GHSA-mrv2-3pqr-j5jr findings. Exact release-age exceptions preserve the global
three-day dependency delay. Independent dependency review accepted the bounded lockfile changes;
fresh security and behavioral CI remain required.
Independent bounded review accepted the final legacy compatibility correction at `28bc8ff4e1`.
Full independent review, full PR checks, deterministic cost/compatibility checks, protected dry assembly
and Windows package checks must pass at the frozen candidate before publication. The upstream paired
CLI launch spec currently has two pre-existing E2E type errors; the candidate records that exact
baseline without changing runtime behavior.
All 207 predecessor test paths remain; scoped discovery, queued ownership and release regression
coverage bring the manifest to 218 unique test paths.
Path existence is not a test result.

Publish only through the protected assembler and publisher described in [the runbook](README.md).
Keep source landed, package published, package installed, runtime loaded and remote hosts distinct.
Preserve active work and runtime-owned configuration; verify executable/version after installation.
Retained accounts/conversations and the native picker-to-next-request path still need live acceptance.
Use the required Electron skill and hidden Playwright CDP; tooling remains unavailable in this session.
Keep requested speed, host-applied settings and server-reported processing distinct.
Missing live Ultrafast metadata does not establish missing entitlement; actual processing is unknown
without server evidence. Do not install a global catalog override or run a throughput benchmark.

## Rollback

Retain the published `1.4.232-mercurai.1` installer and its verified release tuple as recovery inputs.
Do not open a newer profile database with an older executable without compatibility evidence.
Preserve active work and use supported stopped-profile backup/restore if a downgrade becomes necessary.
Prefer forward repair while operational downgrade compatibility remains unproven.

Continuous upstream automation remains deferred until this release is deployed and accepted.
