---
owner: codex-01a1273e
last-reviewed: 2026-10-14
stability: draft
status: final-verification
---

# Catalog-backed Codex speed selection

## Purpose and current state

Implement catalog-backed Standard, Fast and Ultrafast through the existing picker and catalog.
This document is the authoritative specification, exact ownership map and acceptance checklist.
The user authorized core implementation and rollout, including local implementation/review.
The fleet still owns landing, assembly and release ordering. Local builds/tests remain CI-only.

- Worktree: `C:/Users/svere/orca/worktrees/codex-speed-selection`.
- Branch: `codex/codex-speed-selection`; base `v1.4.224` at `2bb20586ebc39d605e16d95f57420e20a16e7485`.
- Harness: `01a1273e-01d1-7e12-8f0f-99a926abdd95`; draft PR https://github.com/mercurai/orca/pull/42.
- Feature completion commit: `2434a009787fd83c8c06efcce5e612dd09b28207`; current candidate is this branch's HEAD.
- Actual Sonnet 5.5 implements; independent GPT-6.1 medium reviews; Astra ultra approved the plan.

Latest focused CI38671493701 at `e2823f0ace664fddb41b42c9b22a568bf14166ff` passed all
1,090 feature tests: 957 core and 133 mobile, with desktop/mobile production/mobile test types green.
The committed product paths match the effective tested tree, excluding this plan and the temporary
CI workflow. Independent reviewers accepted the loading, refresh, evidence-label and fence corrections.
The focused job is red only because the separate pinned upstream baseline reproduces two Windows
registration failures. Prior full PR CI38662957540 at `11d32212ca` passed static analysis and
all desktop typechecks, mobile web bundle, both package jobs and cross-version wire compatibility.
Three test shards failed: two known Windows registration failures, two stale fixture expectations
(picker accessible name and unresolved Fast in a stalled-catalog concurrency test), and a real
admission-await fence regression. All three additional failures now pass focused CI. Full CI and
independent final verification at the new immutable candidate remain open.
Five exact-head reviews and real Opus integration accepted the prior combined source; acceptance
verification identified the required loading-versus-unknown gap. An Astra-approved completion plan
has shared, desktop, mobile producer and closed-picker tests reviewed before red CI and production.
No final release candidate has passed all gates; the owner has not assigned assembly or a version.
All eight closed-database resume cases and the expanded launch suites passed this focused run.
The separate pinned upstream baseline passed 32 tests and failed two Windows registration checks.
Its three SSH permission tests passed; an unchanged scheduling-dependent PID permission race remains
under owner investigation. Do not claim that race reproduced in the pinned run or was fixed here.
No source landing, released version, package installation or loaded-runtime proof is complete.
Read-only rollout preflight found the installed app.asar package version `1.4.223-mercurai.8`,
matching the latest published Mercurai channel tag. Existing desktop and versioned daemon-host
processes remain active. Disk manifest and executable metadata do not prove the loaded app build;
no profile/config changes, app shutdown or task starts were performed.
Native plugin work remains separate and this lane owns none of its files.

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
Also own `structured-agent-session-adapter.ts` and `structured-agent-session-adapter-router.ts` with
matching tests for the reviewed optional internal `recoverFailedOptionPersistence` hook. Its input is
`{ sessionId, fence, key, value, priorOptions }`; copy prior options before mutation and call only
after a durable options write rejects, before serialization releases. Recovery is atomic in memory,
fence-scoped and fail-closed; no transport or storage work. Preserve the original persistence error
and publish no success. Route to the registered provider without provider-name branches. Codex
restores prior canonical options while retaining blocked requested intent; failed replacement never
clears an earlier block. If recovery cannot establish safe admission, quarantine admission rather
than declaring the child exited. `StructuredAgentSessionSetOptionInput.priorOptions?` may carry the copied durable map to the
provider for complete-map settlement, preserving unrelated saved options without restoring stale
speed/private fields. It is optional internal input; other adapters ignore it. This adds no
public wire field or database schema. Verify provider forwarding cannot leak it into requests.
C also owns the focused type-only `structured-agent-session-option-contract.ts` extraction for the
existing set-option input and named failed-persistence input. Re-export the existing input from
the adapter module so all current imports remain compatible. This path is registered before writes.
Also own `structured-agent-session-option-error.ts`: optional internal complete refusal-state options let
provider-neutral live/at-rest catches persist the block before returning a refusal. Persistence failure
must propagate. This adds no wire field or database schema and never reports the failed choice accepted.
Own focused `structured-agent-session-speed-refusal-persistence.test.ts` for the real generic live
mutation boundary, including refused-state persistence failure and unchanged other-provider errors.
Also own focused `codex-speed-live-persistence.test.ts` and `codex-speed-resume-continuity.test.ts`
for real Codex adapter/generic-boundary coverage of persistence failure and released-lease resume.
Register real journal/store fixtures in the Node project. Refusal-state maps apply only to
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
`components/native-chat/structured-agent-session-message-sender.ts` and its existing test file for
mirrored launch drafts: suppress duplicate composer append, preserve visible refusal/unconfirmed
notices and terminal pending-send cleanup. This bounded ownership is recorded before writes.
Own the existing `structured-agent-session-send-slot.ts` for any essential internal text-ownership
discriminator; preserve external notes' no-notice behavior. D's notice integration may edit L's
`codex-speed-launch-draft-recovery.test.ts` and `structured-agent-session-launch-prompt.ts` in an
exclusive bounded task after L stops, using the real mirrored-launch boundary. No parallel L edits.
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
D extracted `mobile/src/session/use-mobile-structured-agent-option-write.ts` for the 300-line hook
cap before its exact path was authorized. Root inspected and retains that focused extraction,
records it here before further edits, and does not treat the earlier write as compliant.
No further unassigned extraction is permitted; report the required path before touching it.
Focused mobile parent-forwarding coverage may use `mobile-codex-speed-parent-forwarding.test.ts`;
the existing parent controller test is already large. Never make a fixture-only mapping stand in for
the production forwarding path. D may extract `structured-agent-session-option-acknowledgement.ts`
under `src/shared/` if needed to keep explicit-action handling focused without a file-limit exception.
Generated localization catalogs may change only for the new strings using repository localization tooling.
If a launch boundary needs another file, update this ownership map before writing; do not broaden scope silently.
Use existing UI primitives and style tokens. Old-host controls remain selectable; new speed controls require capability.

