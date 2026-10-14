---
owner: codex-01a1273e
last-reviewed: 2026-10-14
stability: draft
status: review-corrections
---

# Catalog-backed Codex speed selection

## Purpose and current state

Implement Standard, Fast and Ultrafast selection through Orca's existing model catalog and option picker.
This is the authoritative specification, ownership map and execution plan for this change.
The user authorized core implementation and rollout; the fleet retains landing and release ordering.
Independent local GPT-6 Astra/ultra plan review approved the revised contract. Regression tests are written;
CI run 38468679286 established expected missing-tier/seed/migration behavior failures at dcd4aaf3ef.
Static/type checks passed. Shard 1 also failed an unrelated filesystem-watcher test; shard 3 includes
win32-test-lane-registration baseline failures. Shared contract commit 254d965abd passed independent GPT-6.1/medium slice review after malformed-toggle
and storage-bound corrections; static/type checks passed in CI run 38482816065. Its shared parser/migration
suite passed 80 tests and its seed suite passed 21 tests. Windows/main packaging, relay integration and
cross-version wire compatibility passed. The full run failed on remaining host/restoration/launch/presentation
red tests and two Windows registration baseline cases; this is not final candidate verification.
Generic callbacks use provider-neutral shared types, optional speed facts, and a direct complete-map return.
Real local Sonnet B/C/D/L writers now implement the non-overlapping host, at-rest, picker and launch slices.
Slice C passed independent GPT-6.1/medium review after canonical model/effort ordering correction; its new
tests passed in CI run 38485011107 at b0206bb095: 24 at-rest tests and five disk round-trip tests.
That revision also passed static/type checks, Windows/main packaging and wire compatibility. F's new
explicit-default tests produced the expected red result: 11 tests, nine failed, two passed.
The completed run failed with 54 cases: 51 expected feature regressions, two Windows registration
baseline failures and one new SQLite test registration omission. The five disk cases ran under Bun;
register them in the required Node project and rerun before claiming accepted persistence coverage.
Review identified a live-refusal gap: preserving the
previous accepted tier alone permits autonomous queued sends to fall back after a refused new selection.
Retain refused requested intent separately, block next-turn admission until explicit accepted replacement,
and protect client pending picks and already-reserved sends with host/generation fencing.
Independent B/D/L review found additional catalog provenance, transport submission, live/resting,
launch admission/reload and mobile identity/facts issues. Sonnet hit its weekly limit on October 13;
saved test edits required correction. On October 14 the real Sonnet writer completed F's saved-default
fix and bounded B/C/D/L regression correction writers resumed. Keep the established implementation
model and independent Codex review; no model switch was required. Tests remain CI-only.
Owner override: "There's no reason to use server one for the implementation. Go ahead and execute everything here."
Implementation and independent review run locally. Build freeze and CI-only test admission remain in force.

- Worktree: `C:/Users/svere/orca/worktrees/codex-speed-selection`.
- Branch: `codex/codex-speed-selection`.
- Base: upstream `v1.4.224`, commit `2bb20586ebc39d605e16d95f57420e20a16e7485`.
- Active harness identity: `CODEX_THREAD_ID=01a1273e-01d1-7e12-8f0f-99a926abdd95`.
- Native plugin work stays in its separate worktrees; this change owns none of their files.
- Draft CI/review PR: https://github.com/mercurai/orca/pull/42. Branch is pushed; nothing is landed or installed.

## Revalidated flow and failure boundaries

The five paths named by the user retain their reported restrictions at this base:
`codex-structured-fast-mode.ts` keeps only Fast, `codex-structured-model-catalog.ts` projects a single ID,
`structured-agent-session-options.ts` creates a boolean, `codex-structured-session-options.ts` rejects
direct tier writes, and `codex-structured-turn-start.ts` derives routing only from the boolean.

The additional paths matter to correctness:

| Boundary | Existing behavior | Required change |
| --- | --- | --- |
| Launch seed | Allows only model, effort and fastMode | Preserve canonical serviceTier |
| At-rest option write | Validates keys, not Codex tier values | Provider-owned catalog validation |
| Resume reconciliation | Deletes serviceTier; can disable Fast silently | Preserve explicit intent and report unavailable state |
| Catalog persistence | Reconstructs a closed model shape | Round-trip additive tier metadata |
| Generic select snapshot | Hides one-choice selects; appends obsolete values as normal choices | Show Standard and disable unavailable choices |
| Catalog refresh | A live catalog can suppress a later host catalog update | Revalidate speed without erasing session intent |
| Dispatch rejection | Generic pre-write errors become uncertain delivery | Return definite rejection before a request was sent |
| Actual processing | Thread open reports routing metadata only | Keep actual turn processing unknown unless directly reported |

`turn/steer` carries no speed override. Preserve that behavior: changes apply to the next `turn/start`.
Catalog identity is already scoped to the execution host, account home and WSL context. Preserve it.
A running conversation remains pinned to its original account; changing the global account affects new launches.

## Contract to lock in plan review

1. Add optional service-tier choices to `AgentSessionModelOption`, carrying exact request ID, label and description.
   Use absent metadata for unknown support and an explicit empty advertised list for known Standard-only support.
   Represent Standard explicitly with the provider's advertised Standard ID, or protocol `default` when omitted.
   Preserve all valid advertised tiers; never manufacture Ultrafast from a model name or subscription assumption.
   Modern `serviceTiers`/`service_tiers` takes precedence over legacy
   `additionalSpeedTiers`/`additional_speed_tiers`, including a modern empty array.
   Legacy strings use their advertised request values; do not invent an alias for an unrecognized tier.
   Keep `supportsFastMode` and `fastModeTierByModel` as compatibility projections, derived from the same rows.
2. Use `serviceTier` as the canonical bounded string option. Explicit serviceTier wins over saved fastMode.
   Migrate false to Standard and true to that model's advertised Fast ID. If true cannot resolve, retain intent
   and mark it unknown/unavailable; do not convert it to false or send Standard. An explicit legacy toggle from
   an old client is a new user action and deliberately replaces canonical selection with Standard or advertised Fast.
   Existing supported tier strings survive loading, persistence and resume. Retired IDs remain visible and blocked.
3. Add a runtime capability, provisionally `agent-session.codex-service-tiers.v1`, to the existing capability list.
   Reuse `agentSession.setOption` and existing launch records; introduce no stream opcode or protocol-version bump.
   Require affirmative execution-host support before new tier writes, held launch picks or canonical launch seeds.
   Unknown/older hosts retain the existing Fast control. They receive no Ultrafast or unsupported canonical seed.
   Do not silently translate an explicit Ultrafast intent to an old-host Fast toggle; explain that host update is needed.
   New hosts continue accepting old clients' valid boolean writes. Claude and other providers retain their controls.
   Never seed Codex-only serviceTier into another provider's launch. Gate host-owned defaults as well as held picks.
4. Extend `restingOptions` with optional `normalizeOptions(input)` and `readOptions(input)` callbacks.
   Normalization input is `{ priorOptions, changes, origin, models, currentModel, catalogKnown }`: both option maps
   contain bounded encoded strings; `origin` is `restore`, `launch` or `set-option`; keys in `changes` identify the
   actual user action. The destination model is `changes.model ?? priorOptions.model ?? currentModel`.
   Restore/launch preserves unsupported saved IDs and unresolved legacy true as intent, without dispatching them.
   A model/effort change retains existing tier intent even when unavailable for the destination model.
   An explicit unsupported serviceTier write rejects; an explicit fastMode toggle deliberately replaces canonical
   intent. readOptions takes `{ options, models, currentModel, catalogKnown }` and returns the optional canonical
   current values and speed facts. Both live and at-rest Codex paths reuse the same pure tier-selection rules.
   Generic host code invokes callbacks without provider-name branches, persisting the complete normalized option map.
