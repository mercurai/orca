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

- Frozen official `main`: `98690db2ab1d53d7e67eae296dc061c000c2ea2f`.
- Stable floor: `v1.4.239`, peeled commit
  `47f77cf7018ebc0d046b82c6dde31cf704909162`.
- Candidate patch branch: `patch/current-main-release-98690`.
- Candidate head: `ffb802f98ef5dc3d239aad898eeb05bff22cce08`, with 19 commits
  after the frozen official ancestor.
- Candidate tree: `83aa6d0f4de7ec0e19f04651baca074b3d9a344d`.

The branch is published to the source fork for CI. Completion-audit corrections
repair relocated renderer imports, canonical-tier precedence, rejected-start
rollback over newer picks, and stale Windows/renderer test fixtures.
Targeted CI run [40397677548](https://github.com/mercurai/orca/actions/runs/40397677548)
checks this head. Full qualification and release-gate corrections remain pending;
no release receipt or published application is claimed.

Official `main` has since reached
`44d2fcb637f7736f66a9d3e7fee26516bf31daa8`, and the latest observed stable
release is `v1.4.241`. That target is queued for a subsequent integration step.
This draft's `v1.4.239` floor does not imply it contains the later release.

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