#### D completion: actual loading phase and retained canonical display

Verification found a requirement gap: pending reads and failed/unknown support currently share a
caption. Complete this presentation behavior without changing admission or provider/wire facts.
The client-only `SessionOptionProbePhase = 'pending' | 'failed' | 'settled'` and
`CodexSpeedPresentationPhases` are exported by `src/shared/codex-speed-facts-presentation.ts`.
Track capability, options-read and catalog/listing phases separately;
overlapping operations cannot clear another pending operation. Undefined preserves older callers.
Freeze the optional `CodexSpeedPresentationPhases` fields as `capabilityPhase`, `optionsPhase`,
and `catalogPhase`; shared option state carries those client-only fields. `codexSpeedLines` accepts
that optional third argument. Existing callers remain valid. A pending phase emits a `loading` line;
failed phases emit `support-unverified` after no phase remains pending. These public presentation
discriminants are client-only. Keep stored/request/evidence
lines independent. Desktop detailed hook names are `useStructuredAgentSessionHostCapabilityProbe`
and `useStructuredAgentSessionHostCodexSpeedProbe`, returning `{ state, phase }`; existing state-only
hooks delegate to the same owner. Mobile feedback uses `agentSessionHostSupportPhase`, forwards
`hostSupportPhase` through the existing lane/session, and passes `codexSpeedHostPhase` to options.
The existing probe's optional callbacks remain positional: failed third, attempt-start fourth.
Only an actual active read/probe/listing wait is pending. Success settles; rejection/timeout clears
pending to failed. Retry backoff is unknown; an actual retry becomes pending again. Existing
session/client/source generations fence phase updates, including joined listing waits and host swaps.