5. Add optional speed facts to options results, with separate requested next-turn selection, host request/application
   evidence and server-reported processing evidence. Lock these additive fields:
   `AgentSessionModelOption.serviceTiers?: AgentSessionOptionChoice[]` uses existing value/label/description fields.
   `AgentSessionOptionsResult.current.serviceTier?: string` is canonical host-stored next-turn intent.
   `AgentSessionOptionsResult.speed?: AgentSessionSpeedFacts` is absent on older hosts and other providers.
   Speed facts contain `selection: { tierId?: string, legacyFastMode?: true, state: unselected|ready|unknown|unavailable }`,
   `lastRequest?: { clientMessageId, tierId, turnId?, state: sent|accepted|rejected, detail? }`,
   `applied?: { clientMessageId, tierId, turnId? }`, and `processing?: { turnId, tierId }`.
   A new attempt replaces lastRequest, never the prior applied or processing observation until positive evidence.
   Set sent only when the exact ID has been submitted; accepted only on the matching provider answer; rejected on a
   definite pre-write/provider refusal. applied records host-serialized settings of an accepted request, never an
   inferred server processing tier. Unknown delivery must not be labeled rejected or accepted.
   processing requires a documented per-turn server fact and stays absent otherwise; UI labels absence unknown.
   Client-held/pending requested selection stays separate from current.serviceTier until host acknowledgement.
   A setOption acknowledgement proves stored intent only. A sent turn/start records its exact requested ID and turn
   association; a thread/start or resume routing report is not actual processing evidence. A pending next-turn change
   preserves the last turn's evidence instead of relabeling it. Actual processing displays
   unknown unless a documented per-turn server response explicitly reports it. Do not persist invented observations.

## User-visible and execution rules

Use the current select infrastructure. Show loading, unknown catalog support, unavailable saved selection and
server rejection as separate actionable states. Keep Standard visible when it is the only available tier.
Show unadvertised Fast/Ultrafast as unavailable presentation, never as admitted choices; avoid duplicate IDs.
Selecting a higher-usage tier is explicit and carries an increased-usage description, without guessed multipliers.
Model/account/catalog changes revalidate exact IDs and preserve requested values until the user chooses a replacement.
Stale asynchronous results cannot update another session, account, model or execution-host generation.
The selector says changes apply to the next turn, including while a turn runs.

Before each turn/start, validate explicit selection against that session's current execution-host catalog.
Protocol Standard (`default`) is admitted even when tier metadata is unknown, including migrated fastMode=false.
An unknown custom Standard ID, other custom saved ID or unresolved legacy Fast remains blocked until validated.
If an explicit non-default selection is unsupported/unknown, reject before sending and keep the message retryable.
An upstream rejection preserves requested intent, clears any misleading success/application state, surfaces the
provider's bounded diagnostic, and offers catalog refresh or another selection. Never retry at a cheaper tier silently.
Untouched launches preserve the provider's configured defaults; loading this feature must not introduce paid flags.
Free-form launch arguments and workspace config must not silently override an explicit picker choice.
An explicit speed refusal during launch blocks publication to first-prompt senders; it must not continue with the
previous/default speed. Preserve the created conversation, requested selection and staged text for explicit recovery.
Revalidate capability and catalog generation immediately before publication and first-prompt delivery.
Only an explicit replacement selection or a supported host resolves this launch block; do not recreate the conversation.

## Ownership and dependency DAG

All implementation writes occur only in this owned worktree. Acquire/review the named fleet ownership before edits.
No worker owns another worker's files; matching existing tests belong to the production file's owner.
Root integrates and resolves interfaces, with no parallel edits to shared contracts. A freezes the provider validator
and speed-fact wire interfaces before B/C/D start; C consumes the interface and never changes it in parallel with B.

