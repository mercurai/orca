---
owner: Mercurai release owner
last-reviewed: 2026-10-26
stability: draft
---

# Mercurai release based on Orca 1.4.239

This is draft release material. It describes the frozen source candidate; it
does not claim a tag, package publication, installation, or runtime acceptance.
The `mercurai.N` suffix is allocated by the protected assembler after
qualification.

## Source boundary

- Official `main`: `d58849a7d8d68929bd0e686571678d85e70740af`.
- Stable floor: `v1.4.239`, peeled commit
  `47f77cf7018ebc0d046b82c6dde31cf704909162`.
- Candidate patch branch: `patch/current-main-release-d58849a7d8`.
- Candidate patch commits: `5ce0aead4533980294b8c26989a173501361ee27`, then
  `a06bff3b3578b1abf1abc73a5cce15a21bc02a1b`.
- Candidate tree: `73fbf286056a9106df8acd1a947dda7c8f59263a`.

The initial linear materialization of reviewed merge candidate
`3c7d22012cfae09aa32ed03c41a306b201922e74` is `5ce0aead4533980294b8c26989a173501361ee27`,
with official `main` as its parent. The workflow-only stop-coverage correction
`a06bff3b3578b1abf1abc73a5cce15a21bc02a1b` follows it; the two-commit branch
starts from official `main`, and its final head has `5ce0aead` as its parent.
The patch branch must be visible at the
exact pinned head before assembly.

Official `main` later advanced to
`f07673123107caafbfb3aa28763c72d77433b308`. That movement is queued for a
separate candidate generation; this draft does not silently claim those newer
commits are included. A read-only replay found three conflicts in the E2E
type-error baseline, native-chat send recovery, and cross-version device-key
coverage.

On 2026-10-26, official `main` advanced again to
`98690db2ab1d53d7e67eae296dc061c000c2ea2f`. A fresh replay against the frozen
candidate reports 108 conflicts across runtime, persistence, WSL/SSH, Codex,
renderer, workflow and E2E files. This draft remains pinned to the earlier
candidate; the newer SHA is queued until each conflict receives a semantic
disposition and exact-candidate CI.

The queued conflicts have a local reconciliation for review at
`codex/upstream-986-reconcile`, commit
`4a7d6bd2f993089ecb9ae5f9461ba3a534d0edc2`, tree
`3548a5bc4a6bcf0a56c7f2ee2f66cc9e9240a76c`. The commit is a two-parent merge
of the retained candidate and official `main`; it is not yet a release input.
The release owner must review it, materialize the required linear candidate,
then run exact-SHA CI before changing the manifest or allocating a tag.

## Retained Mercurai behavior

- Catalog-backed Codex speed selection with exact advertised service-tier IDs,
  legacy migration, persistence, resume, and next-turn application.
- Async process/file paths, structured-clone preservation of captured bytes,
  secure-write serialization, runtime persistence, and host-restart guards.
- Mercurai update-channel behavior, diagnostics, account/profile handling,
  remote/SSH/WSL compatibility, and other-provider controls.
- Existing release workflows, protected packaging boundaries, and disabled
  recurring release automation.

## Required evidence before tagging

1. Exact-SHA full CI and targeted regressions pass.
2. Independent review accepts the exact candidate and controller revision.
3. Protected assembly reproduces the candidate tree and verifies the frozen
   source, manifest, policy, and review identities.

## Required evidence before publication

4. Protected packaging produces the Windows artifacts and records their
   digests for the exact qualified candidate.
5. The publisher accepts the qualification receipt and uploads only those
   recorded artifacts under the allocated `v1.4.239-mercurai.N` tag.

## Post-publication acceptance

The following evidence is collected after the protected package is published:

6. Installation and loaded-runtime verification preserve active work and
   runtime-owned configuration.

Missing live catalog metadata or server-reported processing-tier evidence must
remain an explicit limitation; it must not be reported as successful Ultrafast
execution.

## Rollback

Keep the last qualified Mercurai installer and channel receipt as recovery
inputs. Disable new coordinator admission first, preserve candidate state and
receipts, and prefer a forward repair. Do not downgrade a migrated profile
without compatibility evidence.