Use existing speed lines, captions, picker rows and style primitives. Loading must be visible while
pending; failures show unverified support and an actionable explanation, not permanent loading.
Before a speed selector exists, expose phase status beside the closed picker without unlocking it.
Use `Loading speed options.` and `Speed options could not be confirmed. Orca will retry when the
host is available.`; rendered tests cover this otherwise unreachable placeholder state.
A saved or held canonical tier stays visible as a disabled canonical row when host support is
unresolved, alongside its stored/requested provenance; it must not appear solely as Fast-off.
Confirmed older hosts retain their supported Fast control and explicit recovery. A retained row
never grants write/launch/send admission. Keep three-state capability admission and wire unchanged;
phase fields are never persisted, sent to the provider, or presented as server processing evidence.
Do not add a refresh button; document automatic refresh and explicit supported replacement.

Register the following exclusive completion assignments before writes; existing B/C/L paths stay
outside this wave. No worker may add an extraction without an exact ownership update.

- **P shared/presentation:** existing `src/shared/structured-agent-session-options.ts`,
  `codex-service-tier-presentation.ts`, `codex-speed-facts-presentation.ts`,
  `native-chat-session-option-snapshot.ts`, and `native-chat-session-options.ts` only for an essential
  additive internal disabled reason; desktop/mobile picker and option-label files already owned by D.
  P owns shared/picker behavioral tests and any new focused
  `src/shared/codex-speed-loading-presentation.test.ts` and desktop
  `components/native-chat/NativeChatSessionOptionPickers.speed-loading.test.tsx`; the existing
  main picker test is at its effective line cap.
- **Q desktop owners:** existing `src/renderer/src/runtime/structured-agent-session-host-capability.ts`,
  `components/native-chat/use-structured-agent-session-options.ts`,
  `use-structured-agent-session-option-state.ts`, `use-host-model-catalog-upgrade.ts`, and
  `use-structured-agent-session-speed-gate.ts` only if existing capability forwarding requires it.
  Preserve the existing state-only hook and add a detailed result from its single probe owner.
  Q owns their existing tests and focused `components/native-chat/codex-speed-loading.test.tsx`.
- **R mobile owners:** existing `mobile/src/transport/runtime-status-probe.ts`,
  `runtime-capability-probe.ts`, and their tests; `mobile/src/session/`
  `use-mobile-session-feedback-capabilities.ts`, `use-mobile-session-tab-reconciliation.ts`,
  `use-mobile-session-native-chat-dictation.ts`, `use-mobile-native-chat-controller.ts`,
  `use-mobile-native-chat-session-lane.ts`, `use-mobile-structured-agent-session.ts`,
  `use-mobile-structured-agent-options.ts`, `use-mobile-host-model-catalog-upgrade.ts`.
  R also owns `use-mobile-structured-agent-option-write.ts` for its accepted-write options refresh.
  Replace that direct read with a typed `onAcceptedOptionRefresh` callback into the existing
  options-read owner, preserving its phase and generation fencing rather than adding another owner.
  If the options owner exceeds its cap, R may move its existing reported-record projection unchanged
  into `mobile/src/session/mobile-structured-agent-option-record.ts`; existing hook tests preserve behavior.
  Forward phase beside support through existing inferred model types. Reuse `onAttemptFailed`,
  with an optional attempt-start callback in the same retry owner; no second probe/cache.
  R owns matching tests, focused `mobile/src/session/mobile-codex-speed-loading.test.ts`, and
  `mobile/src/session/mobile-codex-speed-probe-phase.test.ts` for real feedback/probe producer wiring.

Write behavioral reds through existing public hooks/pickers, not imports of missing future helpers.
Cover pending-to-success/failure, joined-listing failure, retry/backoff, stale-host phases, retained
canonical Ultra while capability is unresolved, and explicit older-host Fast recovery. Keep the
895 previously passing cases. Use CI and independent source review; final exact-head verification
and owner rollout still follow. Root owns generated English/doc updates and CI target admission.

### L: root-owned launch boundary, separate from D

Own focused `codex-speed-launch-draft-recovery.test.ts` for final-probe persistence and idempotent
parked-draft handoff regressions; keep existing large admission suite within its file cap.
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