| Wave | Task | Dependencies | Maximum safe concurrency |
| --- | --- | --- | --- |
| 0 | Fleet plan review, path ownership and contract lock | None | One routed reviewer |
| 1 | A: shared wire/capability/seed contracts and behavioral tests | Wave 0 accepted | One writer |
| 2 | B: host catalog/request; C: at-rest options; D: desktop/mobile UI; L: launch boundary | A | Four non-overlapping writers |
| 3 | E: integration, documentation and acceptance coverage | B, C, D | One writer |
| 4 | Independent review and exact-head CI | E | Read-only review and CI may overlap |
| 5 | Owner assembly, package install and live acceptance | Review and CI pass | One release owner |

Only the shared contract creates the wave-1 barrier. B/C/D share interfaces, not write paths.
If fleet availability permits only one writer, execute B/C/D serially without changing scope.
No production code starts until the mandated plan review has no open blocker/high finding.
Write behavioral tests first; obtain the expected failing evidence in CI before implementing each slice.
Local builds remain frozen; local tests remain CI-only until admission is explicitly granted.

### A: root-owned shared contract and migration

Writable production paths:
`src/shared/agent-session-wire.ts`, `src/shared/protocol-version.ts`,
`src/shared/native-chat-session-option-defaults.ts`, `src/shared/native-chat-session-options.ts`,
`src/shared/agent-session-option-catalog-types.ts`, `src/shared/structured-agent-session-option-codec.ts`.
Also own `src/main/native-chat/agent-session-wire/structured-agent-definition.ts` to freeze the provider validator.
Also own `src/shared/agent-session-speed-facts.ts` and `src/shared/structured-agent-session-resting-options.ts`
for focused wire facts and provider-neutral callback types. The initial writer added the facts file outside its
explicit assignment; root reviewed the extraction and records ownership before further writes.
Add `src/shared/codex-service-tier-selection.ts` and its behavioral tests for pure selection/normalization reused
by live, at-rest and presentation consumers; existing fast-mode reconciliation is the closest analog.
Add the seed key and optional metadata/capability without changing other providers' boolean encoding.
Verify capability registration at both desktop and remote host publishers; assign any discovered publisher path
to A before editing. Cover precedence, absent fields and old serialized records with shared behavioral tests.

### B: host catalog and outgoing request

Writable production paths under `src/main/codex/`:
`codex-structured-fast-mode.ts`, `codex-structured-model-catalog.ts`, `codex-structured-catalog-entry.ts`,
`codex-structured-background-catalog.ts`, `codex-structured-session-options.ts`,
`codex-structured-session-acquire.ts`, `codex-structured-session-state.ts`,
`codex-structured-turn-start.ts`, `codex-configured-launch-defaults.ts`, `codex-structured-agent-definition.ts`.
Also own `codex-structured-session-adapter.ts` if provider acquisition/report merging requires preserving
refused requested intent. Use one bounded provider-private rejected-tier marker in the existing option map;
keep the accepted canonical tier unchanged. Preserve the marker across refresh, model/effort changes and
restart. Clear it only after an explicit accepted replacement. Do not admit it as a public option key or
serialize it into provider requests. Expose blocked requested intent through existing speed selection facts.
Own `codex-structured-speed-intent.ts` if focused provider wrappers need extraction, and
`codex-app-server-connection.ts` / `codex-app-server-connection-types.ts` with matching tests for
an optional internal submission callback at the transport write boundary. Record no `sent` fact for
closed/exited/serialization refusals. Use shared A's valid legacy-toggle intent policy consistently
in live and resting paths; unresolved Fast remains blocked at next-turn admission.
Own `codex-app-server-request-not-submitted-error.ts` for an internal typed proof of closed/exited/
serialization refusal before writing. Post-submission transport failures remain uncertain; synchronous
write failures must not claim definite non-delivery without proof. Provider replies remain distinct.
The generic internal option rejection constructor gains optional third argument
`refusalOptions?: Readonly<Record<string, string>>`; B supplies a complete map and C persists it.
Also own `src/main/native-chat/agent-model-catalog/agent-model-catalog-persistence.ts` and
`agent-model-catalog-store.ts` and `agent-model-catalog-entry.ts` in that directory when metadata requires changes.
Reuse catalog models for tier storage, keeping legacy Fast projections; avoid a second catalog service or registry.
Revalidate before the write, distinguish local rejection from uncertain transport failure, and record outgoing evidence.
Use synthetic models and custom tier IDs; test catalog refresh, server refusal and steering versus next-turn requests.

