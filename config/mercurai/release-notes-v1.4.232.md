---
owner: Mercurai release owner
last-reviewed: 2026-10-20
stability: draft
---

# Mercurai release based on Orca 1.4.232

Purpose: describe the frozen official-main update and retained Mercurai enhancements.
This draft is not a publication or installed-runtime verification receipt.

## Source boundary

Official main is frozen at `1bfb45654f7d7e847c157ff70f1c7e018b038511`.
The release floor is `v1.4.232`, release commit `49109f362f057cd2dc3d81cd378cb84d140c3dc5`.
That release differs from main ancestor `ba6599eabbdfed02eb7954c174bea704f853ecdc` only by
package version. This candidate carries all released code and 54 subsequent main commits,
336 upstream commits after the prior Mercurai boundary `613c5986`.
Later official changes belong to a subsequent frozen cut.

Candidate `820b64f496a42d7b43b9ea6e2b31fd98d5ecc209`, tree `9b756b3e9aa072610ff1d142d97835ff8238a5c5`,
source `ba17e3b2dbd8256486ae7671322390f594e5b003`; trees are identical.
Product candidate: [PR61](https://github.com/mercurai/orca/pull/61).
Exact-head CI and protected release receipts remain pending.

## Official changes included

- Native chat adds composer skill selection, Session History through `/resume`, longer-chat rewind,
  clearer usage-limit continuation and permission defaults (#30827, #28133, #30394, #30396, #30853).
- SSH/WSL improves Node download recovery, managed-tunnel recovery, reconnects and host ownership
  for same-path workspaces (#30981, #30945, #31069, #31062, #29005, #29042, #31055).
- Editor saves protect unnoticed disk changes; workspace watches, transcript streaming and session
  history caching reduce unnecessary background work (#30417, #30415, #30702, #30469, #30586).
- Settings saves MiniMax/GLM credentials on the selected execution host; browser HTTP authentication
  and phone reconnection/notifications improve (#30862, #30886, #30607, #30602).
- Packaging shares verified assets/ripgrep and excludes cloud sources; crash and hang diagnostics
  improve (#31010, #31005, #31004, #30691, #30692). Dark layout experiments remain disabled.

## Retained fork work and integration

Retain the Mercurai updater channel, diagnostics, username/signature and scan fingerprint reuse,
worker process launching, asynchronous secure writes, native plugin command bridge, catalog-backed
Codex speed selection, durable launch/retry/draft handling, and serialized environment/journal writes.
No complete upstream replacement for these mechanisms was established. Plugin workflows stay inactive.
Remote-runtime packaging remains scoped to `linux-x64-glibc`; verify execution-host versions separately.

The merge must bind speed admission and acknowledgment to the exact per-message execution options,
queue speed-only changes until the next turn, preserve explicit retry options and rejection intent,
and retain catalog/older-host refusal behavior. New host credential commands must await durable saves.
New pairing deduplication must retain whole-profile serialization, ordered sidecars and rollback fences.
Packaging must combine upstream ripgrep compaction with the fork's explicit target inventory.

Home/harness synchronization and manually resumed sessions across Codex homes remain separate
investigations. Those proposed fixes were not shipped in the previous Mercurai release and are not
claimed as implemented here. Upstream Session History improvements do not prove universal home sync.

## Verification and rollout

Before publication, record exact candidate/tree, independent review, full PR aggregate, deterministic
cost and compatibility coverage, protected dry assembly equality and Windows packaging receipts.
These are pending. No new numerical performance claim is made by source retention alone.

Keep requested speed, host-applied settings and server-reported processing distinct. Synthetic tiers
cover deterministic behavior; missing live Ultrafast metadata does not prove missing entitlement.
Actual processing remains unknown without server evidence. Do not install global catalog overrides.

Preserve active work and runtime-owned configuration. Treat source landed, package published,
package installed, main runtime loaded and execution-host updated as separate states. Native picker
and next-turn request acceptance still require the prescribed Electron skill and hidden Playwright CDP.
Do not restart the user's desktop merely to complete a source integration gate.

## Rollback and recovery

Retain the published `1.4.229-mercurai.1` installer and its exact release tuple as recovery inputs.
Do not open a newer profile database with an older executable without compatibility evidence.
Use supported stopped-profile backup/restore only after verifying database/runtime ownership and
preserving active work; prefer forward repair when downgrade compatibility is unproven.
Rollback rehearsal and operational profile/conversation preservation remain acceptance gaps.

Automation follows this release; this change does not enable an unattended conflict-resolution loop.