Full CI38672632436 at `17e57bc282` exposed four lint and twelve naming-rule errors.
Bounded static corrections belong to Q (read identity names and desktop array idiom) and P
(indexOf sentinel idiom). Preserve all read keys, lifecycles and assertions.
For test caps, E registers two pure fixture extractions with their existing test owners:
`src/renderer/src/components/native-chat/structured-agent-session-option-fixtures.ts` and
`mobile/src/session/mobile-structured-agent-option-fixtures.ts`. Move existing catalog constants
and deferred promises unchanged; keep every test case and assertion in its original suite.
The desktop extraction also moves the existing settings-mutation replay into its fixture module
with an explicit typed mutation list. Type the recorder with the existing enqueue function contract
so replay needs no unchecked cast; preserve mutation order and all launch-default assertions.

The real Opus acceptance verifier identified confirmed older hosts receiving unrelated
options/catalog loading or failed speed captions. Independent Q/R review confirmed this MED.
Add red cases to the existing desktop/mobile loading suites for catalog rejection and later-turn
reads on a settled unsupported host. Preserve actual capability-reprobe pending/failed captions.
Then Q/R may suppress only options/catalog speed presentation phases when host support is
`unsupported`, retaining capability phase, read execution, evidence, admission and legacy Fast.
Include support state in memo dependencies. Supported/unknown hosts retain all phases.

Full CI at `11d32212ca` passed static analysis, typechecks, packages and cross-version wire checks.
It exposed three additional test failures besides the two known Windows registration failures.
The existing `structured-agent-session-conversation-stop.test.ts` belongs to C for a bounded
test-fixture correction: stalled catalog concurrency uses explicit Standard, since unresolved
legacy Fast must now block. Preserve steer/Stop/replacement assertions and cover it in focused CI.
P owns the picker test's stale `Effort` accessible-name expectation; the actual label is
`Reasoning effort`. Independent review traced the superseded-fence toast to a real admission-await
regression: recheck `isCurrent()` after `admitSend` before invoking mutation, so an old pick cannot
capture a new fence. Q owns this narrow source correction and the existing regression test
`components/native-chat/use-structured-agent-session.test.tsx`, strengthened with no-write evidence.

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

### Current evidence and open gates