### C: provider-owned at-rest validation and conversation restoration

Writable production paths under `src/main/native-chat/agent-session-wire/`:
`structured-agent-session-options-read.ts`,
`structured-agent-session-option-restoration.ts`, `structured-agent-session-turns-options.ts` only if required.
Also own `structured-agent-session-option-error.ts`: optional internal complete refusal-state options let
provider-neutral live/at-rest catches persist the block before returning a refusal. Persistence failure
must propagate. This adds no wire field or database schema and never reports the failed choice accepted.
Own focused `structured-agent-session-speed-refusal-persistence.test.ts` for the real generic live
mutation boundary, including refused-state persistence failure and unchanged other-provider errors.
Register that real journal fixture in the Node project too. Refusal-state maps apply only to
`optionRejected`; `providerStarting` must not persist them even if an error supplies one.
B supplies Codex's definition implementation through A's frozen interface; C never edits either definition file.
Preserve complete option maps through at-rest writes, live writes, record reload and same-conversation resume.
Verify existing account-home and provider-handle identity survives. Test Claude with the optional validator absent.
Own the one test-path addition to `config/scripts/vitest-node-runtime-files.mjs`; no broader CI changes.

### D: selector, loading/unknown/unavailable states and execution-host gating

Writable shared presentation paths:
`src/shared/structured-agent-session-options.ts`, `src/shared/native-chat-session-option-snapshot.ts`.
Writable desktop paths under `src/renderer/src/`:
`runtime/structured-agent-session-client.ts`, `runtime/structured-agent-session-host-capability.ts`,
`components/native-chat/use-structured-agent-session-options.ts`, `use-structured-agent-session-option-state.ts`,
`use-host-model-catalog-upgrade.ts`, `NativeChatSessionOptionPickers.tsx`, `native-chat-session-option-labels.ts`,
`lib/structured-agent-session-host-admission.ts`.
Focused presentation modules are also owned by D: `src/shared/codex-service-tier-presentation.ts`,
`codex-speed-facts-presentation.ts`, `structured-agent-session-option-picks.ts`, and desktop
`use-structured-agent-session-speed-gate.ts`. Root records these extractions before further corrections.
Live send admission additionally owns desktop `components/native-chat/structured-agent-session-send-attempt.ts`,
`components/native-chat/use-structured-agent-session.ts` and
`use-structured-agent-session-queued-messages.ts`, with matching tests. Reuse central send holds;
retain refused requested intent until an explicit replacement is acknowledged for the same host generation.
The existing desktop `structured-agent-session-pending-sends.ts` is also owned by D for host-scoped
speed admission through that central state. Add `codex-speed-send-admission.test.tsx` for bounded integration
coverage; do not build a second pending-send registry.
Writable mobile paths under `mobile/src/session/`:
`use-mobile-structured-agent-options.ts`, `use-mobile-host-model-catalog-upgrade.ts`,
`MobileNativeChatSessionOptionPickers.tsx`, `MobileNativeChatSessionOptionRows.tsx`,
`mobile-native-chat-session-option-labels.ts`, `mobile-structured-agent-session-host-support.ts`,
`use-mobile-structured-agent-session.ts`.
Mobile actual-send and queue seams also belong to D: `use-mobile-structured-send-with-outcome.ts`
and `use-mobile-structured-queued-message-controls.ts`, with matching tests.
Focused tests may use `mobile-codex-speed-options-facts.test.ts` and
`mobile-codex-speed-send-admission.test.ts`; extract the saved oversized mobile options additions
before further corrections. Preserve actual controller forwarding and both clients' write assertions.
Mobile facts and action provenance may update `use-mobile-native-chat-session-option-controller.ts`
and `use-mobile-native-chat-controller.ts`, with matching tests. Preserve explicit accepted legacy
action provenance for older-host at-rest acknowledgements that echo canonical and boolean values
together; generic restored batches still prefer canonical. Show persisted blocked requested intent
from `speed.selection` separately from `current.serviceTier`, including a fresh client after restart.
Focused mobile parent-forwarding coverage may use `mobile-codex-speed-parent-forwarding.test.ts`;
the existing parent controller test is already large. Never make a fixture-only mapping stand in for
the production forwarding path. D may extract `structured-agent-session-option-acknowledgement.ts`
under `src/shared/` if needed to keep explicit-action handling focused without a file-limit exception.
Generated localization catalogs may change only for the new strings using repository localization tooling.
If a launch boundary needs another file, update this ownership map before writing; do not broaden scope silently.
Use existing UI primitives and style tokens. Old-host controls remain selectable; new speed controls require capability.

