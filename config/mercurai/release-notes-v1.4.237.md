---
owner: Mercurai release owner
last-reviewed: 2026-10-22
stability: draft
---

# Mercurai release based on Orca 1.4.237

Purpose: record the frozen source boundary, retained fork behavior and release gates.
This draft describes a candidate, not a published or verified installed update.

## Source boundary

Official main is frozen at `ec5eaf96c174d907ea914b1a8d58edd9cb35f9e1`.
The version floor is `v1.4.237`, release commit `071747853f5995ee233b36751613f09a60007c2b`.
The release commit differs from main ancestor `a04b2ebc33efebe6c24a7ef2eeb1ec9f1de8238d`
only by package version. Main therefore supplies the released product code and later main changes.
Later official changes require another explicitly frozen cut.

Product candidate: [PR68](https://github.com/mercurai/orca/pull/68), source
`0e3986fb6c3ecfcd6041bfc5273068ca4f174b5d`. Do not merge the comparison PR into its CI base.
Local linear patch `d41be6dd3a64bf95a50a8267f46f41e7503e29a7` has the identical tree
`b0145c7d3702c4d0ed444fe10ad758e248c9760e`; the patch branch is pushed, while candidate verification remains pending.
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
Launch creation retains permission admission, cancellation and the captured per-message selection.
A selection made while launch is pending remains available for the next turn.
These are source integration claims; full behavioral and cost verification remains required.

Home/harness synchronization and manual resume across account homes remain separate investigations.
No universal home synchronization fix is claimed in this release.

## Verification and rollout

Previous candidates failed CI. Reviewed discovery, launch, lifecycle and queued-owner corrections
are included; current-head CI remains queued. Earlier passing checks do not approve this revision.
Independent bounded review accepted the final legacy compatibility correction at `28bc8ff4e1`.
Full independent review, full PR checks, deterministic cost/compatibility checks, protected dry assembly
and Windows package checks must pass at the frozen candidate before publication.
All 207 predecessor test paths exist; the draft manifest adds scoped discovery and queued WSL ownership regressions (209 paths).
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