Focused snapshots are intermediate proof; only full exact-candidate CI and independent review
can admit the release patch. Latest run: [CI38671493701](https://github.com/mercurai/orca/actions/runs/38671493701).
Core: 957 passed (957). Mobile: 133 passed (133). Pinned upstream:
32 passed, two failed (34). Scoped formatting/localization patches were inspected and applied.
Independent C/F/L source reviews accepted their corrections; D accepted its final two-file correction.
B/D/P/Q/R reviews accepted the corrections and all focused regressions now pass. Full exact-candidate
CI and final verification remain next. A failed save cannot promise restart durability for intent
never stored. While legacy intent has no existing durable encoding, non-speed writes must refuse
before settlement rather than making the prior canonical tier look like an accepted replacement.

| Criterion | Required proof | Current state |
| --- | --- | --- |
| Catalogs and missing Ultrafast | Modern/legacy exact IDs, empty precedence, unknown metadata; no invented choices | Deterministic focused CI passed |
| Migration, defaults and persistence | Canonical/action precedence; unavailable intent; complete maps and disk | Targeted CI passed, including eight legacy non-speed refusal/recovery cases |
| Conversation continuity | Actual database close/reopen, same thread/account, released lease/new fence | Eight focused resume cases passed |
| Next-turn request and evidence | Exact IDs, mid-turn steer unchanged, submitted/accepted provenance, no processing inference | Deterministic transport/host coverage passed; installed live proof not run |
| Launch and draft recovery | Held receipt, no duplicate session, cancellation/recheck, retained prompt and notices | Expanded launch suites and 18 draft-recovery cases passed |
| Model/account/host changes | Generation fencing, pinned-account isolation, refresh revalidation | Focused fencing, cutover, pinned-account and nondefault host-model recovery cases passed |
| Older peers and other providers | Additive capability gating, legacy actions, local/remote paths, unchanged other controls | Focused simulated-host/transport coverage passed; live SSH acceptance not run |
| Exact product candidate | All required CI, independent final review and Opus verifier | Reviewed completion passed 1,090 focused cases and all type gates; new full CI and final independent verification pending; baseline Windows owner correction remains open |
| Release assembly | Owner registration/version/order, exact assembled artifact CI | Not run; baseline Windows registration correction requires owner |
| Installed acceptance | Actual loaded executable/version, native picker and redacted outgoing request | Not run; repository-required Electron skill unavailable |
| Actual Ultrafast execution | Direct server-reported processing evidence | Not observable through current Codex bridge; upstream metadata separate |

The Windows baseline failures come from three stale package_windows test argv paths in
`.github/workflows/pr.yml`, already present at the pinned upstream revision. Do not suppress the
registration guards. The SSH launch AND-list runs in the background while foreground PID creation
retains the parent umask; its best-effort chmod races that creation. Route both to their established
owner without editing those unassigned paths or treating isolated SSH success as a race resolution.

Run targeted Vitest suites, full node/CLI/web typechecks, mobile checks when touched, main/renderer/CLI build,
changed-code quality, formatting and localization checks in the repository CI path on the exact candidate SHA.
Use `ci-base/v1.4.224` for the draft patch PR unless the fork owner assigns a newer mirrored-tag base.
The PR is a CI/review vehicle and must not be merged into that bare-tag CI base.
Capture baseline failures separately; green partial checks do not establish complete candidate verification.

## Release, preservation and rollback

The established fork mechanism is `fork-rebase-patches` -> `fork-assemble-release` -> `fork-release-win-build`.
Revalidated the canonical [fork release runbook](https://github.com/mercurai/orca/blob/mercurai/config/mercurai/README.md)
and assembly workflow through GitHub API during this session. `release/mercurai` is assembled and
never hand-edited; only the release publish job writes the Mercurai update channel. The branch
remains standalone on the bare upstream tag. Do not invent a version/tag or upload an installer by hand.
The fork owner (orca-config-73, routed by the orchestrator formerly c3 and now orca-config-0f) owns patch registration,
base selection, assembly and landing order. The frozen v1.4.224 assembly must not gain a new patch without its order.
Fresh read-only manifest inspection still shows default-branch base `v1.4.223`, with the partial
orcad template planned; this feature remains standalone on `v1.4.224`. The owner must complete
base/template coordination and assign this patch before assembly, rather than mixing release bases.
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

Latest expanded [CI38670367240](https://github.com/mercurai/orca/actions/runs/38670367240)
at `bc4143c84a` passed 1,088 feature tests and failed the two new mobile accepted-write refresh cases:
core 957 passed, mobile 131 passed / two failed. Desktop, mobile production and mobile test types passed.
The separate pinned baseline passed 32 and failed two Windows registration guards.
The desktop refresh owner, fence guard, retained cross-tier labels and phase-aware fixtures are
independently accepted and their targeted tests now pass. The remaining mobile write helper reads
options outside the phase owner; its success/failure red cases establish that omission. Route its
accepted-write refresh through the existing options-read owner, preserving generation guards and
independent last-request/processing evidence. That correction is written and independently accepted:
the setter requests a refresh only after a current, same-fence acceptance, and the existing effect
supersedes the old read while retaining evidence and send holds. The registered record projection
was moved unchanged to keep the options hook within its 300-line cap. The scoped two-file formatting
artifact was inspected and applied with all writers stopped. Main HEAD stays `11d32212ca`.
Expanded [CI38671493701](https://github.com/mercurai/orca/actions/runs/38671493701)
at `e2823f0ace` passed all 1,090 feature cases: core 957 and mobile 133. Desktop, mobile
production and mobile test types passed. The artifact contains no generated changes. The two
separate pinned Windows registration failures remain the only failures in this focused run.
Commit only the reviewed product tree matching this effective tested snapshot, excluding the
temporary workflow; full exact-product-candidate CI and final independent verification remain open.

Full CI38672632436 now failed static checks; downstream tests and packages were skipped.
Actual Opus integration accepted `17e57bc282` with no HIGH/MED; acceptance identified the older-host
presentation MED above. The next candidate must clear those bounded static and behavioral deltas.

Next action: correct static findings and establish older-host presentation reds in CI.
Final exact-candidate review/CI, owner baseline correction/assembly and native rollout remain open.