### L: root-owned launch boundary, separate from D

Writable production paths under `src/renderer/src/lib/`:
`launch-structured-agent-session.ts`, `structured-agent-session-launch-options.ts`,
`structured-agent-session-launch.ts`, `structured-agent-session-launch-prompt.ts`,
`structured-agent-session-launch-publication.ts`, `structured-agent-session-launch-registry.ts`,
`structured-agent-session-launch-persistence.ts`, and matching reload/error/failure/outcome helpers only
when needed for the existing recovery path. Matching tests belong to L.
The focused `structured-agent-session-launch-speed-record.ts` extraction belongs to L; root records
its path before further corrections.
L also owns `structured-agent-session-launch-recovery.ts` and `structured-agent-session-launch-draft.ts`
for same-conversation recovery and existing composer draft preservation. Add focused
`codex-speed-launch-admission.test.ts` rather than extending tests past the repository cap.
Guard local and host-owned canonical seeds before create and before first delivery. Preserve held speed
intent across model changes, refusals and reload. A speed refusal blocks publication and inventory-driven
unblocking, while a model refusal keeps its existing behavior. Retain the created session receipt and
staged text; an explicit replacement retries the same conversation rather than creating another.
D exposes `readStructuredAgentSessionCodexSpeedSupport(target)` from the runtime client, returning
`unknown|supported|unsupported` through the existing capability probe. L imports this frozen helper;
D and L never edit each other's files or duplicate probes.
A adds optional `SessionOptionSelectChoice.disabled` for unavailable presentation rows.

### F: explicit saved-default actions (root-owned)

`native-chat-session-option-defaults.ts` remains root/A-owned. Matching behavioral tests include
`src/shared/codex-service-tier-default-actions.test.ts`. Verify that an explicit Codex Fast toggle
replaces previously saved canonical speed and that an explicit canonical choice removes stale Fast.
Restore precedence still favors canonical values; action precedence must not accidentally seed the
previous paid tier after an older-host Fast-off action. No callback or consumer signature changes.
When a committed batch contains canonical and compatibility values together, canonical wins in either
pick order. A full settings replacement has no explicit-action provenance and retains restore precedence.
Execute this bounded correction after independent trace and red CI evidence, without writing B/C/D/L files.

### E: root-owned integration and delivery

Temporary `.github/workflows/codex-speed-catalog-sync.yml` belongs to E. One narrowly scoped CI
generation job may use existing localization/formatter tooling and upload an inspectable patch;
it must not skip or replace required PR checks. Use only the lane's auxiliary generation branch,
read-only GitHub permissions, no secrets and no deployment. Remove the helper from the final patch.
Generated English catalogs under `src/renderer/src/i18n/` belong to E for these new strings only.

