# Commands from plugin panels

Owner: Orca plugin host. Last reviewed: 2026-10-12.

This guide describes the panel command boundary for plugin authors.

Sandboxed plugin panels can invoke their own declared worker commands through
the existing panel message bridge. Panels do not receive network or filesystem
access, and the panel content security policy remains unchanged.

Declare the `commands:invoke` capability in `orca-plugin.json` and request
`commands.invoke` with `{ commandId, args? }`. Arguments must be JSON values.
The host returns `{ value }` containing the worker result, or null when the
handler returns no value. Results must be JSON and fit the 64 KiB panel budget.

The host derives plugin identity from the authenticated panel session. Supplying
a plugin identity in the parameters is invalid. Only worker commands contributed
by that plugin are callable; renderer-owned built-in aliases are rejected.
Existing consent, content verification, worker startup, timeouts, and session
revocation apply. A changed or revoked plugin cannot keep using its old panel.

Command calls require a mutation audit intent before execution. Audit summaries
contain the command identifier only, never argument or result contents.

The host service binding routes to the existing plugin command invoker. A host
without that binding refuses the call. Older Orca versions reject the new
capability or action; plugin installation must follow the core bridge rollout.
Desktop and relay transports use the same schema and capability gate. A client
connected to an older execution host must surface refusal rather than bypass it.

This API exposes only the plugin's own commands. A workflow editor should declare
editing and validation commands without execution commands when workflows must
remain inactive.