Update `docs/site/content/docs/agents/codex.mdx` and `native-chat.mdx` in the same directory with selector,
next-turn, older-host and unavailable-tier behavior. Keep this plan's acceptance evidence current.
Inspect the combined diff for missed launch/resume consumers and simplify before independent review.
The fork owner owns `config/mercurai/patches.yaml`, release notes and assembled version metadata; this lane does not
edit those shared files. Supply the reviewed patch SHA and targeted test list for that owner to record.
Do not independently bump upstream `package.json` or choose a released version; assembly provides build identity.

## Acceptance evidence

### Pending review corrections

| Slice | Production corrections | Regression corrections before red CI |
| --- | --- | --- |
| B | Keep absent tier metadata unknown; remove stale legacy synthesis; record submission at actual write; align live/resting legacy intent; retain refused requested tier separately and block starts. | Add newer-unknown-after-old-Fast and real closed/terminal connection cases; legacy acknowledgement equivalence. |
| C/F | Persist typed provider refusal-state maps before returning refusal; propagate persistence failures; register disk test in Node. Explicit defaults replace stale counterpart; canonical batch wins. | Assert refresh cannot unblock refused intent; refused-state and replacement persistence failure preserve durable state. F already has nine expected red failures. |
| D | Rebuild controls on metadata/capability loss; capable unknown models show Standard recovery; fence mobile client/source changes; expose mobile facts; retain pending/refused intent and gate ordinary/reserved/queued sends. | Use real queue-controller wiring instead of test-only sessionId; attempt paired target after cutover; assert both clients receive no stale settings writes; add stable-client/source and late-unknown cases; test actual mobile forwarding; extract focused mobile additions. |
| L | Recheck generations/cancellation after awaits and at delivery; capability-gate every canonical seed/write including Standard; explicit legacy replacement supersedes canonical; preserve both speed forms across model change; recover authoritative selection and existing receipt/draft. | Clear draft cache before setting storage; discard parked prompts and reset sends/fences in original/fresh module instances; replace fake reload; add host/catalog/model probe cutovers, delivery invalidation and held SSH picks; assert successful recovery publication and no persisted private diagnostic. |

Reviews are independent and read-only on slice diffs, not immutable final-head acceptance. On October 14,
B, C, F and L regression corrections passed independent red-test readiness review. L now uses fresh-module
reload and teardown isolation; its production findings remain open. D completed actual mobile parent
forwarding, stable-client source-cutover, old-host action provenance and persisted-refusal regressions;
independent review is pending. No model change was required: actual Sonnet implementation resumed.
Revision 691b3b5cc3 is pushed for red CI; static/type, Windows/main packaging, relay and wire checks passed.
Its test shards are still running. A reviewed temporary auxiliary CI workflow formats only task paths,
generates English catalogs with repository tools and runs sequential bounded core/mobile targets. It
returns explicit failure for red tests and uploads only a scoped patch and source/outcome metadata.
The workflow is not a release gate and will be excluded from the final product patch.

| Criterion | Required proof | State |
| --- | --- | --- |
| Modern and legacy catalogs | Exact custom IDs, modern-empty precedence, snake/camel formats, unknown/malformed metadata | Not run |
| Missing Ultrafast | No enabled invented choice, no subscription inference | Not run |
| Migration and persistence | Restore vs toggle origin, explicit precedence, unavailable IDs, model switch, disk | Not run |
| Conversation continuity | Same provider thread/account on resume; no duplicate conversation | Not run |
| Next outgoing request | Picker -> stored option -> exact turn/start serviceTier, mid-turn turn/steer unchanged | Not run |
| Launch refusal | Keep staged prompt/conversation; no first send after tier/capability refusal or invalidation | Not run |
| Model/account/host changes | Generation fencing, pinned-account isolation, catalog refresh invalidation | Not run |
| Old/new peers and SSH | New/old client-host matrix, no false at-rest acceptance, remote host owns catalog/defaults | Not run |
| Other providers | Existing Claude/other selector and launch behavior stays covered | Not run |
| Actionable failures | Definite pre-write rejection, provider rejection, preserved prompt and explicit recovery | Not run |
| Live installed acceptance | Running build identity, installed picker, redacted outgoing tier evidence | Not run |
| Actual Ultrafast execution | Direct per-turn server processing evidence; separately blocked if upstream omits metadata | Not run |

Run targeted Vitest suites, full node/CLI/web typechecks, mobile checks when touched, main/renderer/CLI build,
changed-code quality, formatting and localization checks in the repository CI path on the exact candidate SHA.
Use `ci-base/v1.4.224` for the draft patch PR unless the fork owner assigns a newer mirrored-tag base.
The PR is a CI/review vehicle and must not be merged into that bare-tag CI base.
Capture baseline failures separately; green partial checks do not establish complete candidate verification.

## Release, preservation and rollback

The established fork mechanism is `fork-rebase-patches` -> `fork-assemble-release` -> `fork-release-win-build`.
The fork owner (orca-config-73, routed by the orchestrator formerly c3 and now orca-config-0f) owns patch registration,
base selection, assembly and landing order. The frozen v1.4.224 assembly must not gain a new patch without its order.
Obtain independent local code review at the exact PR head with the mandated reviewer model before release assembly.
Require reviewed assembly CI and Windows package evidence for the exact release artifact, not only the patch branch.

Record the current executable path, loaded version/build SHA and active work before installation. Preserve operational
profile, runtime config and conversations; never auto-start user tasks. Install only the owner-authorized CI package
through the existing Mercurai channel. Distinguish source landed, package installed and process running the new version.
If replacing the active app requires a user restart, report that action without closing active work automatically.
Use the repository-required Electron skill and hidden Playwright CDP checks for picker acceptance; do not use computer-use.
If that skill remains unavailable, route its provisioning through the owner and keep runtime acceptance open.
Verify the installed selector and outgoing request using a bounded authorized turn, not a benchmark.
Preserve secrets and raw transcripts; record only redacted request fields and version/identity evidence.

Rollback: retain the previous verified installer and release identity. The fork owner disables this patch in the manifest,
reassembles, or installs the previous verified Mercurai release. Unpatched older binaries can discard serviceTier;
this implementation cannot change those binaries or claim they preserve Ultrafast intent. Before downgrade, identify
affected conversations and require explicit Standard/advertised Fast compatibility selections, or keep their speed
feature session paused until a capable host returns. Record chosen option IDs and restore instructions only; copy no
raw transcripts or credential-bearing runtime state. Do not automatically downgrade selections or resume paused work.

## Current external gates and sources

`PLAN-REVIEW-CODEX.md` requires GPT-6 Astra at effort ultra, read-only on a clean planning export.
The owner's latest local-execution instruction supersedes the serverone/d2 route for this assignment.
Export only planning files, AGENTS.md, README.md and docs; never load this tree's Codex configuration.
Local reviewer speed_plan_astra approved the corrected plan with no open findings.
Codex fleet delivery remains a printed report path for user relay, not direct Claude messaging.
`BUILD-FREEZE.md` prohibits local builds and typechecks; `TEST-SLOT-ROLLOUT.md` has not admitted local tests.

The [upstream catalog omission report](https://github.com/openai/codex/issues/52839) remains open as inspected.
The [official speed documentation](https://learn.chatgpt.com/docs/agent-configuration/speed) distinguishes speed and usage.
The [app-server documentation](https://learn.chatgpt.com/docs/app-server) supplies the provider interface.
The community workaround was read as context only; no override or instructions were executed.
This session has not freshly queried this account's live catalog and makes no entitlement or actual Ultrafast claim.

Next action: finish the saved regression corrections, then run red CI
before the focused production fixes. Final review, exact-candidate CI and owner rollout remain open.
